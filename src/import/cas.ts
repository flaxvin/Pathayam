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
import { calendarDate, type IsoDate } from "../core/dates.ts";
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
  /**
   * The balance the statement carries in, when it prints one. A monthly
   * registrar statement opens at what the folio already held, so the R24.3
   * check is opening plus rows, not rows alone.
   */
  openingUnits?: number | null;
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
/**
 * Through `calendarDate`, so "31/02/2026" and "05/13/2026" are no date (and the
 * row is reported unparsed) rather than a lot dated 2026-02-31.
 */
function parseCasDate(raw: string): IsoDate | null {
  const named = /^(\d{1,2})[-/\s]([A-Za-z]{3})[a-z]*[-/\s](\d{4})$/.exec(raw.trim());
  if (named) {
    const month = MONTHS[named[2]!.toLowerCase()];
    if (month) return calendarDate(Number(named[3]), Number(month), Number(named[1]));
  }
  const numeric = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(raw.trim());
  if (numeric) return calendarDate(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]));
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
  // A reversal undoes the row before it — a bounced SIP says "Purchase" too.
  // Not something to create a lot or a sale for: shown, for a person to judge.
  if (/revers|reject/.test(text)) return "other";
  // Order matters: "dividend reinvestment" is a purchase of units, and calling
  // it a dividend would break R27.5's separation of payouts from cost.
  if (/reinvest/.test(text)) return "purchase";
  if (/dividend|idcw|payout/.test(text)) return "dividend";
  // CAMS writes "Switch-Out" / "Switch-In" as often as "Switch Out".
  if (/redem|sell|switch[\s-]*out|swtout/.test(text)) return "redemption";
  if (/purchase|invest|sip|switch[\s-]*in|swtin|allot/.test(text)) return "purchase";
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
  const { schemes: demat, rest } = takeDematHoldings(text.split("\n").map((l) => l.replace(/\s+$/, "")));
  const lines = rest;
  const schemes: CasScheme[] = [...demat];
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

    // "Statement Period: … to …", or KFintech's bare "01/01/2025 to 31/01/2025".
    const periodMatch =
      /statement\s+period\s*:?\s*(.+?)\s+(?:to|-)\s+(.+?)\s*$/i.exec(text) ??
      /^(\d{1,2}[-/][A-Za-z0-9]{2,3}[-/]\d{4})\s+to\s+(\d{1,2}[-/][A-Za-z0-9]{2,3}[-/]\d{4})$/i.exec(text);
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

    // A folio number has a digit in it: CAMS also prints "FOLIO DETAILS".
    const folioMatch = /folio\s*(?:no\.?|number)?\s*:?\s*([\w/\- ]*\d[\w/\- ]*?)\s*$/i.exec(text);
    if (folioMatch) {
      // CAMS repeats the folio line at the top of every page; the same folio
      // again is a page break inside the scheme, not the end of it.
      if (folioMatch[1]!.trim() !== folio) close();
      folio = folioMatch[1]!.trim();
      continue;
    }

    // "ISIN: …", CAMS's "ISIN CODE : …", KFintech's "ISIN No : …".
    const isinMatch = /\bISIN\s*(?:code|no\.?)?\s*:?\s*([A-Z]{2}[A-Z0-9]{9}\d)\b/i.exec(text);
    if (isinMatch) {
      const registrar = /registrar\s*:?\s*([A-Za-z]+)/i.exec(text);
      // CAMS and KFintech print the scheme name on the ISIN's own line,
      // behind a product code ("LD627G") or a "Scheme" label.
      const before = text.slice(0, isinMatch.index)
        .replace(/^\s*scheme\b\s*:?/i, "")
        .replace(/^\s*(?=[A-Z0-9]*\d)[A-Z0-9]{3,8}\s+(?=[A-Za-z])/, "")
        .replace(/[\s\-–:]+$/, "")
        .trim();
      if (/[A-Za-z]{3}/.test(before)) {
        close();
        current = {
          amc, folio, name: before.replace(/\s+/g, " "),
          isin: null, registrar: null, rows: [],
          closingUnits: null, closingValue: null, closingNav: null,
        };
      }
      // Otherwise the ISIN line follows the scheme name, so the scheme was
      // opened by the previous line; attach the identifiers to it.
      if (current) {
        current.isin = isinMatch[1]!.toUpperCase();
        current.registrar = registrar ? registrar[1]!.toUpperCase() : null;
      }
      continue;
    }

    if (current) {
      const opening = /^opening\s+(?:unit\s+)?balance\s*:?\s*\(?([\d,]+\.\d+)\)?$/i.exec(text.replace(/\s{2,}/g, " "));
      if (opening) {
        current.openingUnits = toMilliunits(parseNumber(opening[1]!) ?? 0);
        continue;
      }
      // KFintech: "Balance Units: 145.018  Pledged/Blocked Units: 0.000 …".
      const balanceUnits = /^balance\s+units\s*:?\s*([\d,]+\.\d+)/i.exec(text);
      if (balanceUnits) {
        current.closingUnits = toMilliunits(parseNumber(balanceUnits[1]!) ?? 0);
        continue;
      }
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
  const figures: string[] = [];
  let cut = tokens.length;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const value = parseNumber(tokens[i]!);
    if (value === null) break;
    numbers.unshift(value);
    figures.unshift(tokens[i]!.trim());
    cut = i;
  }

  /*
   * A description can end in a bare number — "SIP Purchase Instalment 3" —
   * which the scan above took as the amount: ₹3 for 1,000 units at ₹10. A
   * leading figure with no decimal point, whose removal lets units × NAV
   * come out at the next figure, belongs to the description.
   */
  if (
    numbers.length > 3 && !figures[0]!.includes(".") &&
    matchedUnitsAndNav(numbers, figures) === null &&
    matchedUnitsAndNav(numbers.slice(1), figures.slice(1)) !== null
  ) {
    numbers.shift();
    figures.shift();
    cut++;
  }

  const description = tokens.slice(0, cut).join(" ").trim();
  if (description === "" || numbers.length < 3) return null;

  // The amount leads; units and NAV follow in an order that depends on the
  // registrar — CDSL prints amount, units, NAV, balance; CAMS prints amount,
  // NAV, price, units, balance. The running balance is the statement's own
  // arithmetic and is not read.
  const amount = numbers[0];
  const [units, nav] = unitsAndNav(numbers, figures);
  if (amount === undefined || units === undefined || nav === undefined) return null;

  const kind = classify(description);
  // A redemption's figures are sometimes bracketed and sometimes not; the word
  // is the authority, not the punctuation.
  // A row of no known kind keeps the sign it was printed with, so a reversal's
  // bracketed units still net against the closing balance.
  const signed = (value: number) =>
    kind === "other" ? value : (kind === "redemption" ? -1 : 1) * Math.abs(value);

  return {
    date,
    kind,
    description,
    amount: toPaise(signed(amount)),
    units: kind === "dividend" ? 0 : toMilliunits(signed(units)),
    nav: toMicroRupees(Math.abs(nav)),
    raw: text,
  };
}

