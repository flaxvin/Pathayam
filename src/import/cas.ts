/**
 * `07` F19.14 · CDSL Consolidated Account Statement import.
 *
 * Promoted from *SHOULD, P3* to **MUST, P1** by Q17 and errata E10: the CAS is
 * the household's primary holdings source. It arrives monthly, covers every
 * folio across every registrar, and hand-entering lots from it was solving a
 * problem a parser solves better.
 *
 * What this module is careful about:
 *
 *   · **It reconciles, it does not duplicate** (`09` §6.2). A CAS covering
 *     April–July re-states transactions the last one already reported. Every
 *     row is matched against what is already held, and only the genuinely new
 *     ones are proposed.
 *   · **It proposes; the review queue decides** (`04` I2). Nothing here writes
 *     a lot. It returns a plan, which a human confirms.
 *   · **R24.3 units, R25.1 lots.** Each purchase row becomes one lot at the
 *     units and price the statement states. Lots are never merged.
 *   · **PR5.** The password is a parameter. It is never stored, logged, or
 *     included in any returned value.
 *
 * The format is not published, so the parsing is deliberately tolerant: a
 * folio block is recognised by its folio line, a scheme by an ISIN, and rows
 * by shape. Anything unrecognised is returned as an unparsed line rather than
 * silently dropped — IL3 forbids swallowing what could not be read.
 */

import { readDocument, expandObjectStreams } from "../pdf/objects.ts";
import { decryptDocument, isEncrypted, WrongPassword } from "../pdf/decrypt.ts";
import { extractText } from "../pdf/text.ts";
import type { IsoDate } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";

export { WrongPassword };

/** One transaction row from the statement. */
export interface CasRow {
  date: IsoDate;
  kind: "purchase" | "redemption" | "dividend" | "other";
  description: string;
  /** Positive for money in, negative for money out, as the statement states. */
  amount: Paise;
  /** R24.3: three decimals, carried as milliunits. Negative on a redemption. */
  units: number;
  /** Micro-rupees, matching the portfolio engine's price scale. */
  nav: number;
  raw: string;
}

export interface CasScheme {
  amc: string;
  folio: string;
  name: string;
  isin: string | null;
  registrar: string | null;
  rows: CasRow[];
  /** What the statement itself says it closes at, for the R24.3 check below. */
  closingUnits: number | null;
  closingValue: Paise | null;
  closingNav: number | null;
}

