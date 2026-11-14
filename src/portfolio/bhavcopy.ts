/**
 * PRICES-1 · Indian shares and ETFs, priced keylessly from the exchanges' own
 * end-of-day files ("bhavcopy").
 *
 * Mutual funds have always been priced without a key (MFAPI, then AMFI). A
 * listed share needed an Alpha Vantage key, which most households never set,
 * so their shares sat at whatever price was typed in last. NSE and BSE both
 * publish every day's closing prices for every listed security as one public
 * file; this reads those.
 *
 * ## Verified live (13-11-2026, and the missing-day answers on 14-11-2026)
 *
 *   NSE  https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv.zip
 *        200 application/zip, ~209 KB, one deflated entry of the same name
 *        ending .csv (~642 KB, ~3,700 rows). A day with no file answers 404.
 *        It refuses a request with no User-Agent (the stream is reset), and
 *        accepts the generic "Mozilla/5.0".
 *   BSE  https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_YYYYMMDD_F_0000.CSV
 *        200 application/octet-stream, a plain CSV (~880 KB, ~5,100 rows).
 *        A day with no file answers **200 with its HTML home page**, not 404,
 *        so "no file" is recognised by content, never by status alone.
 *
 * Both are the UDiFF layout (since July 2024), with the same header:
 *
 *   TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,
 *   FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,
 *   ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,...
 *
 * e.g. NSE `2026-11-13,...,INE002A01018,RELIANCE,EQ,...,ClsPric 1339.70` and
 * BSE `...,500325,INE002A01018,RELIANCE,A,...,1339.60`. FinInstrmId is NSE's
 * token on NSE and the **scrip code** on BSE; SctySrs is NSE's series (EQ, BE,
 * SM, ST, ...) and BSE's group (A, B, T, X, ...). TradDt is YYYY-MM-DD. Both
 * files were last modified about 16:35 IST on 13-11-2026, which is why the
 * equity refresh waits until 18:00 IST (refresh.ts). The publish time on other
 * days is [unverified].
 *
 * Columns are found by **name** from the header, never by position, and a
 * file whose header lacks the ones used here is a typed failure.
 *
 * ## Being a good citizen (P5, P8)
 *
 * - P8 · Nothing about a holding leaves the server: the request names only a
 *   date, and the whole market's file comes back. No cookie, no key, no
 *   identifying header — a generic User-Agent, because NSE refuses none.
 * - One download per exchange per trading day serves every holding. Parsed
 *   days are kept in memory (at most four), a day with no file is remembered
 *   (for an hour if it is today, for good if it is past), and two lookups
 *   waiting on the same file share one download.
 * - P5 · A ceiling the app enforces itself: at most twelve downloads per
 *   exchange per IST day, however often the Refresh button is pressed. On the
 *   public demo that bounds what visitors can make it ask for.
 * - Files are bounded: 8 MB downloaded, 32 MB unpacked, and the ZIP reader
 *   accepts only stored or deflated entries, unencrypted, single-disk, no
 *   ZIP64, and checks the unpacked size and CRC against what the archive
 *   declares. Anything else is refused, never guessed at.
 */

import { inflateRawSync, crc32 } from "node:zlib";
import type { IsoDate } from "../core/dates.ts";
import { todayIST, addDays } from "../core/dates.ts";
import { price as toMicroRupees } from "./holdings.ts";
import type { FetchOptions, PriceFailure, PriceOutcome, Provider } from "./providers.ts";

export type Exchange = "NSE" | "BSE";

export function bhavcopyUrl(exchange: Exchange, date: IsoDate): string {
  const ymd = date.replaceAll("-", "");
  return exchange === "NSE"
    ? `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${ymd}_F_0000.csv.zip`
    : `https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_${ymd}_F_0000.CSV`;
}

/** P8 · Generic, and the same for every install: nothing names this one. */
export const BHAVCOPY_HEADERS = { "User-Agent": "Mozilla/5.0", Accept: "*/*" } as const;

