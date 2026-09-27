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
import { calendarDate, fullYear, parseDate, type IsoDate } from "../core/dates.ts";

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
  /**
   * With a single `amount` column: the column that says which way it went —
   * "Dr" / "Cr", "Debit" / "Credit" — when the amount itself is unsigned.
   */
  direction?: number;
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
const TXN_DATE_HINTS = ["txn date", "transaction date", "tran date", "txndate", "transactiondate", "trandate"];
const VALUE_DATE_HINTS = ["value date", "valuedate"];
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

    /*
     * IMPORTS-SCHEDULES-20 · The transaction date, not the value date. An
     * ICICI-style "S No.,Value Date,Transaction Date,…" header took whichever
     * date column came first, so a Swiggy order on 1 Aug valued 31 Jul landed
     * in July's budget. A column that says transaction/txn/tran wins, then any
     * other date column, and a value date only when it is the only one.
     */
    const isValueDate = (i: number) => VALUE_DATE_HINTS.some((h) => cellWords[i]!.includes(` ${h} `));
    const dateColumns = cellWords
      .map((_, i) => i)
      .filter((i) => DATE_HINTS.some((h) => cellWords[i]!.includes(` ${h} `)));
    const date = find(TXN_DATE_HINTS) >= 0 ? find(TXN_DATE_HINTS)
      : dateColumns.find((i) => !isValueDate(i)) ?? dateColumns[0] ?? -1;
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
      /*
       * One column that matched both the debit and the credit hints — "Dr /
       * Cr", "Debit / Credit" — is not a pair: it says which way the unsigned
       * amount beside it went. It used to be dropped, and the amount read as
       * signed, so every "450.00, DR" imported as ₹450 *in* and the guess was
       * saved as the bank's profile for every month after.
       */
      const direction = directionColumn(rows, r, amount, balance);
      if (direction !== null) mapping.direction = direction;
    } else {
      continue; // No usable amount column; keep looking.
    }
    if (balance >= 0) mapping.balance = balance;
    if (reference >= 0) mapping.reference = reference;

    return mapping;
  }

  return null;
}

const DIRECTION_WORD = /^(?:dr|cr|debit|credit|d|c)\.?$/i;

/** Which way a Dr / Cr cell says the money went, or null when it does not say. */
function directionOf(cell: string): "out" | "in" | null {
  const word = cell.trim().toLowerCase().replace(/\.$/, "");
  if (word === "dr" || word === "debit" || word === "d") return "out";
  if (word === "cr" || word === "credit" || word === "c") return "in";
  return null;
}

/**
 * The column saying Dr / Cr for an unsigned amount, found by what it holds
 * rather than its heading ("Dr / Cr", "Type", "Debit/Credit" all occur): every
 * filled cell under it is one of those words. A statement that prints one after
 * the balance too ("Balance, Dr / Cr") has two; that one is the balance's, and
 * the one nearest after the amount is the amount's.
 *
 * Only for an amount column that is unsigned throughout: one that carries its
 * own minus signs or Dr / Cr suffixes already says which way it went.
 */
