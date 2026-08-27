import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryAll, queryOne } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { createAssetAccount, findOrCreateInstrument, recordPurchase, latestPrice } from "../domain/assets.ts";
import { parseAmfiFile, parseAmfiDate, amfi, clearAmfiCache } from "./providers.ts";
import { refreshPrices, isDue, istHour, REFRESH_AFTER_HOUR } from "./refresh.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "job" };
const noSleep = async () => {};

/**
 * Real lines from AMFI's published file, verified 27-08-2026. Two things they
 * carry that a made-up sample would not: the second ISIN column for
 * reinvestment plans, and the AMC heading and blank lines between blocks.
 */
const AMFI_SAMPLE = `Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date

Open Ended Schemes(Children's Fund - Childrens' Fund)

Axis Mutual Fund

135762;INF846K01WO1;-;Axis Children's Fund;Direct Plan;Growth Option;30.4829;27-Aug-2026
135763;INF846K01WS2;INF846K01WQ6;Axis Children's Fund;Direct Plan;IDCW Option;28.1333;27-Aug-2026

HDFC Mutual Fund

119063;INF179K01XQ0;-;HDFC Liquid Fund - Direct Plan;Direct Plan;Growth Option;86.4000;27-Aug-2026
111988;INF109K01CR9;-;ICICI Prudential Corporate Bond Fund;;;10.1065;16-Sep-2022`;

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  const account = createAssetAccount(db, actor, {
    name: "Mutual funds", subtype: "investment", openingDate: "2026-04-01",
  });
  return { db, account };
}

function held(db: ReturnType<typeof setup>["db"], accountId: string, opts: {
  provider?: "mfapi" | "amfi" | "manual"; symbol?: string | null; isin?: string | null;
  manualOnly?: boolean;
} = {}) {
  const instrument = findOrCreateInstrument(db, actor, {
    name: "HDFC Liquid Fund", kind: "mutual-fund",
    provider: opts.provider ?? "mfapi",
    symbol: opts.symbol ?? "119063",
    isin: opts.isin ?? "INF179K01XQ0",
    manualOnly: opts.manualOnly,
  });
  recordPurchase(db, actor, {
    accountId, instrumentId: instrument.id, tradeDate: "2026-04-05",
    price: 80_000_000, units: 312_500,
  });
  return instrument;
}

