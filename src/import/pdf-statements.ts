/**
 * `04` §3.3 · PDF statement parsing for HDFC, ICICI, Axis and SBI.
 *
 * The PDF reader already exists (`src/pdf/`, built for the CAS). This is the
 * layer above it: recognise which bank produced a statement, and pull
 * transaction rows out of its particular table.
 *
 * Every parser here produces the same `RawRecord[]` the CSV parser produces, so
 * everything downstream — dedupe, rules, the review queue, the auto-approve
 * gate — is untouched. That is `04` §1's whole point: *"adding email or SMS
 * parsing later changes nothing downstream, because they produce the same raw
 * records and land in the same review queue."* A PDF is just another source.
 *
 * ---
 *
 * **On how these layouts were determined.** [unverified against a live file]
 *
 * Every statement this household receives is password-protected — Axis wants
 * the first four letters of the name plus DDMM of birth, ICICI wants lowercase
 * personal details, the brokers want a PAN — and those passwords are exactly
 * what PR5 says never to store and what nobody should be handing to a build
 * process. So the column layouts below are written from the banks' published
 * statement formats rather than from opening this household's own files, and
 * the fixtures in the test suite are synthetic.
 *
 * The consequence is stated rather than hidden: **a real statement may not
 * match on the first try.** Two things make that survivable rather than
 * annoying —
 *
 *   1. `detectBank` returning null is not an error. The extracted text goes to
 *      the same mapping UI an unrecognised CSV goes to (`04` §3.2), so the
 *      household names the columns once and the profile is saved.
 *   2. Every parser is a small table of regexes with its own test. Correcting
 *      one against a real file is a one-line change, not a rewrite.
 *
 * Verify each against a real statement before trusting it, per the doc set's
 * own convention for unverified surfaces.
 */

import type { IsoDate } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";
import type { RawRecord, ParseError, ParseResult } from "./csv.ts";
import { readDocument, expandObjectStreams } from "../pdf/objects.ts";
import { decryptDocument, isEncrypted, WrongPassword } from "../pdf/decrypt.ts";
import { extractText } from "../pdf/text.ts";

export { WrongPassword };

export type BankId = "hdfc" | "icici" | "axis" | "sbi";

export interface BankProfile {
  id: BankId;
  name: string;
  /**
   * What the household will actually be typing into the password box. Taken
   * from the banks' own emails, because "it is usually your PAN" is the
   * difference between an import that works and one that is abandoned.
   */
  passwordHint: string;
  /** Phrases that identify the producer. All must be absent to rule it out. */
  signatures: RegExp[];
}

export const BANKS: BankProfile[] = [
  {
    id: "hdfc",
    name: "HDFC Bank",
    passwordHint:
      "Usually your customer ID, or the first four letters of your name in " +
      "capitals followed by your date of birth as DDMM.",
    signatures: [/HDFC\s*BANK/i, /hdfcbank\.com/i],
  },
  {
    id: "icici",
    name: "ICICI Bank",
    passwordHint:
      "All letters in lower case, no spaces or salutation — usually the first " +
      "four letters of your name followed by your date of birth as DDMM.",
    signatures: [/ICICI\s*Bank/i, /icicibank\.com/i],
  },
  {
    id: "axis",
    name: "Axis Bank",
    passwordHint:
      "The first four letters of your name in lower case, followed by your " +
      "date and month of birth as DDMM. No spaces or special characters.",
    signatures: [/AXIS\s*BANK/i, /axisbank\.com/i],
  },
  {
    id: "sbi",
    name: "State Bank of India",
    passwordHint:
      "Usually your date of birth as DDMMYYYY, or the password you set when " +
      "you registered for e-statements.",
    signatures: [/State\s*Bank\s*of\s*India/i, /\bSBI\b/, /onlinesbi/i],
  },
];

export function detectBank(text: string): BankProfile | null {
  // Only the letterhead decides. A UPI narration mentioning another bank is
  // completely normal — "UPI-DMART-dmart@hdfcbank" appears in ICICI statements
  // every month — so any line that looks like a transaction is excluded, and
  // only the first handful of remaining lines are considered.
  const head = text
    .split("\n")
    .filter((line) => line.trim() !== "" && !/^\s*\d{1,2}[-\s/]/.test(line))
    .slice(0, 12)
    .join("\n");

  return BANKS.find((bank) => bank.signatures.some((s) => s.test(head))) ?? null;
}

