/**
 * IMP-30 · Reading a SafeGold statement.
 *
 * SafeGold sells digital 24-carat gold by the gram. Its monthly statement,
 * mailed from estatements@safegold.in, has three parts: an account summary
 * (the gold held, available and on lease), a transaction summary between an
 * opening and a closing **gold wallet balance**, and the transaction
 * statement itself — one row per movement, with its date and time, what it
 * was, the quantity in grams and the wallet balance after it. A purchase or
 * sale row also says its rate per gram, its amount and, for a purchase, the
 * GST charged on it.
 *
 * It fits the portfolio the way a CAS does (`cas.ts`, `cas-plan.ts`):
 *
 *   · **It proposes; a person confirms** (`04` I2). This file only reads.
 *     `safegold-plan.ts` matches rows against what is already held, and only a
 *     confirmed plan writes a lot or a sale.
 *   · **The closing balance is checked against the rows** (R24.3): opening
 *     plus every row must come to the closing wallet balance, or a row was
 *     missed and the plan says so.
 *   · **Nothing unrecognised is dropped** (IL3): a dated line that does not
 *     read as a row is returned as unparsed.
 *   · **PR5.** The password is a parameter, used and discarded.
 *
 * ## Units: milligrams
 *
 * SafeGold states grams to four decimals, and a ₹10 daily purchase is
 * 0.0008 g. The portfolio stores units to three decimals (R24.3), which as
 * grams would round that purchase to 0.001 g — a quarter more gold than was
 * bought. So the unit of a SafeGold holding is the **milligram**: four
 * decimals of a gram are 0.1 mg, which three decimals hold exactly, and the
 * price per unit is the rate per gram over a thousand (₹12,345.67/g is
 * ₹12.34567/mg, exact in micro-rupees). The instrument's name says so.
 */

import { readDocument, expandObjectStreams } from "../pdf/objects.ts";
import { decryptDocument, isEncrypted, WrongPassword } from "../pdf/decrypt.ts";
import { extractText } from "../pdf/text.ts";
import { calendarDate, monthFromName, type IsoDate } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";

export { WrongPassword };

/** The instrument every SafeGold row is in. Its unit is the milligram. */
export const SAFEGOLD_INSTRUMENT = "SafeGold 24K gold (mg)";

/** One row of the transaction statement. */
export interface SafeGoldRow {
  date: IsoDate;
  /** "HH:MM", 24-hour, when the statement prints one. Part of the row's identity. */
  time: string | null;
  kind: "buy" | "sell" | "other";
  description: string;
  /** Milligrams, to three decimals (milliunits of a milligram). Negative when gold left. */
  units: number;
  /** Micro-rupees per milligram — the rate per gram over 1,000. Null when not printed. */
  price: number | null;
  /** The amount the row states, in paise, as printed (never signed). Null when not printed. */
  amount: Paise | null;
  /** The GST the row states, in paise; zero when none is printed. */
  gst: Paise;
  raw: string;
}

export interface SafeGoldStatement {
  /** As printed. For display only — never to date a lot. */
  period: { from: IsoDate; to: IsoDate } | null;
  /** The opening gold wallet balance, in milliunits of a milligram. */
  openingUnits: number | null;
  /** The closing gold wallet balance, in milliunits of a milligram. */
  closingUnits: number | null;
  rows: SafeGoldRow[];
  /** IL3 · Dated lines in the transaction table that could not be read as a row. */
  unparsed: string[];
}

/** Whether extracted text is a SafeGold statement. */
export function isSafeGoldText(text: string): boolean {
  return /safe\s*gold/i.test(text) && /gold\s+wallet\s+balance/i.test(text);
}

/** Read a statement from its PDF bytes. `password` is used and discarded (PR5). */
export function parseSafeGoldPdf(bytes: Uint8Array, password: string): SafeGoldStatement {
  const doc = readDocument(bytes);
  if (isEncrypted(doc)) decryptDocument(doc, password);
  expandObjectStreams(doc);
  return parseSafeGoldText(extractText(doc));
}