/** A fetch that answers with whatever the test says, and counts calls. */
function stubFetch(handler: (url: string) => { status?: number; body?: unknown; text?: string }) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const r = handler(url);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => r.text ?? "",
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("10 §3.3 · the AMFI fallback adapter", () => {
  test("parses the real published format", () => {
    const byIsin = parseAmfiFile(AMFI_SAMPLE);

    const hdfc = byIsin.get("INF179K01XQ0");
    assert.ok(hdfc);
    assert.equal(hdfc!.nav, 86_400_000, "micro-rupees, matching the price scale");
    assert.equal(hdfc!.asOf, "2026-08-27");
    assert.match(hdfc!.name, /HDFC Liquid Fund/);

    // Headings, blank lines and the column header are not schemes.
    assert.ok(!byIsin.has("ISIN DIV PAYOUT/ ISIN GROWTH"));
  });

  test("a scheme is findable by either of its two ISINs", () => {
    // Column 2 is growth/payout, column 3 reinvestment, and a holding may
    // carry either — missing this would orphan every reinvestment plan.
    const byIsin = parseAmfiFile(AMFI_SAMPLE);
    assert.equal(byIsin.get("INF846K01WS2")!.nav, byIsin.get("INF846K01WQ6")!.nav);
  });

  test('"-" is not an ISIN', () => {
    assert.equal(parseAmfiFile(AMFI_SAMPLE).has("-"), false);
  });

  test("R26.2 · a stale row keeps its own published date", () => {
    // That ICICI row really is dated 2022 in the live file. Stamping it with
    // today's date would be exactly the lie FW9 exists to prevent.
    assert.equal(parseAmfiFile(AMFI_SAMPLE).get("INF109K01CR9")!.asOf, "2022-09-16");
  });

  test("dates are DD-Mmm-YYYY", () => {
    assert.equal(parseAmfiDate("27-Aug-2026"), "2026-08-27");
    assert.equal(parseAmfiDate("1-Jan-2026"), "2026-01-01");
    assert.equal(parseAmfiDate("2026-08-27"), null);
  });

  test("fetches by ISIN and refuses anything else", async () => {
    clearAmfiCache();
    const { impl } = stubFetch(() => ({ text: AMFI_SAMPLE }));

    const ok = await amfi.fetchPrice("INF179K01XQ0", { fetchImpl: impl });
    assert.equal(ok.ok, true);
    assert.equal(ok.ok && ok.price, 86_400_000);
    assert.equal(ok.ok && ok.asOf, "2026-08-27");

    const bad = await amfi.fetchPrice("119063", { fetchImpl: impl });
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.reason, "unparseable");
  });

  test("the 1.5MB file is fetched once, not once per holding", async () => {
    clearAmfiCache();
    const { impl, calls } = stubFetch(() => ({ text: AMFI_SAMPLE }));

    await amfi.fetchPrice("INF179K01XQ0", { fetchImpl: impl });
    await amfi.fetchPrice("INF846K01WO1", { fetchImpl: impl });
    await amfi.fetchPrice("INF846K01WS2", { fetchImpl: impl });

    assert.equal(calls.length, 1);
  });

  test("an ISIN not in the file is not-found, not a crash", async () => {
    clearAmfiCache();
    const { impl } = stubFetch(() => ({ text: AMFI_SAMPLE }));
    const result = await amfi.fetchPrice("INF000A01AB1", { fetchImpl: impl });
    assert.equal(!result.ok && result.reason, "not-found");
  });

  test("AMFI being down is a typed failure", async () => {
    clearAmfiCache();
    const { impl } = stubFetch(() => ({ status: 503 }));
    const result = await amfi.fetchPrice("INF179K01XQ0", { fetchImpl: impl });
    assert.equal(!result.ok && result.reason, "unavailable");
  });
});

describe("07 P4 · the refresh cadence", () => {
  test("the hours are P4's, in IST", () => {
    assert.equal(REFRESH_AFTER_HOUR["mutual-fund"], 23);
    assert.equal(REFRESH_AFTER_HOUR.fx, 19);
    assert.equal(REFRESH_AFTER_HOUR.manual, null, "R26.6 · manual assets, never");
  });

  test("IST is UTC+5:30", () => {
    assert.equal(istHour(new Date("2026-08-27T17:30:00Z")), 23);
    assert.equal(istHour(new Date("2026-08-27T06:00:00Z")), 11);
  });

  test("a fund is not due before 23:00 IST, however long since the last run", () => {
    // AMFI publishes at end of day. Asking at noon gets yesterday's number,
    // which is the whole reason for the hour.
    const noon = new Date("2026-08-27T06:30:00Z");
    assert.equal(isDue("mutual-fund", null, noon), false);
    assert.equal(isDue("mutual-fund", "2026-08-01", noon), false);
  });

  test("after the hour it is due once, and then not again that day", () => {
    const late = new Date("2026-08-27T17:45:00Z"); // 23:15 IST
    assert.equal(isDue("mutual-fund", null, late), true);
    assert.equal(isDue("mutual-fund", "2026-08-26", late), true);
    // Without this a six-hourly tick would fetch four times an evening.
    assert.equal(isDue("mutual-fund", "2026-08-27", late), false);
  });

  test("a manual asset is never due", () => {
    assert.equal(isDue("manual", null, new Date("2026-08-27T23:00:00Z")), false);
  });
});

