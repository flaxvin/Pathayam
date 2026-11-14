/**
 * PRICES-1 · The bhavcopy provider, against synthetic files built here in the
 * layout verified live on 13-11-2026 (bhavcopy.ts). Nothing touches the
 * network: fetch is stubbed throughout.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, crc32 } from "node:zlib";
import { openDatabase, ensureHousehold, execute, queryAll } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { createAssetAccount, findOrCreateInstrument, recordPurchase, latestPrice } from "../domain/assets.ts";
import {
  readCsvFromZip, ZipRefused, parseBhavcopy, parseIdentifier, findRow, priceFromBhavcopy,
  clearBhavcopyCache, bhavcopyUrl, bhavcopyDownloadsToday, LIMITS, BHAVCOPY_HEADERS,
} from "./bhavcopy.ts";
import { refreshPrices } from "./refresh.ts";

const HEADER =
  "TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt," +
  "StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric," +
  "SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty," +
  "Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4";

function row(date: string, src: string, code: string, isin: string, sym: string, series: string, name: string, close: string) {
  return `${date},${date},CM,${src},STK,${code},${isin},${sym},${series},,,,,${name},1,1,1,${close},${close},1,,${close},,,10,10,1,F1,1,,,,,`;
}

function nseCsv(date: string, extra: string[] = []) {
  return [
    HEADER,
    row(date, "NSE", "2885", "INE002A01018", "RELIANCE", "EQ", "RELIANCE INDUSTRIES LTD", "1339.70"),
    row(date, "NSE", "2886", "INE002A01018", "RELIANCE", "BL", "RELIANCE INDUSTRIES LTD", "1300.00"),
    row(date, "NSE", "10576", "INF204KB14I2", "NIFTYBEES", "EQ", "NIP IND ETF NIFTY BEES", "286.64"),
    row(date, "NSE", "999", "INE000X01011", "ODDCO", "BE", "ODD CO LTD", "12.05"),
    row(date, "NSE", "998", "INE000X01011", "ODDCO", "N1", "ODD CO LTD", "11.00"),
    ...extra,
  ].join("\n") + "\n";
}

function bseCsv(date: string) {
  return [
    HEADER,
    row(date, "BSE", "500325", "INE002A01018", "RELIANCE", "A", "RELIANCE INDUSTRIES LTD.", "1339.60"),
    row(date, "BSE", "543210", "INE999Z01019", "BSEONLY", "X", "BSE ONLY LTD", "45.50"),
  ].join("\n") + "\n";
}

interface ZipEntry {
  name: string;
  data: Buffer;
  method?: 0 | 8 | 12;
  flags?: number;
  /** Lie about the unpacked size or checksum. */
  declaredSize?: number;
  declaredCrc?: number;
}