export const LIMITS = {
  /** What may be downloaded; the real files are well under 1 MB. */
  maxDownloadBytes: 8 * 1024 * 1024,
  /** What a ZIP may unpack to; NSE's is ~0.65 MB. */
  maxUnpackedBytes: 32 * 1024 * 1024,
  /** Rows read from one file; the real ones have ~5,000. */
  maxRows: 200_000,
  /** Entries a ZIP may list; NSE's has one. */
  maxZipEntries: 8,
  /** Calendar days walked back past weekends and holidays (today included: 8 dates). */
  walkBackDays: 7,
  /** P5 · Downloads per exchange per IST day. */
  dailyDownloads: 12,
  /** Parsed days kept in memory, across both exchanges. */
  cachedDays: 4,
  /** How long "today has no file yet" is believed before asking again. */
  missingTodayTtlMs: 60 * 60 * 1000,
} as const;

// ---------------------------------------------------------------------------
// A minimal, bounded ZIP reader
// ---------------------------------------------------------------------------

export class ZipRefused extends Error {}

const u16 = (b: Buffer, o: number) => b.readUInt16LE(o);
const u32 = (b: Buffer, o: number) => b.readUInt32LE(o);

/**
 * The one CSV inside a ZIP, or a ZipRefused naming why not.
 *
 * Reads the central directory (the authoritative list) rather than scanning
 * local headers, takes the compressed size from it, and inflates with a hard
 * output cap so a bomb stops at the cap rather than at the memory limit.
 */