/**
 * Which of a row's figures are the units and which the NAV.
 *
 * Told apart by what they are rather than where they sit: a NAV is printed to
 * four places and units to three, and units × NAV is the amount. The first
 * pair that satisfies both wins; a row that offers none is read in CDSL's
 * order (amount, units, NAV), which is what this parser always assumed.
 */
function unitsAndNav(numbers: number[], figures: string[]): [number | undefined, number | undefined] {
  return matchedUnitsAndNav(numbers, figures) ?? [numbers[1], numbers[2]];
}

/** The units and NAV whose product is the amount, or null when no pair is. */
function matchedUnitsAndNav(numbers: number[], figures: string[]): [number, number] | null {
  const amount = Math.abs(numbers[0] ?? 0);
  const places = (figure: string): number => /\.(\d+)/.exec(figure)?.[1]?.length ?? 0;
  for (let n = 1; n < numbers.length; n++) {
    if (places(figures[n]!) !== 4) continue;
    for (let u = 1; u < numbers.length; u++) {
      if (u === n || places(figures[u]!) !== 3) continue;
      const product = Math.abs(numbers[u]! * numbers[n]!);
      if (Math.abs(product - amount) <= Math.max(1, amount * 0.01)) return [numbers[u]!, numbers[n]!];
    }
  }
  return null;
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
  // A holdings snapshot — CDSL's demat holding statement, a KFintech folio
  // with no activity — has nothing to reconcile its balance against.
  if (scheme.rows.length === 0 && (scheme.openingUnits ?? null) === null) return null;
  const summed = scheme.rows.reduce((total, row) => total + row.units, scheme.openingUnits ?? 0);
  const difference = scheme.closingUnits - summed;
  return difference === 0 ? null : difference;
}

// ---------------------------------------------------------------------------
// CDSL demat holding statement
// ---------------------------------------------------------------------------

const ISIN_ROW = /^\s*(IN[EF][A-Z0-9]{9})\b(.*)$/;