// ---------------------------------------------------------------------------
// Shared row parsing
// ---------------------------------------------------------------------------

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * The four date shapes these statements use.
 *
 * Two-digit years are the trap: `01/04/26` is 2026, and treating it as 1926
 * puts the transaction a century out where no dedupe tier will ever see it.
 */
export function parseStatementDate(raw: string): IsoDate | null {
  const text = raw.trim();

  const named = /^(\d{1,2})[-\s/]([A-Za-z]{3})[a-z]*[-\s/](\d{2,4})$/.exec(text);
  if (named) {
    const month = MONTHS[named[2]!.toLowerCase()];
    if (!month) return null;
    return `${fullYear(named[3]!)}-${month}-${named[1]!.padStart(2, "0")}` as IsoDate;
  }

  const numeric = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/.exec(text);
  if (numeric) {
    const month = Number(numeric[2]);
    const day = Number(numeric[1]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${fullYear(numeric[3]!)}-${numeric[2]!.padStart(2, "0")}-${numeric[1]!.padStart(2, "0")}` as IsoDate;
  }

  return null;
}

function fullYear(raw: string): string {
  if (raw.length === 4) return raw;
  const n = Number(raw);
  // A statement is never from the 1900s, and "26" is 2026.
  return String(n < 70 ? 2000 + n : 1900 + n);
}

/** `1,234.56`, `1,234.56 Cr`, `(1,234.56)`, `1,234.56 Dr`. */
export function parseStatementAmount(raw: string): { value: number; credit: boolean } | null {
  const text = raw.trim();
  if (text === "" || text === "-") return null;

  const credit = /\bcr\b\.?$/i.test(text);
  const debit = /\bdr\b\.?$/i.test(text);
  const bracketed = /^\(.*\)$/.test(text);

  const digits = text.replace(/\b[cd]r\b\.?/i, "").replace(/[(),\s₹]/g, "");
  if (!/^-?\d*\.?\d+$/.test(digits)) return null;

  const value = Math.abs(Number(digits));
  if (!Number.isFinite(value)) return null;

  return { value, credit: credit && !debit && !bracketed };
}

function toPaise(value: number): Paise {
  return Math.round(value * 100) as Paise;
}

/**
 * A statement line, split into columns.
 *
 * The PDF text extractor separates columns with two or more spaces (see
 * `src/pdf/text.ts`), which is the seam every parser below relies on.
 */
function columns(line: string): string[] {
  return line.split(/\s{2,}/).map((c) => c.trim()).filter((c) => c !== "");
}

interface RowShape {
  date: IsoDate;
  narration: string;
  reference: string | null;
  amount: Paise;
}

/**
 * Where each column sits on the line.
 *
 * This is the part that makes the whole module work, and it is worth being
 * explicit about why. Splitting a row on whitespace looks sufficient until an
 * **empty column vanishes**:
 *
 *     03/08/26  UPI-SWIGGY  431202847592  03/08/26  450.00        144550.00
 *     05/08/26  NEFT-SALARY  N123456789   05/08/26          145000.00  289550.00
 *
 * Both rows come back as "date, text, ref, date, figure, figure". Nothing in
 * that tells you the first row's ₹450 is a withdrawal and the second row's
 * ₹1,45,000 is a deposit — and getting it backwards does not fail loudly, it
 * silently inverts a transaction.
 *
 * So the header line is read once, the character offset of each heading is
 * recorded, and each figure is assigned to the column it is printed under.
 * `src/pdf/text.ts` preserves horizontal position precisely so this is
 * possible; it is the reason that extractor keeps positions at all.
 */
interface Span {
  start: number;
  end: number;
}

interface HeaderColumns {
  debit: Span | null;
  credit: Span | null;
  balance: Span | null;
  reference: Span | null;
}

const HEADINGS: { key: keyof HeaderColumns; patterns: RegExp[] }[] = [
  { key: "debit", patterns: [/withdrawal(\s+amt\.?|\s+amount)?/i, /\bdebit\b/i, /\bwithdrawals?\b/i] },
  { key: "credit", patterns: [/deposit(\s+amt\.?|\s+amount)?/i, /\bcredit\b/i, /\bdeposits?\b/i] },
  { key: "balance", patterns: [/closing\s+balance/i, /\bbalance\b/i] },
  { key: "reference", patterns: [/chq\.?\s*\/?\s*ref\.?\s*no/i, /cheque\s+number/i, /ref\s*no/i] },
];

/**
 * Find the table header and the span each column occupies.
 *
 * The **span**, not a single offset. Matching a figure to a heading by their
 * end positions compares the right edge of a six-character number against the
 * right edge of a seventeen-character phrase, which is only correct when the
 * bank right-aligns both — and they do not agree with each other about that.
 * A span survives either convention.
 */
export function readHeader(lines: string[]): HeaderColumns | null {
  for (const line of lines) {
    // A header names a date column and at least one money column.
    if (!/\bdate\b/i.test(line)) continue;
    if (!/withdrawal|deposit|debit|credit/i.test(line)) continue;

    const found: HeaderColumns = { debit: null, credit: null, balance: null, reference: null };
    for (const { key, patterns } of HEADINGS) {
      for (const pattern of patterns) {
        const match = pattern.exec(line);
        if (match && found[key] === null) {
          found[key] = { start: match.index, end: match.index + match[0].length };
          break;
        }
      }
    }

    if (found.debit !== null || found.credit !== null) return found;
  }
  return null;
}

/**
 * Blank out anything that is a date, so the figure scan cannot mistake one for
 * money. `03/08/26` otherwise reads as the three numbers 3, 8 and 26, and the
 * 26 lands under whichever column heading happens to be nearest.
 *
 * Replaced with spaces rather than removed, because every offset after it has
 * to stay where it was.
 */
function maskDates(line: string): string {
  return line.replace(
    /\b\d{1,2}[-\s/](?:\d{1,2}|[A-Za-z]{3,9})[-\s/]\d{2,4}\b/g,
    (match) => " ".repeat(match.length),
  );
}

/** Every figure on a line, with the span of characters it occupies. */
function figuresWithOffsets(line: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const masked = maskDates(line);
  const pattern = /\(?\s*₹?\s*\d[\d,]*\.?\d*\s*\)?(?:\s*(?:Cr|Dr)\.?)?/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    const text = match[0].trim();
    // A reference or account number is not a figure: it is a long digit run
    // with no decimal separator.
    if (!/[.,]/.test(text) && text.replace(/\D/g, "").length > 4) continue;
    if (parseStatementAmount(text) === null) continue;
    const leading = match[0].length - match[0].trimStart().length;
    out.push({
      text,
      start: match.index + leading,
      end: match.index + match[0].trimEnd().length,
    });
  }
  return out;
}

/**
 * A statement row, read against the header's column positions.
 *
 * Falls back to the running balance when there is no usable header: the last
 * figure on a row is the balance, and its movement since the previous row is
 * the amount, sign included. That is slower to get going — it needs a previous
 * row — but it is entirely self-checking, because it is the statement's own
 * arithmetic.
 */
function parseRow(
  line: string,
  header: HeaderColumns | null,
  previousBalance: number | null,
): { row: RowShape; balance: number | null } | null {
  const cells = columns(line);
  if (cells.length < 2) return null;

  const date = parseStatementDate(cells[0]!);
  if (!date) return null;

  const figures = figuresWithOffsets(line);
  if (figures.length === 0) return null;

  // Narration is everything between the date and the figures that is not
  // itself a date or a bare reference number.
  const referenceCell = cells.slice(1).find((c) => /^[A-Z]?\d{6,20}$/.test(c.trim()));
  const narration = cells
    .slice(1)
    .filter((c) => parseStatementDate(c) === null)
    .filter((c) => c !== referenceCell)
    .filter((c) => parseStatementAmount(c) === null)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (narration === "") return null;

  /**
   * How well a figure sits under a heading.
   *
   * Overlap, because banks disagree about whether figures are left- or
   * right-aligned within a column and overlap is indifferent to that. With no
   * overlap the nearer edge decides, within a few characters.
   */
  const score = (figure: Span, span: Span): number => {
    const overlap = Math.min(figure.end, span.end) - Math.max(figure.start, span.start);
    if (overlap > 0) return overlap;
    return -Math.min(
      Math.abs(figure.start - span.start),
      Math.abs(figure.end - span.end),
      Math.abs(figure.start - span.end),
      Math.abs(figure.end - span.start),
    );
  };

  let amount: number | null = null;
  let balance: number | null = null;

  if (header) {
    /*
     * Assign each figure to its own best column, rather than letting each
     * column take its best figure.
     *
     * The difference decides whether a salary is income or an expense. In an
     * ICICI row the deposit sits three characters past the withdrawal heading,
     * so asking "which figure is nearest the withdrawal column?" claims it —
     * and the transaction inverts. Asking "which column does this figure sit
     * under?" gets the overlap with Deposit and is never in doubt.
     */
    const columnsByKey: [keyof HeaderColumns, Span | null][] = [
      ["debit", header.debit],
      ["credit", header.credit],
      ["balance", header.balance],
    ];

    const assigned: Partial<Record<keyof HeaderColumns, number>> = {};

    for (const figure of figures) {
      let bestKey: keyof HeaderColumns | null = null;
      let bestScore = -4;

      for (const [key, span] of columnsByKey) {
        if (!span) continue;
        const s = score(figure, span);
        if (s > bestScore) {
          bestScore = s;
          bestKey = key;
        }
      }

      if (!bestKey || assigned[bestKey] !== undefined) continue;
      const value = parseStatementAmount(figure.text)?.value;
      if (value !== undefined) assigned[bestKey] = value;
    }

    balance = assigned.balance ?? null;
    const debitValue = assigned.debit ?? 0;
    const creditValue = assigned.credit ?? 0;

    if (debitValue > 0 || creditValue > 0) {
      amount = creditValue > 0 ? creditValue : -debitValue;
    }
  }

  // No header, or a row whose figures did not land under one: fall back to the
  // balance movement, which is the statement checking itself.
  if (amount === null) {
    const last = figures[figures.length - 1]!;
    const lastValue = parseStatementAmount(last.text)?.value ?? null;
    if (lastValue === null) return null;

    if (previousBalance !== null && figures.length >= 2) {
      balance = lastValue;
      amount = Math.round((lastValue - previousBalance) * 100) / 100;
      if (amount === 0) return null;
    } else {
      return null;
    }
  }

  if (amount === null || amount === 0) return null;

  return {
    row: {
      date,
      narration,
      reference: referenceCell?.trim() ?? null,
      amount: toPaise(amount),
    },
    balance,
  };
}

/** An opening-balance line, which anchors the fallback path's first row. */
function openingBalanceOf(line: string): number | null {
  if (!/opening\s+balance|b\/?f\b|brought\s+forward/i.test(line)) return null;
  const figures = figuresWithOffsets(line);
  const last = figures[figures.length - 1];
  return last ? parseStatementAmount(last.text)?.value ?? null : null;
}

// ---------------------------------------------------------------------------
// The parsers
// ---------------------------------------------------------------------------

/**
 * Per-bank behaviour, kept to the two things that actually differ between
 * them. Everything else is shared, which is why adding a fifth bank is a row
 * in this table rather than a new file.
 */
const LAYOUTS: Record<BankId, { separateColumns: boolean; skip: RegExp[] }> = {
  hdfc: {
    separateColumns: true,
    skip: [/^date\b/i, /opening balance/i, /closing balance/i, /statement of account/i],
  },
  icici: {
    separateColumns: true,
    skip: [/^s\s*no\b/i, /^date\b/i, /transaction remarks/i, /^page\b/i],
  },
  axis: {
    separateColumns: true,
    skip: [/^tran date/i, /^particulars/i, /opening balance/i, /closing balance/i],
  },
  sbi: {
    separateColumns: true,
    skip: [/^txn date/i, /^value date/i, /^description/i, /account statement/i],
  },
};

/** Lines that are never transactions, in any bank's statement. */
const UNIVERSAL_SKIP = [
  /computer generated/i,
  /^page \d+/i,
  /this is a system generated/i,
  /^total\b/i,
  /^\s*$/,
];

export interface StatementParse extends ParseResult {
  bank: BankProfile | null;
  /** IL3 · Lines that looked like rows and did not parse, never swallowed. */
  text: string;
}

/**
 * Parse an already-extracted statement text.
 *
 * Split from the PDF handling so the layouts are testable without a PDF, the
 * same way `parseCasText` is.
 */
export function parseStatementText(text: string, bankId?: BankId): StatementParse {
  const bank = bankId
    ? BANKS.find((b) => b.id === bankId) ?? null
    : detectBank(text);

  const layout = bank ? LAYOUTS[bank.id] : null;
  const records: RawRecord[] = [];
  const errors: ParseError[] = [];

  const lines = text.split("\n");
  const header = readHeader(lines);

  let rowNumber = 0;
  let previousBalance: number | null = null;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const bare = trimmed.trim();
    if (bare === "") continue;

    // An opening balance is not a transaction, but it anchors the fallback
    // path — so it is read before it is skipped.
    const opening = openingBalanceOf(bare);
    if (opening !== null) {
      previousBalance = opening;
      continue;
    }

    if (UNIVERSAL_SKIP.some((s) => s.test(bare))) continue;
    if (layout?.skip.some((s) => s.test(bare))) continue;

    // Only lines beginning with a date are candidate rows. Everything else is
    // a heading, an address, or marketing.
    if (!/^\d{1,2}[-\s/]/.test(bare)) continue;

    rowNumber++;
    const parsed = parseRow(trimmed, header, previousBalance);

    if (!parsed) {
      errors.push({
        rowNumber,
        cells: columns(bare),
        reason: "This looked like a transaction but its columns could not be read.",
      });
      continue;
    }

    if (parsed.balance !== null) previousBalance = parsed.balance;

    records.push({
      rowNumber,
      date: parsed.row.date,
      amount: parsed.row.amount,
      narration: parsed.row.narration,
      reference: parsed.row.reference,
      raw: {
        date: columns(bare)[0] ?? "",
        amount: String(parsed.row.amount / 100),
        narration: parsed.row.narration,
      },
    });
  }

  return { records, errors, rowsRead: rowNumber, bank, text };
}

/**
 * Read a statement from its PDF bytes.
 *
 * `password` is used and discarded — PR5, the same as the CAS path. It is a
 * parameter and is never assigned to anything that outlives the call.
 */
export function parseStatementPdf(bytes: Uint8Array, password: string): StatementParse {
  const doc = readDocument(bytes);
  if (isEncrypted(doc)) decryptDocument(doc, password);
  expandObjectStreams(doc);
  return parseStatementText(extractText(doc));
}

/**
 * `04` §3.4 · Which sender means which institution.
 *
 * Compiled from this household's own inbox on 28-08-2026. It is here rather
 * than in the Gmail adapter because it is the same fact either way — the
 * address that sends a statement is the address that will send an alert — and
 * because the Gmail adapter does not exist yet.
 */
export const STATEMENT_SENDERS: { pattern: RegExp; bank: BankId | null; what: string }[] = [
  { pattern: /@hdfcbank\.bank\.in$/i, bank: "hdfc", what: "HDFC credit card statement" },
  { pattern: /^estatement@icici\.bank\.in$/i, bank: "icici", what: "ICICI account statement" },
  { pattern: /^credit_cards@icici\.bank\.in$/i, bank: "icici", what: "ICICI credit card statement" },
  { pattern: /^(statements|alerts|cc\.statements)@axis\.bank\.in$/i, bank: "axis", what: "Axis statement" },
  { pattern: /@alerts\.sbi\.bank\.in$/i, bank: "sbi", what: "SBI account statement" },
  { pattern: /^statements@sbicard\.com$/i, bank: "sbi", what: "SBI Card statement" },
  { pattern: /^noreplyunionbank@ubi\.bank\.in$/i, bank: null, what: "Union Bank account statement" },
  { pattern: /^estatement@yes\.bank\.in$/i, bank: null, what: "Yes Bank credit card statement" },
  { pattern: /^eCAS@cdslstatement\.com$/i, bank: null, what: "CDSL CAS — goes to the portfolio importer" },
  { pattern: /@camsonline\.com$/i, bank: null, what: "CAMS mutual fund statement" },
];

export function senderFor(address: string): { bank: BankId | null; what: string } | null {
  return STATEMENT_SENDERS.find((s) => s.pattern.test(address.trim())) ?? null;
}