/** Grams as printed ("0.0008") to milliunits of a milligram (800). */
function gramsToUnits(grams: string): number {
  return Math.round(Number(grams.replace(/,/g, "")) * 1_000_000);
}

/** 1.5 g → "1.5000 g". */
export function formatGrams(units: number): string {
  return `${(units / 1_000_000).toFixed(4)} g`;
}

function rupees(text: string): number {
  return Number(text.replace(/,/g, ""));
}

const GRAMS = /([+-]?\d[\d,]*\.\d+)\s*g\b/g;
/** "1st October 2026", "05 Oct 2026", "05-Oct-2026", "05/10/2026". */
const DATE = /(\d{1,2})(?:st|nd|rd|th)?[\s/-]+([A-Za-z]{3,9}|\d{1,2})[\s/,-]+(\d{4})/;
const ROW_START = new RegExp(`^\\s*${DATE.source}`);
const TIME = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/;

function dateOf(match: RegExpExecArray | null): IsoDate | null {
  if (!match) return null;
  const month = /^\d+$/.test(match[2]!) ? Number(match[2]) : monthFromName(match[2]!);
  return month ? calendarDate(Number(match[3]), month, Number(match[1])) : null;
}

function timeOf(text: string): { time: string; length: number } | null {
  const m = TIME.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const pm = m[3]?.toLowerCase() === "pm";
  if (m[3]) hour = (hour % 12) + (pm ? 12 : 0);
  if (hour > 23 || Number(m[2]) > 59) return null;
  return { time: `${String(hour).padStart(2, "0")}:${m[2]}`, length: m[0].length };
}

/**
 * A wallet balance named on its line, or on the line after it: the summary
 * prints "Closing Gold Wallet Balance as of 31st October 2026 : 1.5000 g" on
 * one line, the transaction table wraps the same figure onto the next.
 */
function walletBalance(lines: string[], which: "Opening" | "Closing"): { units: number; date: IsoDate | null } | null {
  const label = new RegExp(`${which}\\s+Gold\\s+Wallet\\s+Balance\\s+as\\s+of`, "i");
  for (let i = 0; i < lines.length; i++) {
    if (!label.test(lines[i]!)) continue;
    const text = `${lines[i]!} ${GRAMS.test(lines[i]!) ? "" : lines[i + 1] ?? ""}`;
    GRAMS.lastIndex = 0;
    const grams = [...text.matchAll(GRAMS)];
    if (grams.length === 0) continue;
    return { units: gramsToUnits(grams[grams.length - 1]![1]!), date: dateOf(DATE.exec(text)) };
  }
  return null;
}

function classify(details: string): SafeGoldRow["kind"] {
  const text = details.toLowerCase();
  if (/\b(?:sold|sell|sale)\b/.test(text)) return "sell";
  if (/\b(?:purchased?|bought|buy)\b/.test(text)) return "buy";
  return "other";
}

/** The first figure after a label, in rupees: "Rate ₹10,000.00/g", "GST: Rs. 29.13". */
function figureAfter(details: string, label: RegExp): number | null {
  const m = new RegExp(`${label.source}[^\\d]{0,12}?(\\d[\\d,]*(?:\\.\\d+)?)`, "i").exec(details);
  return m ? rupees(m[1]!) : null;
}

