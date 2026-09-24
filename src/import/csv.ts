/**
 * CSV / delimited parsing, and the mapping profiles that turn a bank's columns
 * into raw records (`04` §3.2).
 *
 * The scope guard from `04` §3.3 applies here too: handle what the household's
 * banks actually emit rather than attempting universal CSV. What they emit,
 * per §3.2, is separate debit/credit columns *or* one signed column, amounts
 * with Indian grouping, `Cr`/`Dr` suffixes, trailing balance columns, footer
 * rows, multi-line narration, and a header that is often not row 1.
 *
 * An unrecognised file is a mapping task, not an error (§3.2).
 */

import { parseAmount, type Paise } from "../core/money.ts";
import { parseDate, type IsoDate } from "../core/dates.ts";

/**
 * Parse delimited text into rows, honouring quotes and embedded newlines.
 *
 * A quote opens a quoted field only at the very start of a field (RFC 4180).
 * The old reader opened one anywhere, so a narration like `12" PIZZA` began a
 * quoted field that never closed, and every later row of the file vanished
 * into that one cell — 10 rows in, 5 staged, no error reported.
 *
 * A field that does start with a quote but never closes it is the same trap
 * from the other side: the rest of the file would be one cell. When that
 * happens the quote is taken as a literal character and the text is read
 * again, so every row still arrives and is judged on its own.
 */
export function parseDelimited(text: string, delimiter = ","): string[][] {
  const literal = new Set<number>();
  for (;;) {
    const attempt = parseDelimitedOnce(text, delimiter, literal);
    if (attempt.unclosedQuoteAt === null) return attempt.rows;
    literal.add(attempt.unclosedQuoteAt);
  }
}

function parseDelimitedOnce(
  text: string, delimiter: string, literal: Set<number>,
): { rows: string[][]; unclosedQuoteAt: number | null } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let quoteOpenedAt = -1;
  // True until the current field has taken any character, quote included.
  let atFieldStart = true;
  let i = 0;

  // A BOM survives Excel exports and would otherwise poison the first header.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < text.length) {
    const ch = text[i]!;

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"' && atFieldStart && !literal.has(i)) {
      quoted = true;
      quoteOpenedAt = i;
      atFieldStart = false;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      atFieldStart = true;
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      atFieldStart = true;
      i++;
      continue;
    }

    field += ch;
    i++;
  }

  if (quoted) return { rows, unclosedQuoteAt: quoteOpenedAt };

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return { rows, unclosedQuoteAt: null };
}

/** Guess the delimiter from the first few lines. Some banks emit TSV or `;`. */
export function detectDelimiter(text: string): string {
  const sample = text.split("\n").slice(0, 10).join("\n");
  const counts = [",", "\t", ";", "|"].map(
    (d) => [d, sample.split(d).length - 1] as const,
  );
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ",";
}

// ---------------------------------------------------------------------------
// Mapping profiles
// ---------------------------------------------------------------------------

export interface ColumnMapping {
  /** Zero-based index of the row holding the headers. */
  headerRow: number;
  date: number;
  narration: number;
  /** Either a single signed column… */
  amount?: number;
  /** …or a separate debit and credit pair, which most Indian banks use. */
  debit?: number;
  credit?: number;
  balance?: number;
  reference?: number;
  /** Overrides the two-digit-year guess when a bank is ambiguous. */
  dateFormat?: "dd-mm-yyyy" | "yyyy-mm-dd";
}

export interface ImportProfile {
  name: string;
  /** Auto-detected on later imports by matching this (`04` §3.2). */
  headerSignature: string;
  mapping: ColumnMapping;
}

/** A normalised, unparsed row — the "raw record" of `04` §2. */
export interface RawRecord {
  rowNumber: number;
  date: IsoDate;
  amount: Paise;
  narration: string;
  reference: string | null;
  /** P4 / I1: retained forever, unchanged, alongside the final transaction. */
  raw: { date: string; amount: string; narration: string };
  /**
   * R6.e · The card, when the source already knows it. A card alert names the
   * card by its last four, which the narration (a merchant) does not repeat.
   */
  cardId?: string | null;
}

export interface ParseError {
  rowNumber: number;
  /** IL3: shown with the offending row, never swallowed. */
  cells: string[];
  reason: string;
}

export interface ParseResult {
  records: RawRecord[];
  errors: ParseError[];
  rowsRead: number;
}

/**
 * A stable fingerprint of a file's header row, so a saved profile can be
 * recognised automatically next month (`04` §3.2).
 */
export function headerSignature(headers: string[]): string {
  return headers
    .map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, ""))
    .filter(Boolean)
    .join("|");
}

const DATE_HINTS = ["date", "txn date", "transaction date", "value date", "tran date", "txndate", "transactiondate", "valuedate", "trandate"];
const NARRATION_HINTS = ["narration", "description", "particulars", "remarks", "details", "transaction remarks"];
const DEBIT_HINTS = ["withdrawal", "withdrawals", "debit", "debits", "withdrawal amt", "dr", "withdrawalamt"];
const CREDIT_HINTS = ["deposit", "deposits", "credit", "credits", "deposit amt", "cr", "depositamt"];
const AMOUNT_HINTS = ["amount", "transaction amount", "amt"];
const BALANCE_HINTS = ["balance", "closing balance", "running balance", "closingbalance"];
const REFERENCE_HINTS = ["ref", "reference", "chq", "cheque", "ref no", "chq/ref no", "transaction id", "utr"];

/**
 * Propose a mapping by looking at the headers.
 *
 * A guess, never a decision: the mapping UI shows the raw rows throughout and
 * the user confirms (`04` §3.2). Returns null when no header row is findable,
 * which is a mapping task rather than a failure.
 */