describe("07 P4–P9 · refreshing", () => {
  test("updates a held fund and logs the fetch with its price (P3)", async () => {
    const { db, account } = setup();
    const instrument = held(db, account.id);

    const { impl } = stubFetch(() => ({
      body: { status: "SUCCESS", meta: { scheme_name: "HDFC Liquid Fund" },
              data: [{ date: "27-08-2026", nav: "86.40000" }] },
    }));

    const outcome = await refreshPrices(db, actor, {
      fetchImpl: impl, force: true, sleep: noSleep, random: () => 0,
    });

    assert.equal(outcome.updated, 1);
    assert.equal(latestPrice(db, instrument.id)?.price, 86_400_000);

    // P3: "the price returned" — the column that makes a bad number
    // explainable three months later.
    const log = queryOne<{ status: string; price: number; as_of: string; provider: string }>(
      db, `SELECT * FROM price_fetches ORDER BY id DESC LIMIT 1`,
    )!;
    assert.equal(log.status, "ok");
    assert.equal(log.price, 86_400_000);
    assert.equal(log.as_of, "2026-08-27");
    db.close();
  });

  test("R26.6 · an instrument pinned to manual is never fetched", async () => {
    const { db, account } = setup();
    held(db, account.id, { manualOnly: true });

    const { impl, calls } = stubFetch(() => ({ body: {} }));
    const outcome = await refreshPrices(db, actor, {
      fetchImpl: impl, force: true, sleep: noSleep, random: () => 0,
    });

    assert.equal(calls.length, 0);
    assert.equal(outcome.attempted, 0);
    assert.equal(outcome.skipped, 1);
    db.close();
  });

  test("only held instruments are fetched", async () => {
    const { db, account } = setup();
    // Known to the app but not held: fetching it spends a quota a held
    // instrument might need.
    findOrCreateInstrument(db, actor, {
      name: "Sold two years ago", kind: "mutual-fund",
      provider: "mfapi", symbol: "999999", isin: "INF000A01ZZ9",
    });
    held(db, account.id);

    const { impl, calls } = stubFetch(() => ({
      body: { status: "SUCCESS", data: [{ date: "27-08-2026", nav: "86.40" }] },
    }));
    await refreshPrices(db, actor, {
      fetchImpl: impl, force: true, sleep: noSleep, random: () => 0,
    });

    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.includes("119063"));
    db.close();
  });

  test("P8 · only a symbol goes out", async () => {
    const { db, account } = setup();
    held(db, account.id);

    const { impl, calls } = stubFetch(() => ({
      body: { status: "SUCCESS", data: [{ date: "27-08-2026", nav: "86.40" }] },
    }));
    await refreshPrices(db, actor, {
      fetchImpl: impl, force: true, sleep: noSleep, random: () => 0,
    });

    // No units, no cost, no account, no member, nothing identifying anyone.
    for (const url of calls) {
      assert.ok(!/312500|312\.5|ravi|Mutual\+funds/i.test(url), url);
    }
    db.close();
  });

  test("10 §3.3 · MFAPI going down falls through to AMFI on the stored ISIN", async () => {
    clearAmfiCache();
    const { db, account } = setup();
    const instrument = held(db, account.id);

    // MFAPI is a third-party wrapper and can vanish. R24.6's stored ISIN is
    // what makes the swap possible at all.
    const { impl, calls } = stubFetch((url) =>
      url.includes("mfapi") ? { status: 503 } : { text: AMFI_SAMPLE },
    );

    const outcome = await refreshPrices(db, actor, {
      fetchImpl: impl, force: true, sleep: noSleep, random: () => 0,
    });

    assert.equal(outcome.updated, 1);
    assert.equal(latestPrice(db, instrument.id)?.price, 86_400_000);
    assert.equal(latestPrice(db, instrument.id)?.source, "amfi");
    assert.ok(calls.some((c) => c.includes("amfiindia")));
    db.close();
  });

  test("a scheme MFAPI has never heard of is not retried against AMFI", async () => {
    clearAmfiCache();
    const { db, account } = setup();
    held(db, account.id);

    // not-found, not unavailable: AMFI will not know it either, and the second
    // call would only spend a quota to learn the same thing.
    const { impl, calls } = stubFetch((url) =>
      url.includes("mfapi") ? { body: { status: "FAIL" } } : { text: AMFI_SAMPLE },
    );

    await refreshPrices(db, actor, {
      fetchImpl: impl, force: true, sleep: noSleep, random: () => 0,
    });

    assert.ok(!calls.some((c) => c.includes("amfiindia")));
    db.close();
  });

  test("FW9 · a failed fetch leaves the last good price alone", async () => {
    const { db, account } = setup();
    const instrument = held(db, account.id);

    const good = stubFetch(() => ({
      body: { status: "SUCCESS", data: [{ date: "26-08-2026", nav: "86.00" }] },
    }));
    await refreshPrices(db, actor, {
      fetchImpl: good.impl, force: true, sleep: noSleep, random: () => 0,
    });
    assert.equal(latestPrice(db, instrument.id)?.price, 86_000_000);

    clearAmfiCache();
    const bad = stubFetch(() => ({ status: 500 }));
    const outcome = await refreshPrices(db, actor, {
      fetchImpl: bad.impl, force: true, sleep: noSleep, random: () => 0,
    });

    assert.equal(outcome.failed, 1);
    // A stale number the user can see is stale beats a blank where a number
    // should be.
    assert.equal(latestPrice(db, instrument.id)?.price, 86_000_000);
    assert.equal(latestPrice(db, instrument.id)?.asOf, "2026-08-26");
    db.close();
  });

  test("P9 · nothing configured is a normal outcome, not an error", async () => {
    const { db } = setup();
    const outcome = await refreshPrices(db, actor, { force: true, sleep: noSleep });
    assert.equal(outcome.attempted, 0);
    assert.equal(outcome.failed, 0);
    db.close();
  });

  test("without force, nothing is fetched before the hour", async () => {
    const { db, account } = setup();
    held(db, account.id);

    const { impl, calls } = stubFetch(() => ({ body: {} }));
    await refreshPrices(db, actor, {
      fetchImpl: impl, sleep: noSleep, random: () => 0,
      now: new Date("2026-08-27T06:30:00Z"), // noon IST
    });

    assert.equal(calls.length, 0);
    db.close();
  });

  test("P5/P6 · the quota is reported for a provider that has one", async () => {
    const { db, account } = setup();
    held(db, account.id);

    const { impl } = stubFetch(() => ({
      body: { status: "SUCCESS", data: [{ date: "27-08-2026", nav: "86.40" }] },
    }));
    const outcome = await refreshPrices(db, actor, {
      fetchImpl: impl, force: true, sleep: noSleep, random: () => 0,
    });

    const alpha = outcome.quota.find((q) => q.provider === "alphavantage")!;
    assert.equal(alpha.ceiling, 25, "07 §6.4 · the free tier is 25 a day");
    assert.equal(alpha.remaining, 25);

    // MFAPI needs no key and has no documented limit, which is why 09 §6.3
    // makes it primary.
    assert.equal(outcome.quota.find((q) => q.provider === "mfapi")!.ceiling, null);
    db.close();
  });

  test("P5 · a provider at its ceiling is skipped, not throttled into", async () => {
    const { db, account } = setup();
    const instrument = findOrCreateInstrument(db, actor, {
      name: "Some Equity", kind: "equity", provider: "alphavantage", symbol: "RELIANCE.BSE",
    });
    recordPurchase(db, actor, {
      accountId: account.id, instrumentId: instrument.id,
      tradeDate: "2026-04-05", price: 1_000_000, units: 10_000,
    });

    for (let i = 0; i < 25; i++) {
      execute(
        db,
        `INSERT INTO price_fetches (instrument_id, provider, class, requested_at, status)
         VALUES (?,?,?,?,'ok')`,
        instrument.id, "alphavantage", "equity", nowIST(),
      );
    }

    const { impl, calls } = stubFetch(() => ({ body: {} }));
    const outcome = await refreshPrices(db, actor, {
      fetchImpl: impl, force: true, sleep: noSleep, random: () => 0,
      alphaVantageKey: "test-key",
    });

    assert.equal(calls.length, 0, "the app enforces its own ceiling");
    assert.equal(outcome.skipped, 1);
    assert.ok(outcome.notes.some((n) => n.includes("25 calls")));
    db.close();
  });
});