/** The parser proper, over already-extracted text. */
export function parseSafeGoldText(text: string): SafeGoldStatement {
  const lines = text.replace(/−/g, "-").split("\n").map((l) => l.replace(/\s+$/, ""));

  const opening = walletBalance(lines, "Opening");
  const closing = walletBalance(lines, "Closing");

  const between = /between\s+(.+?)\s+(?:to|and|-)\s+(.+)$/i;
  let period: SafeGoldStatement["period"] = null;
  for (const line of lines) {
    const m = between.exec(line);
    if (!m) continue;
    const from = dateOf(DATE.exec(m[1]!));
    const to = dateOf(DATE.exec(m[2]!));
    if (from && to) { period = { from, to }; break; }
  }
  if (!period && opening?.date && closing?.date) period = { from: opening.date, to: closing.date };

  // The transaction table: below its column headings, above the closing line.
  const head = lines.findIndex((l) => /date\s*&\s*time/i.test(l) && /quantity/i.test(l));
  const rows: SafeGoldRow[] = [];
  const unparsed: string[] = [];
  if (head < 0) return { period, openingUnits: opening?.units ?? null, closingUnits: closing?.units ?? null, rows, unparsed };

  interface Draft { date: IsoDate; time: string | null; parts: string[]; grams: string[]; raw: string[] }
  const drafts: Draft[] = [];
  for (let i = head + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/closing\s+gold\s+wallet\s+balance/i.test(line)) break;
    // A page break repeats the headings and carries a running balance line.
    if (/date\s*&\s*time/i.test(line) || /opening\s+gold\s+wallet\s+balance/i.test(line)) continue;
    if (line.trim() === "" || /no\s+transactions\s+found/i.test(line)) continue;

    const start = ROW_START.exec(line);
    const date = start ? dateOf(start) : null;
    let rest = date ? line.slice(start![0].length) : line;
    const draft: Draft | undefined = date
      ? { date, time: null, parts: [], grams: [], raw: [] }
      : drafts[drafts.length - 1];
    if (!draft) continue; // residue above the first row
    if (date) drafts.push(draft);
    draft.raw.push(line.trim());

    // "10:15 AM" after the date, or alone at the start of the next line.
    const time = timeOf(rest);
    if (time && draft.time === null) { draft.time = time.time; rest = rest.slice(time.length); }

    for (const m of rest.matchAll(GRAMS)) draft.grams.push(m[1]!);
    const words = rest.replace(GRAMS, " ").replace(/\s+/g, " ").trim();
    if (words !== "") draft.parts.push(words);
  }

  let previous = opening?.units ?? null;
  for (const draft of drafts) {
    const raw = draft.raw.join(" | ");
    if (draft.grams.length === 0) { unparsed.push(raw); continue; }
    const details = draft.parts.join(" ");
    const kind = classify(details);
    const printed = draft.grams[0]!;
    const quantity = Math.abs(gramsToUnits(printed));
    const balance = draft.grams.length >= 2 ? gramsToUnits(draft.grams[draft.grams.length - 1]!) : null;

    /*
     * The sign: an explicit one first, then the balance column's movement,
     * then the kind. The table prints a sale's grams unsigned, and only the
     * balance after it says that gold left.
     */
    let units: number;
    if (/^[+-]/.test(printed)) units = printed.startsWith("-") ? -quantity : quantity;
    else if (balance !== null && previous !== null && Math.abs(balance - previous) === quantity) {
      units = balance >= previous ? quantity : -quantity;
    } else if (kind === "sell") units = -quantity;
    else if (kind === "buy") units = quantity;
    else { unparsed.push(raw); continue; }
    if (balance !== null) previous = balance;
    else if (previous !== null) previous += units;

    const rate = figureAfter(details, /(?:rate|@|price)/);
    const amount = figureAfter(details, /(?:amount|total|value)/);
    const gst = figureAfter(details, /\bGST\b/);
    rows.push({
      date: draft.date,
      time: draft.time,
      kind,
      // The words, without the figures read out of them.
      description: details.replace(/\s*(?:rate|@|price|amount|total|value|\(?\s*incl\.?|\bGST\b).*$/i, "").trim() || details,
      units,
      price: rate !== null && rate > 0 ? Math.round(rate * 1000) : null,
      amount: amount !== null ? Math.round(amount * 100) : null,
      gst: gst !== null ? Math.round(gst * 100) : 0,
      raw,
    });
  }

  return { period, openingUnits: opening?.units ?? null, closingUnits: closing?.units ?? null, rows, unparsed };
}

/**
 * R24.3 · The closing wallet balance less what opening plus the rows come to,
 * in milliunits of a milligram; null when they agree or there is nothing to
 * check against. A mismatch means a row was missed (N9: stated, not absorbed).
 */
export function gramsDisagreement(statement: SafeGoldStatement): number | null {
  if (statement.closingUnits === null) return null;
  const summed = statement.rows.reduce((total, row) => total + row.units, statement.openingUnits ?? 0);
  const difference = statement.closingUnits - summed;
  return difference === 0 ? null : difference;
}