export function guessMapping(rows: string[][]): ColumnMapping | null {
  // The header is often not row 1 — statements carry account details above it.
  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const cells = (rows[r] ?? []).map((c) => c.trim().toLowerCase());
    if (cells.filter(Boolean).length < 3) continue;

    /*
     * Hints match whole words, not substrings. "Description" contains "cr",
     * so a Date,Description,Debit,Credit file had its narration column taken
     * as the Credit column — every deposit read from the narration, refused,
     * and the wrong mapping then saved as the bank's profile. "Chq./Ref.No."
     * still finds "ref", because punctuation separates words.
     */
    const cellWords = cells.map((c) => ` ${c.split(/[^a-z0-9]+/).filter(Boolean).join(" ")} `);
    const find = (hints: string[]): number =>
      cellWords.findIndex((words) => hints.some((h) => words.includes(` ${h} `)));

    const date = find(DATE_HINTS);
    const narration = find(NARRATION_HINTS);
    if (date < 0 || narration < 0) continue;

    const debit = find(DEBIT_HINTS);
    const credit = find(CREDIT_HINTS);
    const amount = find(AMOUNT_HINTS);
    const balance = find(BALANCE_HINTS);
    const reference = find(REFERENCE_HINTS);

    const mapping: ColumnMapping = { headerRow: r, date, narration };
    if (debit >= 0 && credit >= 0 && debit !== credit) {
      mapping.debit = debit;
      mapping.credit = credit;
    } else if (amount >= 0) {
      mapping.amount = amount;
    } else {
      continue; // No usable amount column; keep looking.
    }
    if (balance >= 0) mapping.balance = balance;
    if (reference >= 0) mapping.reference = reference;

    return mapping;
  }

  return null;
}

/**
 * Apply a mapping to parsed rows.
 *
 * Footer rows — totals, disclaimers, blank separators — are skipped rather
 * than reported as errors, because every Indian bank statement has them and
 * an error per footer line would bury the real problems.
 */
export function applyMapping(rows: string[][], mapping: ColumnMapping): ParseResult {
  const records: RawRecord[] = [];
  const errors: ParseError[] = [];
  let rowsRead = 0;

  for (let r = mapping.headerRow + 1; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    if (cells.every((c) => c.trim() === "")) continue;

    const rawDate = (cells[mapping.date] ?? "").trim();
    const narration = (cells[mapping.narration] ?? "").trim().replace(/\s+/g, " ");

    // A footer line has no date where a date belongs.
    const date = parseDate(rawDate);
    if (!date) {
      if (looksLikeFooter(cells)) continue;
      rowsRead++;
      errors.push({ rowNumber: r + 1, cells, reason: `"${rawDate}" is not a date I can read.` });
      continue;
    }

    rowsRead++;
    const { amount, rawAmount, reason } = readAmount(cells, mapping);
    if (amount === null) {
      errors.push({ rowNumber: r + 1, cells, reason: reason ?? "No amount on this row." });
      continue;
    }

    records.push({
      rowNumber: r + 1,
      date,
      amount,
      narration,
      reference: mapping.reference !== undefined ? (cells[mapping.reference] ?? "").trim() || null : null,
      raw: { date: rawDate, amount: rawAmount, narration },
    });
  }

  return { records, errors, rowsRead };
}

function readAmount(
  cells: string[],
  mapping: ColumnMapping,
): { amount: Paise | null; rawAmount: string; reason?: string } {
  if (mapping.debit !== undefined && mapping.credit !== undefined) {
    const rawDebit = (cells[mapping.debit] ?? "").trim();
    const rawCredit = (cells[mapping.credit] ?? "").trim();
    const debit = rawDebit ? parseAmount(rawDebit, "statement") : null;
    const credit = rawCredit ? parseAmount(rawCredit, "statement") : null;

    if (debit !== null && debit !== 0) {
      // Money leaving is negative regardless of how the column is signed.
      return { amount: -Math.abs(debit), rawAmount: rawDebit };
    }
    if (credit !== null && credit !== 0) {
      return { amount: Math.abs(credit), rawAmount: rawCredit };
    }
    if (rawDebit === "" && rawCredit === "") {
      return { amount: null, rawAmount: "", reason: "Both the debit and credit columns are empty." };
    }
    return {
      amount: null,
      rawAmount: rawDebit || rawCredit,
      reason: `"${rawDebit || rawCredit}" is not an amount I can read.`,
    };
  }

  if (mapping.amount === undefined) {
    return { amount: null, rawAmount: "", reason: "This profile has no amount column." };
  }

  const raw = (cells[mapping.amount] ?? "").trim();
  const amount = parseAmount(raw, "statement");
  if (amount === null) {
    return { amount: null, rawAmount: raw, reason: `"${raw}" is not an amount I can read.` };
  }
  return { amount, rawAmount: raw };
}

function looksLikeFooter(cells: string[]): boolean {
  const joined = cells.join(" ").toLowerCase();
  if (joined.trim() === "") return true;
  return [
    "total", "opening balance", "closing balance", "statement", "generated",
    "computer generated", "end of", "please", "disclaimer", "*", "unless",
  ].some((marker) => joined.includes(marker));
}

/** Parse a file end to end with a known or guessed mapping. */
export function parseStatement(
  text: string,
  profile?: ColumnMapping,
): { result: ParseResult; mapping: ColumnMapping | null; headers: string[] } {
  const rows = parseDelimited(text, detectDelimiter(text));
  const mapping = profile ?? guessMapping(rows);
  if (!mapping) {
    return { result: { records: [], errors: [], rowsRead: 0 }, mapping: null, headers: rows[0] ?? [] };
  }
  return {
    result: applyMapping(rows, mapping),
    mapping,
    headers: rows[mapping.headerRow] ?? [],
  };
}