/** A ZIP, built by hand, so the reader is tested against the format, not itself. */
function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name, "latin1");
    const crc = e.declaredCrc ?? (crc32(e.data) >>> 0);
    const usize = e.declaredSize ?? e.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(usize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function nseZip(date: string, csv = nseCsv(date)) {
  return makeZip([{ name: `BhavCopy_NSE_CM_0_0_0_${date.replaceAll("-", "")}_F_0000.csv`, data: Buffer.from(csv) }]);
}

type Reply = { status?: number; body?: Buffer | string; type?: string; length?: number };

/** A fetch keyed by URL. Unlisted URLs answer as each exchange does for a missing day. */
function exchanges(files: Record<string, Reply>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const reply: Reply = files[url] ?? (url.includes("nseindia")
      ? { status: 404, body: "<html>not found</html>", type: "text/html;charset=UTF-8" }
      // Verified 14-11-2026: BSE answers a day with no file with its home page and 200.
      : { status: 200, body: "<!DOCTYPE html><html>BSE</html>", type: "text/html" });
    const headers = new Headers({ "content-type": reply.type ?? "application/octet-stream" });
    if (reply.length !== undefined) headers.set("content-length", String(reply.length));
    return new Response(reply.body ?? "", { status: reply.status ?? 200, headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const nse = (d: string) => bhavcopyUrl("NSE", d);
const bse = (d: string) => bhavcopyUrl("BSE", d);
/** Monday 16-11-2026, 19:00 IST. */
const MONDAY_EVENING = new Date("2026-11-16T13:30:00Z");

beforeEach(() => clearBhavcopyCache());

describe("PRICES-1 · the URLs and headers verified live", () => {
  test("NSE zipped, BSE plain, both dated YYYYMMDD", () => {
    assert.equal(nse("2026-11-13"),
      "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_20261113_F_0000.csv.zip");
    assert.equal(bse("2026-11-13"),
      "https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_20261113_F_0000.CSV");
  });

  test("P8 · the request names a date and nothing else: a generic User-Agent, no cookie", async () => {
    const { impl, calls } = exchanges({ [nse("2026-11-16")]: { body: nseZip("2026-11-16"), type: "application/zip" } });
    await priceFromBhavcopy("INE002A01018", null, { fetchImpl: impl, now: MONDAY_EVENING });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.headers, { ...BHAVCOPY_HEADERS });
    assert.ok(!calls[0]!.url.includes("INE002A01018"), "the ISIN never leaves");
  });
});

describe("PRICES-1 · the minimal ZIP reader", () => {
  test("reads a deflated entry and a stored one", () => {
    const csv = nseCsv("2026-11-13");
    assert.equal(readCsvFromZip(nseZip("2026-11-13", csv)), csv);
    assert.equal(readCsvFromZip(makeZip([{ name: "a.csv", data: Buffer.from(csv), method: 0 }])), csv);
  });

  test("refuses what it does not read, rather than guessing", () => {
    const data = Buffer.from(nseCsv("2026-11-13"));
    const refused = (zip: Buffer, why: RegExp) =>
      assert.throws(() => readCsvFromZip(zip), (e: unknown) => e instanceof ZipRefused && why.test(e.message));

    refused(Buffer.from("not a zip at all, just text"), /not a ZIP/);
    refused(makeZip([{ name: "a.csv", data, method: 12 }]), /compression method 12/);
    refused(makeZip([{ name: "a.csv", data, flags: 1 }]), /encrypted/);
    refused(makeZip([{ name: "a.csv", data }, { name: "b.csv", data }]), /2 CSV files/);
    refused(makeZip([{ name: "readme.txt", data }]), /0 CSV files/);
    refused(makeZip([{ name: "a.csv", data, declaredCrc: 1234 }]), /checksum/);
    // Truncated: the central directory points past the end.
    const whole = nseZip("2026-11-13");
    refused(Buffer.concat([whole.subarray(0, 40), whole.subarray(whole.length - 22)]), /out of bounds|damaged/);
  });

  test("a zip bomb stops at the cap, whatever it declares", () => {
    // 64 MB of zeros deflates to ~64 KB.
    const bomb = Buffer.alloc(64 * 1024 * 1024);
    // Declared honestly: refused on the declaration alone.
    assert.throws(() => readCsvFromZip(makeZip([{ name: "a.csv", data: bomb }])), /declares/);
    // Declared small: inflation stops at the declared size, not at memory.
    assert.throws(
      () => readCsvFromZip(makeZip([{ name: "a.csv", data: bomb, declaredSize: 1000 }])),
      /does not inflate within its declared size/,
    );
  });
});

describe("PRICES-1 · reading the file", () => {
  test("columns by name; the trade date from the file", () => {
    const day = parseBhavcopy(nseCsv("2026-11-13"), "NSE")!;
    assert.equal(day.tradeDate, "2026-11-13");
    assert.equal(day.rows, 5);
    assert.equal(findRow(day, parseIdentifier("INE002A01018", null))!.close, 1339.70, "EQ over BL");
  });

  test("a header without the columns read is null, not a guess", () => {
    assert.equal(parseBhavcopy("Date,Symbol,Close\n2026-11-13,RELIANCE,1339.70\n", "NSE"), null);
    assert.equal(parseBhavcopy(HEADER + "\n", "NSE"), null, "a header and no rows");
  });

  test("identifiers as households and imports write them", () => {
    assert.deepEqual(parseIdentifier(null, "RELIANCE.NS"), { isin: null, symbol: "RELIANCE", symbolExchange: "NSE", bseCode: null });
    assert.deepEqual(parseIdentifier(null, "RELIANCE.BSE"), { isin: null, symbol: "RELIANCE", symbolExchange: "BSE", bseCode: null });
    assert.deepEqual(parseIdentifier(null, "bse:500325"), { isin: null, symbol: null, symbolExchange: null, bseCode: "500325" });
    assert.deepEqual(parseIdentifier(null, "INF204KB14I2"), { isin: "INF204KB14I2", symbol: null, symbolExchange: null, bseCode: null });
    assert.equal(parseIdentifier("US0378331005", null).isin, null, "a foreign ISIN is not an Indian listing");
  });

  test("series: the ordinary one first, an odd one only when it is all there is", () => {
    const day = parseBhavcopy(nseCsv("2026-11-13"), "NSE")!;
    assert.equal(findRow(day, parseIdentifier(null, "ODDCO"))!.series, "BE");
  });
});

describe("PRICES-1 · pricing a holding", () => {
  test("ISIN match, dated by the file", async () => {
    const { impl } = exchanges({ [nse("2026-11-16")]: { body: nseZip("2026-11-16"), type: "application/zip" } });
    const r = await priceFromBhavcopy("INF204KB14I2", "WHATEVER", { fetchImpl: impl, now: MONDAY_EVENING });
    assert.ok(r.ok);
    assert.equal(r.price, 286_640_000);
    assert.equal(r.asOf, "2026-11-16");
    assert.equal(r.source, "bhavcopy");
    assert.equal(r.currency, "INR");
  });

  test("symbol match, and a BSE scrip code goes to BSE alone", async () => {
    const { impl, calls } = exchanges({
      [nse("2026-11-16")]: { body: nseZip("2026-11-16"), type: "application/zip" },
      [bse("2026-11-16")]: { body: bseCsv("2026-11-16") },
    });
    const sym = await priceFromBhavcopy(null, "RELIANCE", { fetchImpl: impl, now: MONDAY_EVENING });
    assert.ok(sym.ok && sym.price === 1_339_700_000);

    const code = await priceFromBhavcopy(null, "500325", { fetchImpl: impl, now: MONDAY_EVENING });
    assert.ok(code.ok && code.price === 1_339_600_000, "BSE's close, not NSE's");
    assert.equal(calls.length, 2);
  });

  test("not on NSE: BSE's file is read", async () => {
    const { impl } = exchanges({
      [nse("2026-11-16")]: { body: nseZip("2026-11-16"), type: "application/zip" },
      [bse("2026-11-16")]: { body: bseCsv("2026-11-16") },
    });
    const r = await priceFromBhavcopy("INE999Z01019", null, { fetchImpl: impl, now: MONDAY_EVENING });
    assert.ok(r.ok && r.price === 45_500_000);
  });

  test("on neither: not-found, saying which files were read", async () => {
    const { impl } = exchanges({
      [nse("2026-11-16")]: { body: nseZip("2026-11-16"), type: "application/zip" },
      [bse("2026-11-16")]: { body: bseCsv("2026-11-16") },
    });
    const r = await priceFromBhavcopy("INE123A01016", null, { fetchImpl: impl, now: MONDAY_EVENING });
    assert.ok(!r.ok);
    assert.equal(r.reason, "not-found");
    assert.match(r.message, /2026-11-16/);
  });

  test("weekend and holiday: walks back to Friday, and asOf is Friday", async () => {
    // Monday before the files are out, and Friday the last trading day.
    const { impl, calls } = exchanges({
      [nse("2026-11-13")]: { body: nseZip("2026-11-13"), type: "application/zip" },
    });
    const r = await priceFromBhavcopy("INE002A01018", null, { fetchImpl: impl, now: MONDAY_EVENING });
    assert.ok(r.ok);
    assert.equal(r.asOf, "2026-11-13");
    assert.deepEqual(calls.map((c) => c.url), [nse("2026-11-16"), nse("2026-11-15"), nse("2026-11-14"), nse("2026-11-13")]);
  });

  test("BSE's 200-with-HTML is a missing day, not a broken file", async () => {
    const { impl } = exchanges({ [bse("2026-11-13")]: { body: bseCsv("2026-11-13") } });
    const r = await priceFromBhavcopy(null, "BSE:500325", { fetchImpl: impl, now: MONDAY_EVENING });
    assert.ok(r.ok);
    assert.equal(r.asOf, "2026-11-13");
  });

  test("gives up after a week of no files", async () => {
    const { impl, calls } = exchanges({});
    const r = await priceFromBhavcopy(null, "NSE:RELIANCE", { fetchImpl: impl, now: MONDAY_EVENING });
    assert.ok(!r.ok);
    assert.equal(r.reason, "unavailable");
    assert.equal(calls.length, LIMITS.walkBackDays + 1);
  });

  test("403, garbage and an oversized download are typed failures, never throws", async () => {
    const day = "2026-11-16";
    const cases: [Reply, string][] = [
      [{ status: 403, body: "Access Denied" }, "throttled"],
      [{ status: 503, body: "busy" }, "unavailable"],
      [{ body: "this is not a bhavcopy" }, "unparseable"],
      [{ body: Buffer.from("PK\u0003\u0004 truncated garbage"), type: "application/zip" }, "unparseable"],
      [{ body: "x", length: LIMITS.maxDownloadBytes + 1 }, "unparseable"],
      [{ body: Buffer.alloc(LIMITS.maxDownloadBytes + 10, 65) }, "unparseable"],
    ];
    for (const [reply, reason] of cases) {
      clearBhavcopyCache();
      const { impl } = exchanges({ [nse(day)]: reply });
      const r = await priceFromBhavcopy(null, "NSE:RELIANCE", { fetchImpl: impl, now: MONDAY_EVENING });
      assert.ok(!r.ok, `${reply.status ?? 200} ${String(reply.body).slice(0, 20)}`);
      assert.equal(r.reason, reason, r.message);
    }
  });

  test("a zip bomb from the network is refused", async () => {
    const bomb = makeZip([{ name: "a.csv", data: Buffer.alloc(64 * 1024 * 1024), declaredSize: 2000 }]);
    const { impl } = exchanges({ [nse("2026-11-16")]: { body: bomb, type: "application/zip" } });
    const r = await priceFromBhavcopy(null, "NSE:RELIANCE", { fetchImpl: impl, now: MONDAY_EVENING });
    assert.ok(!r.ok);
    assert.equal(r.reason, "unparseable");
    assert.match(r.message, /archive was refused/);
  });

  test("a network error is unavailable, and BSE is still asked", async () => {
    const impl = (async (input: string | URL | Request) => {
      if (String(input).includes("nseindia")) throw new TypeError("fetch failed");
      return new Response(bseCsv("2026-11-16"));
    }) as unknown as typeof fetch;
    const r = await priceFromBhavcopy("INE002A01018", null, { fetchImpl: impl, now: MONDAY_EVENING });
    assert.ok(r.ok && r.price === 1_339_600_000);
  });
});

describe("PRICES-1 · one download serves every holding", () => {
  test("many lookups, one fetch; missing days remembered", async () => {
    const { impl, calls } = exchanges({
      [nse("2026-11-13")]: { body: nseZip("2026-11-13"), type: "application/zip" },
    });
    const opts = { fetchImpl: impl, now: MONDAY_EVENING };
    const results = await Promise.all([
      priceFromBhavcopy("INE002A01018", null, opts),
      priceFromBhavcopy("INF204KB14I2", null, opts),
      priceFromBhavcopy(null, "ODDCO", opts),
    ]);
    assert.ok(results.every((r) => r.ok));
    for (let i = 0; i < 5; i++) await priceFromBhavcopy("INE002A01018", null, opts);
    assert.equal(calls.length, 4, "Mon, Sun, Sat (missing) and Fri, each once");
  });

  test("P5 · a ceiling on downloads per exchange per day, however often asked", async () => {
    // A today with no file yet, asked again every two hours (past the TTL).
    const { impl } = exchanges({
      [nse("2026-11-13")]: { body: nseZip("2026-11-13"), type: "application/zip" },
    });
    // From 00:01 IST on Monday, every 61 minutes, all within the one IST day.
    const start = Date.parse("2026-11-15T18:31:00Z");
    let last;
    for (let h = 0; h < 20; h++) {
      last = await priceFromBhavcopy(null, "NSE:RELIANCE", { fetchImpl: impl, now: new Date(start + h * 61 * 60_000) });
    }
    assert.equal(bhavcopyDownloadsToday("NSE", new Date(start)), LIMITS.dailyDownloads);
    // At the ceiling, Friday's file already in memory still prices it, dated Friday.
    assert.ok(last && last.ok);
    assert.equal(last.asOf, "2026-11-13");

    // With nothing in memory, the ceiling is a typed refusal, not a request.
    clearBhavcopyCache();
    const fresh = exchanges({});
    for (let h = 0; h < 20; h++) {
      last = await priceFromBhavcopy(null, "NSE:RELIANCE", { fetchImpl: fresh.impl, now: new Date(start + h * 61 * 60_000) });
    }
    assert.ok(fresh.calls.length <= LIMITS.dailyDownloads);
    assert.ok(last && !last.ok);
    assert.equal(last.reason, "throttled");
    assert.match(last.message, /downloaded 12 times today/);
  });
});

describe("PRICES-1 · the refresh uses it for Indian shares and ETFs", () => {
  const RAVI = "m-ravi";
  const actor: Actor = { memberId: RAVI, source: "job" };

  function setup() {
    const db = openDatabase({ path: ":memory:", verbose: false });
    ensureHousehold(db);
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
      RAVI, "ravi@example.com", "Ravi", nowIST());
    const account = createAssetAccount(db, actor, { name: "Demat", subtype: "investment", openingDate: "2026-04-01" });
    const hold = (input: Parameters<typeof findOrCreateInstrument>[2]) => {
      const i = findOrCreateInstrument(db, actor, input);
      recordPurchase(db, actor, { accountId: account.id, instrumentId: i.id, tradeDate: "2026-04-05", price: 1_000_000, units: 10_000,
        ...(input.currency && input.currency !== "INR" ? { fxRate: 83 } : {}) });
      return i;
    };
    return { db, hold };
  }

  test("no key needed; one download prices them all; dated by the file", async () => {
    const { db, hold } = setup();
    const rel = hold({ name: "Reliance", kind: "equity", isin: "INE002A01018" });
    const bees = hold({ name: "Nifty BeES", kind: "etf", symbol: "NIFTYBEES" });
    const typed = hold({ name: "Reliance on BSE", kind: "equity", symbol: "RELIANCE.BSE", provider: "alphavantage" });
    const pinned = hold({ name: "Pinned", kind: "equity", isin: "INE000X01011", manualOnly: true });
    const { impl, calls } = exchanges({
      [nse("2026-11-16")]: { body: nseZip("2026-11-16"), type: "application/zip" },
      [bse("2026-11-16")]: { body: bseCsv("2026-11-16") },
    });

    const outcome = await refreshPrices(db, actor, {
      fetchImpl: impl, force: true, sleep: async () => {}, random: () => 0, now: MONDAY_EVENING,
    });
    assert.equal(outcome.updated, 3, outcome.notes.join("; "));
    assert.equal(latestPrice(db, rel.id, "2026-11-16")!.price, 1_339_700_000);
    assert.equal(latestPrice(db, rel.id, "2026-11-16")!.asOf, "2026-11-16");
    assert.equal(latestPrice(db, bees.id, "2026-11-16")!.price, 286_640_000);
    assert.equal(latestPrice(db, typed.id, "2026-11-16")!.price, 1_339_600_000, "named for BSE, priced from BSE");
    assert.equal(latestPrice(db, pinned.id, "2026-11-16"), null, "R26.6 · pinned to manual is never fetched");
    assert.equal(calls.length, 2, "one file per exchange");

    const logged = queryAll<{ provider: string; class: string }>(db, `SELECT provider, class FROM price_fetches`);
    assert.ok(logged.every((l) => l.provider === "bhavcopy" && l.class === "equity"));
    db.close();
  });

  test("BHAVCOPY_PRICES=false: nothing goes to the exchanges", async () => {
    const { db, hold } = setup();
    hold({ name: "Reliance", kind: "equity", isin: "INE002A01018" });
    const { impl, calls } = exchanges({});
    const outcome = await refreshPrices(db, actor, {
      fetchImpl: impl, force: true, sleep: async () => {}, random: () => 0, now: MONDAY_EVENING, bhavcopy: false,
    });
    assert.equal(calls.length, 0);
    assert.equal(outcome.skipped, 1);
    db.close();
  });

  test("a foreign share stays with Alpha Vantage", async () => {
    const { db, hold } = setup();
    hold({ name: "Apple", kind: "equity", symbol: "AAPL", currency: "USD", provider: "alphavantage" });
    const { impl, calls } = exchanges({});
    await refreshPrices(db, actor, { fetchImpl: impl, force: true, sleep: async () => {}, random: () => 0, now: MONDAY_EVENING });
    assert.ok(calls.every((c) => !c.url.includes("nseindia") && !c.url.includes("bseindia")));
    db.close();
  });
});