export function readCsvFromZip(zip: Buffer, maxUnpacked: number = LIMITS.maxUnpackedBytes): string {
  // End of central directory: 22 bytes plus a comment of at most 65,535.
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (u32(zip, i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipRefused("not a ZIP archive");

  const disk = u16(zip, eocd + 4);
  const cdDisk = u16(zip, eocd + 6);
  const entriesHere = u16(zip, eocd + 8);
  const entries = u16(zip, eocd + 10);
  const cdSize = u32(zip, eocd + 12);
  const cdOffset = u32(zip, eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || entriesHere !== entries) throw new ZipRefused("multi-disk archive");
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipRefused("ZIP64 archive");
  if (entries === 0 || entries > LIMITS.maxZipEntries) throw new ZipRefused(`archive lists ${entries} entries`);
  if (cdOffset + cdSize > eocd) throw new ZipRefused("central directory out of bounds");

  let p = cdOffset;
  const csvs: { name: string; method: number; flags: number; csize: number; usize: number; crc: number; local: number }[] = [];
  for (let n = 0; n < entries; n++) {
    if (p + 46 > eocd || u32(zip, p) !== 0x02014b50) throw new ZipRefused("damaged central directory");
    const flags = u16(zip, p + 8);
    const method = u16(zip, p + 10);
    const crc = u32(zip, p + 16);
    const csize = u32(zip, p + 20);
    const usize = u32(zip, p + 24);
    const nameLen = u16(zip, p + 28);
    const extraLen = u16(zip, p + 30);
    const commentLen = u16(zip, p + 32);
    const local = u32(zip, p + 42);
    if (p + 46 + nameLen > eocd) throw new ZipRefused("damaged central directory");
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("latin1");
    p += 46 + nameLen + extraLen + commentLen;
    if (/\.csv$/i.test(name)) csvs.push({ name, method, flags, csize, usize, crc, local });
  }
  if (csvs.length !== 1) throw new ZipRefused(`archive holds ${csvs.length} CSV files, not one`);
  const e = csvs[0]!;

  if (e.flags & 0x1) throw new ZipRefused("encrypted entry");
  if (e.method !== 0 && e.method !== 8) throw new ZipRefused(`compression method ${e.method}`);
  if (e.usize > maxUnpacked) throw new ZipRefused(`entry declares ${e.usize} bytes unpacked`);
  if (e.local + 30 > cdOffset || u32(zip, e.local) !== 0x04034b50) throw new ZipRefused("damaged local header");
  const start = e.local + 30 + u16(zip, e.local + 26) + u16(zip, e.local + 28);
  if (start + e.csize > cdOffset) throw new ZipRefused("entry data out of bounds");
  const data = zip.subarray(start, start + e.csize);

  let out: Buffer;
  if (e.method === 0) {
    out = Buffer.from(data);
  } else {
    try {
      // The cap is the declared size, so an entry that lies about it fails
      // here too, not only one that is merely large.
      out = inflateRawSync(data, { maxOutputLength: Math.max(1, e.usize) });
    } catch {
      throw new ZipRefused("entry does not inflate within its declared size");
    }
  }
  if (out.length !== e.usize) throw new ZipRefused("entry size does not match the archive");
  if ((crc32(out) >>> 0) !== e.crc) throw new ZipRefused("entry checksum does not match");
  return out.toString("utf8");
}

// ---------------------------------------------------------------------------
// The CSV
// ---------------------------------------------------------------------------

export interface BhavRow {
  tradeDate: IsoDate;
  isin: string;
  symbol: string;
  series: string;
  /** NSE's token; BSE's scrip code. */
  code: string;
  name: string;
  close: number;
}

export interface BhavDay {
  exchange: Exchange;
  tradeDate: IsoDate;
  byIsin: Map<string, BhavRow[]>;
  bySymbol: Map<string, BhavRow[]>;
  byCode: Map<string, BhavRow>;
  rows: number;
}

/** One line of CSV, quotes honoured; the files use none, but a name might. */
function splitCsv(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const REQUIRED = ["TradDt", "ISIN", "TckrSymb", "SctySrs", "FinInstrmId", "FinInstrmNm", "ClsPric"] as const;

/** Whether text looks like a bhavcopy at all (BSE answers a missing day with HTML). */
export function looksLikeBhavcopy(text: string): boolean {
  return /^﻿?TradDt,/.test(text);
}

/**
 * The day's file, indexed. Null when the header lacks a column this reads, or
 * no row carries a usable date and close: a typed failure upstream, never a
 * guessed column.
 */
export function parseBhavcopy(text: string, exchange: Exchange): BhavDay | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = splitCsv(lines[0] ?? "").map((h) => h.trim());
  const col: Record<string, number> = {};
  for (const name of REQUIRED) {
    const i = header.indexOf(name);
    if (i < 0) return null;
    col[name] = i;
  }

  const day: BhavDay = {
    exchange, tradeDate: "" as IsoDate,
    byIsin: new Map(), bySymbol: new Map(), byCode: new Map(), rows: 0,
  };
  const limit = Math.min(lines.length, LIMITS.maxRows + 1);
  for (let n = 1; n < limit; n++) {
    const line = lines[n]!;
    if (!line.trim()) continue;
    const f = splitCsv(line);
    const tradeDate = (f[col.TradDt!] ?? "").trim();
    const close = Number((f[col.ClsPric!] ?? "").trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || !Number.isFinite(close) || close <= 0) continue;

    const row: BhavRow = {
      tradeDate: tradeDate as IsoDate,
      isin: (f[col.ISIN!] ?? "").trim().toUpperCase(),
      symbol: (f[col.TckrSymb!] ?? "").trim().toUpperCase(),
      series: (f[col.SctySrs!] ?? "").trim().toUpperCase(),
      code: (f[col.FinInstrmId!] ?? "").trim(),
      name: (f[col.FinInstrmNm!] ?? "").trim(),
      close,
    };
    // A file is one trading day; the latest date in it is the day's.
    if (row.tradeDate > day.tradeDate) day.tradeDate = row.tradeDate;
    if (row.isin) push(day.byIsin, row.isin, row);
    if (row.symbol) push(day.bySymbol, row.symbol, row);
    if (row.code && !day.byCode.has(row.code)) day.byCode.set(row.code, row);
    day.rows++;
  }
  return day.rows > 0 ? day : null;
}

function push(map: Map<string, BhavRow[]>, key: string, row: BhavRow): void {
  const list = map.get(key);
  if (list) list.push(row); else map.set(key, [row]);
}

/*
 * NSE's series, most ordinary first: EQ is the rolling market, BE trade-for-
 * trade, BZ the restricted list, SM/ST the SME platform. A symbol can trade
 * in more than one; the ordinary one is the price people mean. Any other
 * series is taken only when it is the only one. BSE's groups do not overlap
 * for one scrip, so they need no ranking.
 */
const SERIES_RANK = ["EQ", "BE", "BZ", "SM", "ST"];
function preferred(rows: BhavRow[]): BhavRow {
  const rank = (r: BhavRow) => {
    const i = SERIES_RANK.indexOf(r.series);
    return i < 0 ? SERIES_RANK.length : i;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b))[0]!;
}

// ---------------------------------------------------------------------------
// What a holding is known by
// ---------------------------------------------------------------------------

export interface Identifier {
  isin: string | null;
  /** An exchange ticker, with the exchange if it was named. */
  symbol: string | null;
  symbolExchange: Exchange | null;
  /** A six-digit BSE scrip code. */
  bseCode: string | null;
}

export const INDIAN_ISIN = /^IN[A-Z0-9]{9}[0-9]$/;

/**
 * Reads what a household types or an import carries: an ISIN, `RELIANCE`,
 * `NSE:RELIANCE`, `RELIANCE.NS`, `RELIANCE.BSE` (Alpha Vantage's form),
 * `500325`, `BSE:500325`.
 */
export function parseIdentifier(isin: string | null | undefined, symbol: string | null | undefined): Identifier {
  const id: Identifier = { isin: null, symbol: null, symbolExchange: null, bseCode: null };
  const i = (isin ?? "").trim().toUpperCase();
  if (INDIAN_ISIN.test(i)) id.isin = i;

  let s = (symbol ?? "").trim().toUpperCase();
  if (!s) return id;
  if (INDIAN_ISIN.test(s)) { id.isin ??= s; return id; }

  let exchange: Exchange | null = null;
  const prefix = /^(NSE|BSE)\s*:\s*(.+)$/.exec(s);
  if (prefix) { exchange = prefix[1] as Exchange; s = prefix[2]!; }
  const suffix = /^(.+)\.(NS|NSE|BO|BSE)$/.exec(s);
  if (suffix) { exchange = suffix[2]!.startsWith("N") ? "NSE" : "BSE"; s = suffix[1]!; }

  if (/^\d{6}$/.test(s)) id.bseCode = s;
  else if (/^[A-Z0-9&\-_.]{1,20}$/.test(s)) { id.symbol = s; id.symbolExchange = exchange; }
  return id;
}

export function canPrice(id: Identifier): boolean {
  return Boolean(id.isin || id.symbol || id.bseCode);
}

/** ISIN first (R24.6: it survives a renamed ticker), then the exchange's own name for it. */
export function findRow(day: BhavDay, id: Identifier): BhavRow | null {
  if (id.isin) {
    const rows = day.byIsin.get(id.isin);
    if (rows?.length) return preferred(rows);
  }
  if (id.bseCode && day.exchange === "BSE") {
    const row = day.byCode.get(id.bseCode);
    if (row) return row;
  }
  if (id.symbol && (id.symbolExchange === null || id.symbolExchange === day.exchange)) {
    const rows = day.bySymbol.get(id.symbol);
    if (rows?.length) return preferred(rows);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fetching, cached
// ---------------------------------------------------------------------------

type DayResult =
  | { kind: "day"; day: BhavDay }
  | { kind: "missing" }
  | { kind: "failed"; reason: PriceFailure["reason"]; message: string };

interface CacheState {
  days: Map<string, BhavDay>; // insertion order is recency
  missing: Map<string, number>; // key -> when learned
  inflight: Map<string, Promise<DayResult>>;
  downloads: Map<string, number>; // `${exchange}|${istDay}` -> count
}

let cache: CacheState = freshCache();
function freshCache(): CacheState {
  return { days: new Map(), missing: new Map(), inflight: new Map(), downloads: new Map() };
}

/** Exposed for tests, and for anything that wants a cold read. */
export function clearBhavcopyCache(): void {
  cache = freshCache();
}

/** Downloads made today per exchange; for tests and the health page. */
export function bhavcopyDownloadsToday(exchange: Exchange, now: Date = new Date()): number {
  return cache.downloads.get(`${exchange}|${todayIST(now)}`) ?? 0;
}

async function readCapped(response: Response, cap: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    return buf.length > cap ? null : buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function download(exchange: Exchange, date: IsoDate, opts: FetchOptions): Promise<DayResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const response = await doFetch(bhavcopyUrl(exchange, date), {
      signal: controller.signal, headers: { ...BHAVCOPY_HEADERS }, redirect: "follow",
    });
    if (response.status === 404) return { kind: "missing" };
    if (response.status === 403 || response.status === 429) {
      return { kind: "failed", reason: "throttled", message: `${exchange} refused the request (HTTP ${response.status}).` };
    }
    if (!response.ok) {
      return { kind: "failed", reason: "unavailable", message: `${exchange} did not answer (HTTP ${response.status}).` };
    }
    // BSE answers a day with no file with its HTML home page and a 200.
    if (/text\/html/i.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel().catch(() => {});
      return { kind: "missing" };
    }
    const bytes = await readCapped(response, LIMITS.maxDownloadBytes);
    if (!bytes) {
      return { kind: "failed", reason: "unparseable", message: `${exchange}'s file was larger than any real bhavcopy; it was not read.` };
    }

    let text: string;
    if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
      try {
        text = readCsvFromZip(bytes);
      } catch (err) {
        const why = err instanceof ZipRefused ? err.message : "unreadable archive";
        return { kind: "failed", reason: "unparseable", message: `${exchange}'s archive was refused: ${why}.` };
      }
    } else {
      text = bytes.toString("utf8");
    }
    if (/^\s*</.test(text)) return { kind: "missing" };
    if (!looksLikeBhavcopy(text)) {
      return { kind: "failed", reason: "unparseable", message: `${exchange} sent something that is not a bhavcopy.` };
    }
    const day = parseBhavcopy(text, exchange);
    if (!day) {
      return { kind: "failed", reason: "unparseable", message: `${exchange}'s bhavcopy lacks a column this reads (ISIN, TckrSymb, ClsPric, TradDt).` };
    }
    return { kind: "day", day };
  } catch {
    return { kind: "failed", reason: "unavailable", message: `${exchange} could not be reached.` };
  } finally {
    clearTimeout(timer);
  }
}

/** One exchange's file for one date, from memory when it can be. */
async function dayFor(exchange: Exchange, date: IsoDate, opts: FetchOptions, now: Date): Promise<DayResult> {
  const key = `${exchange}|${date}`;
  const hit = cache.days.get(key);
  if (hit) {
    cache.days.delete(key);
    cache.days.set(key, hit);
    return { kind: "day", day: hit };
  }
  const missingAt = cache.missing.get(key);
  if (missingAt !== undefined) {
    const today = todayIST(now);
    if (date < today || now.getTime() - missingAt < LIMITS.missingTodayTtlMs) return { kind: "missing" };
    cache.missing.delete(key);
  }
  const pending = cache.inflight.get(key);
  if (pending) return pending;

  const countKey = `${exchange}|${todayIST(now)}`;
  const used = cache.downloads.get(countKey) ?? 0;
  if (used >= LIMITS.dailyDownloads) {
    return {
      kind: "failed", reason: "throttled",
      message: `${exchange}'s file has been downloaded ${used} times today, the most this allows. Prices already fetched are unaffected.`,
    };
  }
  cache.downloads.set(countKey, used + 1);
  // Yesterday's counters are no use; keep the map from growing.
  for (const k of cache.downloads.keys()) if (!k.endsWith(todayIST(now))) cache.downloads.delete(k);

  const promise = download(exchange, date, opts).then((result) => {
    cache.inflight.delete(key);
    if (result.kind === "day") {
      cache.days.set(key, result.day);
      while (cache.days.size > LIMITS.cachedDays) cache.days.delete(cache.days.keys().next().value!);
    } else if (result.kind === "missing") {
      cache.missing.set(key, now.getTime());
      if (cache.missing.size > 64) cache.missing.delete(cache.missing.keys().next().value!);
    }
    return result;
  });
  cache.inflight.set(key, promise);
  return promise;
}

/**
 * The most recent file an exchange has published, walking back over
 * weekends and holidays. Null with a failure when none could be had.
 */
async function latestDay(
  exchange: Exchange, opts: FetchOptions, now: Date,
): Promise<{ day: BhavDay } | { failure: { reason: PriceFailure["reason"]; message: string } }> {
  const today = todayIST(now);
  for (let back = 0; back <= LIMITS.walkBackDays; back++) {
    const result = await dayFor(exchange, addDays(today, -back), opts, now);
    if (result.kind === "day") return { day: result.day };
    if (result.kind === "failed") return { failure: { reason: result.reason, message: result.message } };
  }
  return {
    failure: {
      reason: "unavailable",
      message: `${exchange} has published no bhavcopy in the last ${LIMITS.walkBackDays + 1} days.`,
    },
  };
}

export interface BhavcopyOptions extends FetchOptions {
  now?: Date;
}

/**
 * Price one holding: NSE's latest file first, then BSE's. A holding named
 * for one exchange (`BSE:500325`, `RELIANCE.NS`) still matches the other by
 * ISIN.
 */
export async function priceFromBhavcopy(
  isin: string | null, symbol: string | null, opts: BhavcopyOptions = {},
): Promise<PriceOutcome> {
  const id = parseIdentifier(isin, symbol);
  if (!canPrice(id)) {
    return {
      ok: false, reason: "not-found", source: "bhavcopy",
      message: "No ISIN or exchange symbol to look up; add one, or enter the price by hand.",
    };
  }
  const now = opts.now ?? new Date();
  const order: Exchange[] = id.bseCode && !id.isin && !id.symbol ? ["BSE"]
    : id.symbolExchange && !id.isin ? [id.symbolExchange]
    : ["NSE", "BSE"];

  const failures: string[] = [];
  let worst: PriceFailure["reason"] = "not-found";
  for (const exchange of order) {
    const latest = await latestDay(exchange, opts, now);
    if ("failure" in latest) {
      failures.push(latest.failure.message);
      worst = latest.failure.reason;
      continue;
    }
    const row = findRow(latest.day, id);
    if (!row) {
      failures.push(`${exchange}'s file for ${latest.day.tradeDate} does not list it.`);
      continue;
    }
    return {
      ok: true,
      price: toMicroRupees(row.close),
      currency: "INR",
      // R26.2 · The trading day in the file, never the day it was fetched.
      asOf: row.tradeDate,
      source: "bhavcopy",
      name: row.name,
      isin: row.isin || null,
    };
  }
  // "Not listed anywhere" only when every exchange answered; otherwise the
  // failure that stopped us, so a caller can tell an outage from a typo.
  const allAnswered = failures.every((f) => f.includes("does not list it"));
  return {
    ok: false, source: "bhavcopy",
    reason: allAnswered ? "not-found" : worst,
    message: failures.join(" "),
  };
}

export const bhavcopy: Provider = {
  name: "bhavcopy",
  // Lookups are served from the cached day; the download ceiling above is
  // the real one, per exchange, so a portfolio of thirty shares is not
  // thirty calls.
  dailyCallCeiling: null,
  fetchPrice(symbol, opts = {}) {
    return priceFromBhavcopy(opts.isin ?? null, symbol, opts);
  },
};