function directionColumn(
  rows: string[][], headerRow: number, amount: number, balance: number,
): number | null {
  const data = rows.slice(headerRow + 1, headerRow + 41)
    .filter((row) => row.some((c) => c.trim() !== ""));
  const signed = data.some((row) => /^[-−(+]|(?:cr|dr)\.?$/i.test((row[amount] ?? "").trim()));
  if (signed) return null;
  const width = Math.max(0, ...data.map((row) => row.length));
  const found: number[] = [];
  for (let col = 0; col < width; col++) {
    if (col === amount) continue;
    if (balance >= 0 && col === balance + 1 && col !== amount + 1) continue;
    const cells = data.map((row) => (row[col] ?? "").trim()).filter(Boolean);
    if (cells.length > 0 && cells.every((c) => DIRECTION_WORD.test(c))) found.push(col);
  }
  if (found.length === 0) return null;
  const after = found.filter((col) => col > amount);
  if (after.length > 0) return after[0]!;
  return found[found.length - 1]!;
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
  const bare = bareSign(rows, mapping);

  for (let r = mapping.headerRow + 1; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    if (cells.every((c) => c.trim() === "")) continue;

    const rawDate = (cells[mapping.date] ?? "").trim();
    const narration = (cells[mapping.narration] ?? "").trim().replace(/\s+/g, " ");

    // A footer line has no date where a date belongs — but neither does a row
    // whose date this reader cannot parse, and only one of them is safe to
    // skip. See `looksLikeFooter`.
    const date = readDate(rawDate, mapping);
    if (!date) {
      if (looksLikeFooter(cells, rawDate, readAmount(cells, mapping, bare).amount !== null)) continue;
      rowsRead++;
      errors.push({ rowNumber: r + 1, cells, reason: `"${rawDate}" is not a date I can read.` });
      continue;
    }

    rowsRead++;
    const { amount, rawAmount, reason } = readAmount(cells, mapping, bare);
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

/** A figure with nothing on it saying which way it went. */
const BARE_FIGURE = /^(?:Rs\.?|INR|₹)?\s*\d[\d,]*(?:\.\d+)?$/i;
/** A figure marked as money in: "5,000.00 Cr", "+240.00". */
const MARKED_IN = /^\+|(?<![a-z])cr\.?$/i;
/** A figure marked as money out: "450.00 Dr", "-450.00", "(450.00)". */
const MARKED_OUT = /^[-−(]|(?<![a-z])dr\.?$/i;

/**
 * Which way a bare figure goes in a single amount column: 1 in, -1 out.
 *
 * A card's CSV marks the few payments and refunds ("5,000.00 Cr") and leaves
 * the purchases bare, the same convention the PDF reader's rule 4 already
 * follows. Read one figure at a time, every bare purchase was money in — a
 * ₹1,299 purchase credited to the card, no error row, and the guess saved as
 * next month's profile. So the file decides: where some figures are marked as
 * money in and none as money out, the bare ones are the other way. Anything
 * else — minus signs for debits, Dr suffixes, a mixture — keeps a bare figure
 * positive, as before.
 */
function bareSign(rows: string[][], mapping: ColumnMapping): 1 | -1 {
  if (mapping.amount === undefined || mapping.direction !== undefined) return 1;
  if (mapping.debit !== undefined && mapping.credit !== undefined) return 1;
  let markedIn = false;
  for (let r = mapping.headerRow + 1; r < rows.length; r++) {
    const raw = (rows[r]?.[mapping.amount] ?? "").trim();
    if (raw === "" || BARE_FIGURE.test(raw)) continue;
    if (MARKED_OUT.test(raw)) return 1;
    if (MARKED_IN.test(raw)) markedIn = true;
  }
  return markedIn ? -1 : 1;
}

function readAmount(
  cells: string[],
  mapping: ColumnMapping,
  bare: 1 | -1 = 1,
): { amount: Paise | null; rawAmount: string; reason?: string } {
  if (mapping.debit !== undefined && mapping.credit !== undefined) {
    return readDebitCredit(
      (cells[mapping.debit] ?? "").trim(),
      (cells[mapping.credit] ?? "").trim(),
    );
  }

  if (mapping.amount === undefined) {
    return { amount: null, rawAmount: "", reason: "This profile has no amount column." };
  }

  const raw = (cells[mapping.amount] ?? "").trim();
  const amount = parseAmount(raw, "statement");
  if (amount === null) {
    return { amount: null, rawAmount: raw, reason: `"${raw}" is not an amount I can read.` };
  }
  if (mapping.direction !== undefined) {
    // P4: the figure and the word the bank put beside it, both kept.
    const flag = (cells[mapping.direction] ?? "").trim();
    const rawAmount = flag ? `${raw} ${flag}` : raw;
    const way = directionOf(flag);
    if (!way) {
      return {
        amount: null, rawAmount,
        reason: `"${flag}" does not say whether this was money out (Dr) or in (Cr).`,
      };
    }
    if (amount < 0 && way === "in") {
      return {
        amount: null, rawAmount,
        reason: `The amount "${raw}" is money out, but the row says ${flag}; I cannot tell which is right.`,
      };
    }
    return { amount: (way === "out" ? -Math.abs(amount) : Math.abs(amount)) as Paise, rawAmount };
  }
  if (bare === -1 && BARE_FIGURE.test(raw)) return { amount: -Math.abs(amount) as Paise, rawAmount: raw };
  return { amount, rawAmount: raw };
}

/** What banks print in the column a row does not use. */
const EMPTY_CELL = /^(?:|-|–|—)$/;

/**
 * A row from a statement with separate Debit and Credit columns.
 *
 * Exactly one of the two may carry money. This used to take the debit
 * whenever it was non-zero, so "100.00 | 50.00" staged a ₹100 debit and the
 * ₹50 credit vanished; an unreadable debit beside a readable credit was
 * ignored ("abc | 50.00" became a ₹50 credit); and "0.00 | 0.00" was refused
 * as '"0.00" is not an amount I can read', which it plainly is. Each of those
 * is now an error row that says what is actually wrong, because guessing
 * which column the bank meant inverts a transaction.
 */
function readDebitCredit(
  rawDebit: string,
  rawCredit: string,
): { amount: Paise | null; rawAmount: string; reason?: string } {
  const debitEmpty = EMPTY_CELL.test(rawDebit);
  const creditEmpty = EMPTY_CELL.test(rawCredit);
  if (debitEmpty && creditEmpty) {
    return { amount: null, rawAmount: "", reason: "Both the debit and credit columns are empty." };
  }

  const debit = debitEmpty ? null : parseAmount(rawDebit, "statement");
  const credit = creditEmpty ? null : parseAmount(rawCredit, "statement");
  if (!debitEmpty && debit === null) {
    return { amount: null, rawAmount: rawDebit, reason: `The debit "${rawDebit}" is not an amount I can read.` };
  }
  if (!creditEmpty && credit === null) {
    return { amount: null, rawAmount: rawCredit, reason: `The credit "${rawCredit}" is not an amount I can read.` };
  }

  const out = debit !== null && debit !== 0;
  const into = credit !== null && credit !== 0;
  if (out && into) {
    return {
      amount: null,
      rawAmount: `${rawDebit} | ${rawCredit}`,
      reason: `This row has both a debit (${rawDebit}) and a credit (${rawCredit}); I cannot tell which the bank meant.`,
    };
  }
  // Money leaving is negative regardless of how the column is signed.
  if (out) return { amount: -Math.abs(debit!), rawAmount: rawDebit };
  if (into) return { amount: Math.abs(credit!), rawAmount: rawCredit };
  return {
    amount: null,
    rawAmount: rawDebit || rawCredit,
    reason: "Both the debit and credit are zero, so nothing moved on this row.",
  };
}

/**
 * The mapping's date format, then the shared reader.
 *
 * `dateFormat` was stored on the profile and never read. It matters for one
 * shape: "26-08-15" is 15 Aug 2026 to a bank that writes year first, and
 * 26 Aug 2015 to everybody else.
 */
function readDate(raw: string, mapping: ColumnMapping): IsoDate | null {
  if (mapping.dateFormat === "yyyy-mm-dd") {
    const ymd = /^(\d{4}|\d{2})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(raw.trim());
    if (ymd) return calendarDate(fullYear(ymd[1]!), Number(ymd[2]), Number(ymd[3]));
  }
  return parseDate(raw);
}

const FOOTER_MARKERS = [
  "total", "opening balance", "closing balance", "statement", "generated",
  "end of", "page ", "please", "disclaimer", "unless",
];

/**
 * Whether a row with no readable date is a footer, safe to skip.
 *
 * It used to be enough for a marker to appear anywhere in the row, and "*"
 * was a marker — so "15-Jan-2026,SWIGGY*ORDER,450.00", whose date this reader
 * could not then parse, was skipped without a word, and so was any merchant
 * with "total" in its name. Now:
 *
 * - a date cell that itself says "Total", "Opening Balance", "Page 2 of 3" is
 *   a footer;
 * - a date cell holding something else, on a row with a readable amount, is a
 *   transaction whose date could not be read — reported, never dropped;
 * - an empty date cell is a footer when the row has no amount, or when it
 *   carries a marker (",Closing Balance,,50,000.00").
 */
function looksLikeFooter(cells: string[], rawDate: string, hasAmount: boolean): boolean {
  const joined = cells.join(" ").trim().toLowerCase();
  if (joined === "") return true;
  const dateCell = rawDate.toLowerCase() + " ";
  if (FOOTER_MARKERS.some((marker) => dateCell.includes(marker))) return true;
  if (rawDate !== "" && hasAmount) return false;
  if (rawDate === "" && !hasAmount) return true;
  return FOOTER_MARKERS.some((marker) => (joined + " ").includes(marker));
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