/** Header residue under the "ISIN  Security  Current Bal …" heading. */
const HEADING_WORDS = /^(?:bal|value|face|market|price|pledge|setup|free|frozen|current|security|isin|[\s/(`)₹])+$/i;

/**
 * Pull the "HOLDING STATEMENT AS ON …" tables out of a CDSL CAS.
 *
 * A demat CAS lists what is held, not how it was bought: one row per ISIN with
 * current, frozen, pledged and free balances, a price and a value. The name is
 * wrapped around the ISIN's line — part above, part below, because the cell is
 * vertically centred — so each name fragment goes to the nearest ISIN row,
 * ties to the one above. Lines outside these tables are handed back for the
 * folio parser untouched.
 */
function takeDematHoldings(lines: string[]): { schemes: CasScheme[]; rest: string[] } {
  const schemes: CasScheme[] = [];
  const rest: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/holding\s+statement\s+as\s+on/i.test(lines[i]!)) { rest.push(lines[i]!); continue; }

    let end = i + 1;
    while (end < lines.length && !/portfolio\s+value/i.test(lines[end]!)) end++;
    const block = lines.slice(i + 1, end).map((l) => l.replace(/[^\x20-\x7E₹]+/g, " ").trimEnd());
    schemes.push(...readHoldingBlock(block));
    i = end; // the Portfolio Value line is the table's own total
  }

  return { schemes, rest };
}

function readHoldingBlock(block: string[]): CasScheme[] {
  const rows: { isin: string; figures: string[]; inline: string }[] = [];
  // gaps[k] is the name fragments between row k-1 and row k; the last gap
  // runs from the final row to the end of the table.
  const gaps: string[][] = [[]];

  for (const line of block) {
    const row = ISIN_ROW.exec(line);
    if (row) {
      // Figures from the right; "--" is an empty balance column, and a value
      // run into its price ("45.523037,43,733.22") is kept whole for later.
      const tokens = row[2]!.trim().split(/\s+/);
      const figures: string[] = [];
      while (tokens.length > 0 && /^(?:--|\d[\d,.]*\.\d+)$/.test(tokens[tokens.length - 1]!)) {
        figures.unshift(tokens.pop()!);
      }
      rows.push({ isin: row[1]!, figures, inline: tokens.join(" ") });
      gaps.push([]);
      continue;
    }
    const text = line.trim().replace(/\s+/g, " ");
    if (text === "" || !/[A-Za-z]{2}/.test(text)) continue;
    // Before the first row, only the lines directly above it are its name:
    // the column headings break the run.
    if (HEADING_WORDS.test(text) || (rows.length === 0 && /\b(bal|value|price)\b/i.test(text))) {
      if (rows.length === 0) gaps[0] = [];
      continue;
    }
    gaps[gaps.length - 1]!.push(text);
  }

  /*
   * Split each gap between the row above and the row below. CDSL centres the
   * ISIN in its cell, so a name has as many lines below the row as above it:
   * the row above takes as many of the gap as it had above itself, and the
   * rest open the next name. Nearest-row assignment gets this wrong whenever
   * a long name's first lines sit closer to the previous row.
   */
  const names = rows.map((r) => ({ above: [] as string[], inline: r.inline, below: [] as string[] }));
  if (rows.length > 0) names[0]!.above = gaps[0]!;
  for (let k = 0; k < rows.length; k++) {
    const gap = gaps[k + 1]!;
    if (k === rows.length - 1) { names[k]!.below = gap; break; }
    const share = Math.min(gap.length, names[k]!.above.length);
    names[k]!.below = gap.slice(0, share);
    names[k + 1]!.above = gap.slice(share);
  }

  const out: CasScheme[] = [];
  rows.forEach((r, k) => {
    const held = holdingFigures(r.figures);
    if (!held) return;
    const full = [...names[k]!.above, names[k]!.inline, ...names[k]!.below]
      .filter((t) => t !== "").join(" ").replace(/\s+/g, " ").trim();
    // "HDFC AMC LTD# HDFC MF - HDFC GOLD ETF …": the issuer, then the security.
    // For a share it is "ITC HOTELS LIMITED # EQUITY SHARES": both halves
    // are the name.
    const hash = full.indexOf("#");
    const fund = hash > 0 && r.isin.startsWith("INF");
    const amc = fund ? full.slice(0, hash).trim() : "";
    const name = (fund ? full.slice(hash + 1) : full.replace(/\s*#\s*/g, " ")).trim() || r.isin;
    out.push({
      amc, folio: "CDSL demat", name, isin: r.isin, registrar: "CDSL", rows: [],
      closingUnits: toMilliunits(held.units),
      closingNav: toMicroRupees(held.price),
      closingValue: toPaise(held.value),
    });
  });
  return out;
}

/**
 * Current balance, price and value from a holding row's figures.
 *
 * The price and value columns sit close enough that a wide value runs into
 * the price — "36.25221,30,389.24" — so a jammed pair is split wherever
 * units × price comes out at the value.
 */
function holdingFigures(figures: string[]): { units: number; price: number; value: number } | null {
  const numeric = figures.filter((f) => f !== "--");
  if (numeric.length < 2) return null;
  const units = parseNumber(numeric[0]!);
  if (units === null) return null;

  const agrees = (price: number, value: number): boolean =>
    Math.abs(units * price - value) <= Math.max(1, value * 0.01);

  if (numeric.length >= 4) {
    const price = parseNumber(numeric[numeric.length - 2]!);
    const value = parseNumber(numeric[numeric.length - 1]!);
    if (price !== null && value !== null && agrees(price, value)) return { units, price, value };
  }
  const jammed = numeric[numeric.length - 1]!;
  for (let places = 2; places <= 4; places++) {
    const split = new RegExp(`^(\\d+\\.\\d{${places}})(\\d[\\d,]*\\.\\d{2})$`).exec(jammed);
    if (!split) continue;
    const price = parseNumber(split[1]!);
    const value = parseNumber(split[2]!);
    if (price !== null && value !== null && agrees(price, value)) return { units, price, value };
  }
  return null;
}