export interface CasStatement {
  /** As printed. Used only for display — never to date a lot. */
  period: { from: IsoDate; to: IsoDate } | null;
  schemes: CasScheme[];
  /** IL3: lines inside a scheme block that looked like rows but did not parse. */
  unparsed: string[];
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** `05-Apr-2026` and `05/04/2026` both appear, depending on the registrar. */
function parseCasDate(raw: string): IsoDate | null {
  const named = /^(\d{1,2})[-/\s]([A-Za-z]{3})[a-z]*[-/\s](\d{4})$/.exec(raw.trim());
  if (named) {
    const month = MONTHS[named[2]!.toLowerCase()];
    if (month) return `${named[3]}-${month}-${named[1]!.padStart(2, "0")}` as IsoDate;
  }
  const numeric = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(raw.trim());
  if (numeric) {
    return `${numeric[3]}-${numeric[2]!.padStart(2, "0")}-${numeric[1]!.padStart(2, "0")}` as IsoDate;
  }
  return null;
}

/**
 * `1,234.56` and `(1,234.56)` — the parenthesised form is how every registrar
 * writes an outflow, and reading it as positive would invert a redemption.
 */
function parseNumber(raw: string): number | null {
  const text = raw.trim();
  if (text === "" || text === "-") return null;
  const negative = /^\(.*\)$/.test(text) || text.startsWith("-");
  const digits = text.replace(/[(),\s₹-]/g, "").replace(/^INR/i, "");
  if (!/^\d*\.?\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? (negative ? -value : value) : null;
}

function toPaise(value: number): Paise {
  return Math.round(value * 100) as Paise;
}

/** R24.3 · units are stored to three decimals. See errata E13. */
function toMilliunits(value: number): number {
  return Math.round(value * 1000);
}

function toMicroRupees(value: number): number {
  return Math.round(value * 1_000_000);
}

function classify(description: string): CasRow["kind"] {
  const text = description.toLowerCase();
  // Order matters: "dividend reinvestment" is a purchase of units, and calling
  // it a dividend would break R27.5's separation of payouts from cost.
  if (/reinvest/.test(text)) return "purchase";
  if (/dividend|idcw|payout/.test(text)) return "dividend";
  if (/redem|sell|switch\s*out|swtout/.test(text)) return "redemption";
  if (/purchase|invest|sip|switch\s*in|swtin|allot/.test(text)) return "purchase";
  return "other";
}

/**
 * Read a statement from its PDF bytes.
 *
 * `password` is used and discarded (PR5). An unencrypted file ignores it.
 */
export function parseCasPdf(bytes: Uint8Array, password: string): CasStatement {
  const doc = readDocument(bytes);
  if (isEncrypted(doc)) decryptDocument(doc, password);
  expandObjectStreams(doc);
  return parseCasText(extractText(doc));
}

/**
 * The parser proper, over already-extracted text.
 *
 * Split out because it is the part worth testing exhaustively, and because a
 * household that can only get a text export still has a route in.
 */
export function parseCasText(text: string): CasStatement {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  const schemes: CasScheme[] = [];
  const unparsed: string[] = [];

  let period: CasStatement["period"] = null;
  let amc = "";
  let folio = "";
  let current: CasScheme | null = null;

  const close = (): void => {
    if (current && (current.rows.length > 0 || current.closingUnits !== null)) {
      schemes.push(current);
    }
    current = null;
  };

  for (const line of lines) {
    const text = line.trim();
    if (text === "") continue;

    const periodMatch = /statement\s+period\s*:?\s*(.+?)\s+(?:to|-)\s+(.+?)\s*$/i.exec(text);
    if (periodMatch) {
      const from = parseCasDate(periodMatch[1]!);
      const to = parseCasDate(periodMatch[2]!);
      if (from && to) period = { from, to };
      continue;
    }

    // An AMC heading is a line naming an asset manager and nothing else.
    if (/asset management|mutual fund$|amc$/i.test(text) && !/folio/i.test(text)) {
      close();
      amc = text.replace(/\s+/g, " ");
      continue;
    }

    const folioMatch = /folio\s*(?:no\.?|number)?\s*:?\s*([\w/\- ]+?)\s*$/i.exec(text);
    if (folioMatch) {
      close();
      folio = folioMatch[1]!.trim();
      continue;
    }

    const isinMatch = /\bISIN\s*:?\s*([A-Z]{2}[A-Z0-9]{9}\d)\b/i.exec(text);
    if (isinMatch) {
      // The ISIN line follows the scheme name, so the scheme was opened by the
      // previous line; attach the identifiers to it.
      const registrar = /registrar\s*:?\s*([A-Za-z]+)/i.exec(text);
      if (current) {
        current.isin = isinMatch[1]!.toUpperCase();
        current.registrar = registrar ? registrar[1]!.toUpperCase() : null;
      }
      continue;
    }

    // A scheme name: mentions a plan or a fund, and carries no figures.
    if (
      /\b(fund|plan|scheme|growth|idcw|dividend option)\b/i.test(text) &&
      !/^\d/.test(text) &&
      !/closing|market value|total cost|nav on/i.test(text) &&
      parseNumber(text.split(/\s{2,}/).pop() ?? "") === null
    ) {
      close();
      current = {
        amc, folio, name: text.replace(/\s+/g, " "),
        isin: null, registrar: null, rows: [],
        closingUnits: null, closingValue: null, closingNav: null,
      };
      continue;
    }

    if (!current) continue;

    const closingUnits = /closing\s+unit\s+balance\s*:?\s*([\d,.]+)/i.exec(text);
    if (closingUnits) current.closingUnits = toMilliunits(parseNumber(closingUnits[1]!) ?? 0);

    const closingNav = /nav\s+on\s+[\w-]+\s*:?\s*(?:INR|₹)?\s*([\d,.]+)/i.exec(text);
    if (closingNav) current.closingNav = toMicroRupees(parseNumber(closingNav[1]!) ?? 0);

    const marketValue = /market\s+value[^:]*:?\s*(?:INR|₹)?\s*([\d,.]+)/i.exec(text);
    if (marketValue) current.closingValue = toPaise(parseNumber(marketValue[1]!) ?? 0);

    if (closingUnits || closingNav || marketValue) continue;
    if (/^date\b/i.test(text) || /total cost value/i.test(text)) continue;

    const row = parseRow(text);
    if (row) current.rows.push(row);
    else if (/^\d{1,2}[-/]/.test(text)) unparsed.push(text);
  }

  close();
  return { period, schemes, unparsed };
}

/**
 * A transaction row: a date, a description, then three or four figures.
 *
 * Columns are found from the right, because the description is the only field
 * that can contain spaces and it always sits between the date and the numbers.
 */
function parseRow(text: string): CasRow | null {
  const dateMatch = /^(\d{1,2}[-/][A-Za-z0-9]{2,3}[-/]\d{4})\s+(.*)$/.exec(text);
  if (!dateMatch) return null;

  const date = parseCasDate(dateMatch[1]!);
  if (!date) return null;

  const rest = dateMatch[2]!.trim();
  const tokens = rest.split(/\s{2,}|\s(?=[(\d₹])/).filter((t) => t.trim() !== "");

  const numbers: number[] = [];
  let cut = tokens.length;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const value = parseNumber(tokens[i]!);
    if (value === null) break;
    numbers.unshift(value);
    cut = i;
  }

  const description = tokens.slice(0, cut).join(" ").trim();
  if (description === "" || numbers.length < 3) return null;

  // amount, units, nav [, running balance]. The balance is the statement's own
  // arithmetic and is not read — it would only ever confirm what we computed.
  const [amount, units, nav] = numbers;
  if (amount === undefined || units === undefined || nav === undefined) return null;

  const kind = classify(description);
  // A redemption's figures are sometimes bracketed and sometimes not; the word
  // is the authority, not the punctuation.
  const sign = kind === "redemption" ? -1 : 1;

  return {
    date,
    kind,
    description,
    amount: toPaise(sign * Math.abs(amount)),
    units: kind === "dividend" ? 0 : toMilliunits(sign * Math.abs(units)),
    nav: toMicroRupees(Math.abs(nav)),
    raw: text,
  };
}

/**
 * R24.3 check · does the statement's own closing balance agree with its rows?
 *
 * A mismatch means a row was missed, and importing anyway would produce a
 * holding that quietly disagrees with the household's own statement. N9: the
 * discrepancy is reported, never absorbed.
 */
export function unitsDisagreement(scheme: CasScheme): number | null {
  if (scheme.closingUnits === null) return null;
  const summed = scheme.rows.reduce((total, row) => total + row.units, 0);
  const difference = scheme.closingUnits - summed;
  return difference === 0 ? null : difference;
}
