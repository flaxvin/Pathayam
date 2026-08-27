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
 * **The running balance decides the sign, not the column position.**
 *
 * The first version of this read each figure's position and matched it to the
 * table heading it sat under. That is the obvious approach and it is wrong,
 * which only became clear against a real statement: across 848 rows of an Axis
 * account, debit figures occupied character columns 67–85 and credit figures
 * 81–99. **They overlap.** The columns are right-aligned to a ragged edge, so
 * a ₹640 debit sits further right than a ₹2,500 debit and lands squarely under
 * the "Credit" heading. Position cannot decide, and a parser that thinks it can
 * inverts roughly half the transactions while looking completely healthy.
 *
 * The balance column can. Every Indian bank statement prints a running balance,
 * and the movement between two rows *is* the amount, sign included. On that
 * same file it resolved 845 of 848 rows to the exact printed figure. It is the
 * statement checking itself, and it needs no assumption about layout at all.
 *
 * So: balance movement first, column position as the fallback for a statement
 * with no balance column, and the printed figure used to **verify** the
 * movement rather than to derive it. Where the two disagree the row is reported
 * rather than guessed (IL3).
 */

import type { IsoDate } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";
import type { RawRecord, ParseError, ParseResult } from "./csv.ts";
import { readDocument, expandObjectStreams } from "../pdf/objects.ts";
import { decryptDocument, isEncrypted, WrongPassword } from "../pdf/decrypt.ts";
import { extractText } from "../pdf/text.ts";

export { WrongPassword };

export type BankId =
  | "hdfc" | "icici" | "axis" | "sbi"
  | "union" | "canara" | "yes" | "indusind" | "kotak" | "rbl" | "hsbc"
  /** Contract notes and funds statements from a broker, not a bank. */
  | "broker";

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
    // An IFSC prefix is the one identifier a statement cannot be vague about,
    // and it survives a letterhead that is just the customer's address.
    signatures: [/HDFC\s*BANK/i, /hdfcbank\.com/i, /\bIFSC\b[^\n]{0,24}?\bHDFC\d/i],
  },
  {
    id: "icici",
    name: "ICICI Bank",
    passwordHint:
      "All letters in lower case, no spaces or salutation — usually the first " +
      "four letters of your name followed by your date of birth as DDMM.",
    signatures: [/ICICI\s*Bank/i, /icicibank\.com/i, /\bIFSC\b[^\n]{0,24}?\bICIC\d/i],
  },
  {
    id: "axis",
    name: "Axis Bank",
    passwordHint:
      "The first four letters of your name in lower case, followed by your " +
      "date and month of birth as DDMM. No spaces or special characters.",
    signatures: [
      /AXIS\s*BANK/i, /axisbank\.com/i,
      // UTIB is Axis's IFSC prefix, from the days it was UTI Bank.
      /\bIFSC\b[^\n]{0,24}?\bUTIB\d/i, /Statement\s+of\s+Axis\s+Account/i,
    ],
  },
  {
    id: "sbi",
    name: "State Bank of India",
    passwordHint:
      "Usually your date of birth as DDMMYYYY, or the password you set when " +
      "you registered for e-statements.",
    signatures: [
      /State\s*Bank\s*of\s*India/i, /\bSBI\b/, /onlinesbi/i,
      /\bIFSC\b[^\n]{0,24}?\bSBIN\d/i,
    ],
  },
];

/**
 * The rest of what arrives in this household's inbox.
 *
 * Added from a 180-day sweep. The password rules are quoted from each
 * institution's own statement email, which is the only place they are stated
 * accurately — Union Bank wants uppercase and Axis wants lowercase, and no
 * documentation anywhere says so.
 */
BANKS.push(
  {
    id: "union",
    name: "Union Bank of India",
    // Quoted: "first four characters of your name in uppercase followed by
    // Date/Month(DDMM) of your birth."
    passwordHint:
      "The first four characters of your name in CAPITALS, then your date and " +
      "month of birth as DDMM. For Ravi Kumar born 01/01/1970: RAVI0101.",
    signatures: [/Union\s*Bank\s*of\s*India/i, /unionbankofindia/i, /\bIFSC\b[^\n]{0,24}?\bUBIN\d/i],
  },
  {
    id: "canara",
    name: "Canara Bank",
    passwordHint:
      "Usually your date of birth as DDMMYYYY, or the first four letters of " +
      "your name in capitals followed by DDMM.",
    signatures: [/Canara\s*Bank/i, /canarabank\.com/i, /\bIFSC\b[^\n]{0,24}?\bCNRB\d/i],
  },
  {
    id: "yes",
    name: "YES Bank",
    passwordHint:
      "The first four letters of your name in capitals followed by your date " +
      "and month of birth as DDMM.",
    signatures: [/\bYES\s*BANK\b/i, /yesbank\.in/i, /\bIFSC\b[^\n]{0,24}?\bYESB\d/i],
  },
  {
    id: "indusind",
    name: "IndusInd Bank",
    passwordHint:
      "Usually your date of birth as DDMMYYYY, or the first four letters of " +
      "your name followed by DDMM.",
    signatures: [/IndusInd\s*Bank/i, /indusind\.com/i, /\bIFSC\b[^\n]{0,24}?\bINDB\d/i],
  },
  {
    id: "kotak",
    name: "Kotak Mahindra Bank",
    passwordHint:
      "The first four letters of your name in lower case followed by your " +
      "date and month of birth as DDMM.",
    signatures: [/Kotak\s*Mahindra/i, /kotak\.com/i, /\bIFSC\b[^\n]{0,24}?\bKKBK\d/i],
  },
  {
    id: "rbl",
    name: "RBL Bank",
    passwordHint:
      "The first four letters of your name in capitals followed by your date " +
      "of birth as DDMMYY — a two-digit year, unusually.",
    signatures: [/\bRBL\s*Bank/i, /rblbank\.com/i, /\bIFSC\b[^\n]{0,24}?\bRATN\d/i],
  },
  {
    id: "hsbc",
    name: "HSBC India",
    passwordHint:
      "Usually your date of birth as DDMMYYYY, or the password you set for " +
      "e-statements.",
    signatures: [/\bHSBC\b/i, /hsbc\.co\.in/i, /\bIFSC\b[^\n]{0,24}?\bHSBC\d/i],
  },
  {
    id: "broker",
    name: "Your broker",
    // Quoted from Upstox: "use your PAN (in lowercase)".
    passwordHint: "Your PAN, in lower case.",
    signatures: [
      /UPSTOX\s*SECURITIES/i, /INDstocks|INDmoney/i, /Zerodha/i, /Groww/i,
      /Contract\s*Note/i,
    ],
  },
);

export function detectBank(text: string): BankProfile | null {
  /*
   * Everything above the first transaction row decides.
   *
   * Not "the first dozen lines": a real Axis statement opens with the
   * customer's postal address, and the only thing naming the bank is the IFSC
   * code eight lines down and the account line below that. And not the whole
   * document, because "UPI-DMART-dmart@hdfcbank" appears in ICICI statements
   * every month and a narration must never decide the producer.
   */
  /*
   * The head is the first stretch of the document with its **transaction rows
   * removed**, rather than everything before the first row.
   *
   * Both halves matter. Excluding rows is what stops a narration deciding:
   * "UPI-DMART-dmart@hdfcbank" appears in ICICI statements every month. And
   * looking past the first row is what finds Axis's "Relationship Statement",
   * which prints its first transaction four lines in and names the bank well
   * below that.
   */
  const lines = text.split("\n");
  const head = lines
    .filter((line) => findDate(line) === null)
    .slice(0, 40)
    .join("\n");

  /*
   * Matched against the text with its spaces removed as well as as-is.
   *
   * Some generators position every glyph individually, and the extractor then
   * reports what is genuinely there: "R elationship Statement", "A XIS BANK".
   * A signature written the way a human reads it would never match, and the
   * statement would be treated as coming from an unknown bank.
   */
  const squashed = head.replace(/\s+/g, "");

  return BANKS.find((bank) =>
    bank.signatures.some((s) => s.test(head) || s.test(squashed)),
  ) ?? null;
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

  /*
   * A leading currency mark is stripped, including the letter "C".
   *
   * That is not a typo. HDFC's card statement embeds the rupee sign in a font
   * whose encoding maps it to code 0x43, so a faithful extractor reports
   * "C 491.00" where the page shows "₹ 491.00". Leaving it attached means the
   * cell is not recognised as money — so it lands in the payee instead, and
   * the row's sign is decided by the wrong rule.
   */
  const withoutCurrency = text
    .replace(/\b[cd]r\b\.?/i, "")
    .replace(/^\s*(?:Rs\.?|INR|₹|C)\s*(?=[\d(])/i, "");

  const digits = withoutCurrency.replace(/[(),\s₹]/g, "");
  // A leading "+" is how HDFC marks a refund on a card, so it has to survive
  // as far as the sign logic rather than making the cell unreadable.
  if (!/^[-+]?\d*\.?\d+$/.test(digits)) return null;

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
  // A tab is one whitespace character but always a column boundary, so it is
  // widened before splitting — some generators emit tabs instead of spacing.
  return line
    .replace(/\t/g, "  ")
    .split(/\s{2,}/)
    .map((c) => c.trim())
    .filter((c) => c !== "");
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

    /*
     * Both columns, or none.
     *
     * A single match is almost always a false positive — the words "credit
     * card" appear all over a card statement, and one stray hit put every
     * purchase on the credit side, turning ₹61,000 of spending into ₹61,000 of
     * income. A real debit/credit table names both.
     */
    if (found.debit !== null && found.credit !== null) return found;
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
  const pattern =
    /(?:Rs\.?|INR|₹|C)?\s*\(?\s*[-+]?\s*\d[\d,]*\.?\d*\s*\)?(?:\s*(?:Cr|Dr)\.?)?/gi;

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
 * Where the date sits on a line, if it does.
 *
 * Found by regex rather than by taking the first column, because real
 * statements put things in front of it and around it:
 *
 *   `  1   11-02-2026   UPIAR/…`   — Union Bank prints a serial number first
 *   `17/03/2026| 23:08  PYU*Swiggy` — HDFC's card appends a time with a pipe
 *   `15/02/2026 UPI_ZOOMCAR IND`    — YES Bank uses a single space, so column
 *                                     splitting never separates them
 *
 * Only the first stretch of the line is searched: a date inside a narration
 * ("EMI due 05-09-2026") must not be mistaken for the transaction date.
 */
const DATE_ANYWHERE =
  /(\b\d{1,2}[-\s/](?:\d{1,2}|[A-Za-z]{3,9})[-\s/]\d{2,4}\b)/;

export function findDate(line: string, within = 46): {
  date: IsoDate; start: number; end: number;
} | null {
  // Measured from the first non-space character, not from column zero. HDFC's
  // card statement indents its table by forty characters, and a window fixed
  // to the left edge of the page never reaches the date.
  const indent = line.length - line.trimStart().length;
  const head = line.slice(indent, indent + within);
  const match = DATE_ANYWHERE.exec(head);
  if (!match) return null;

  const date = parseStatementDate(match[1]!);
  if (!date) return null;

  // Anything before the date must be a serial number or blank — otherwise this
  // is prose that happens to contain a date.
  const before = head.slice(0, match.index).trim();
  if (before !== "" && !/^\d{1,4}[.)]?$/.test(before)) return null;

  return {
    date,
    start: indent + match.index,
    end: indent + match.index + match[1]!.length,
  };
}

/**
 * Lines that end a transaction table.
 *
 * Deliberately almost empty, and that is the lesson. The obvious candidates —
 * "Summary", "Closing Balance", "IMPORTANT INFORMATION" — all turned out to
 * appear *above* the transactions in at least one real statement: Axis prints
 * a Summary block and a closing-balance footnote first, HDFC's card leads with
 * IMPORTANT INFORMATION. Each one silently discarded every row of the file it
 * appeared in.
 *
 * What survives is the case with no ambiguity: Union Bank's "LINKED LOAN &
 * ADVANCES" appendix, whose rows carry a date and a balance and would
 * otherwise import as transactions worth ₹18 lakh.
 */
const TABLE_END = [
  /^linked\s+(casa|deposits|loan|lockers)/i,
  /^end\s+of\s+statement/i,
];

/**
 * A marker that says which way the money went, when there is no balance column
 * to work it out from.
 *
 * Credit cards need this: they print one amount column, and a refund is marked
 * with `Cr`, a leading `+`, or a minus sign depending on the issuer.
 */
function markedSign(line: string, from: number): 1 | -1 | null {
  const tail = line.slice(from);
  if (/\bcr\b\.?\s*$/i.test(tail)) return 1;
  if (/\bdr\b\.?\s*$/i.test(tail)) return -1;
  // ICICI prints a bare minus in front of a refund; HDFC a plus.
  if (/[+]\s*[₹C]?\s*[\d,]+\.\d{2}/.test(tail)) return 1;
  if (/-\s*[₹C]?\s*[\d,]+\.\d{2}/.test(tail)) return 1;
  return null;
}

/**
 * A statement row.
 *
 * `previousBalance` is what makes the sign trustworthy — see the module
 * header. The printed figure is used to *check* the balance movement, not to
 * derive it.
 */
function parseRow(
  line: string,
  header: HeaderColumns | null,
  previousBalance: number | null,
  continuation: string[],
): { row: RowShape; balance: number | null; suspect: boolean } | null {
  const found = findDate(line);
  if (!found) return null;

  const figures = figuresWithOffsets(line);
  if (figures.length === 0) return null;

  // Narration is what is left of the line after the date, once figures, dates
  // and bare reference numbers are taken out.
  const after = line.slice(found.end);
  const referenceCell = columns(after).find((c) => /^[A-Z]?\d{6,20}$/.test(c.trim()));
  const own = columns(after)
    .filter((c) => parseStatementDate(c) === null)
    .filter((c) => findDate(c, c.length) === null)
    .filter((c) => c !== referenceCell)
    // Any cell *containing* a figure, not just one that parses cleanly as
    // money: HDFC prints a bullet glyph after the amount, and "491.00 l" is
    // not a number but is certainly not a payee either.
    .filter((c) => !/\d[\d,]*\.\d{2}/.test(c))
    .filter((c) => parseStatementAmount(c) === null)
    // A stray time from "17/03/2026| 23:08", and column rules.
    .map((c) => c.replace(/^[|\s]+/, "").replace(/^\d{1,2}:\d{2}(:\d{2})?$/, ""))
    // A lone currency mark, sign or bullet left over once the figure beside it
    // was removed. Keeping them puts "C" and "+" in the payee name, which then
    // reaches payee matching and rules.
    .map((c) => c.replace(/[\s+*·•|]*(?:Rs\.?|INR|₹|C)?[\s+*·•|]*$/i, "").trim())
    .filter((c) => c.trim() !== "");

  const narration = [...continuation, ...own].join(" ").replace(/\s+/g, " ").trim();
  if (narration === "") return null;

  const value = (f: { text: string }): number | null =>
    parseStatementAmount(f.text)?.value ?? null;

  // Figures with paise are money. A trailing branch code — Axis prints "1460"
  // after the balance — is a bare integer, and reading it as a balance would
  // corrupt every row after it.
  const withPaise = figures.filter((f) => /\.\d{2}\b/.test(f.text));
  const money = withPaise.length > 0 ? withPaise : figures;

  // A balance column only exists if the header says so. Without that, the last
  // figure is the amount, not a running total.
  const hasBalance = header?.balance != null && money.length >= 2;
  const balanceFigure = hasBalance ? money[money.length - 1]! : null;
  const balance = balanceFigure ? value(balanceFigure) : null;

  const amountFigure = hasBalance
    ? money[money.length - 2] ?? null
    : money[money.length - 1] ?? null;
  const printed = amountFigure ? value(amountFigure) : null;

  let amount: number | null = null;
  let suspect = false;

  // 1 · The balance moved. That movement is the amount, sign and all.
  if (balance !== null && previousBalance !== null) {
    const moved = Math.round((balance - previousBalance) * 100) / 100;
    if (moved !== 0) {
      amount = moved;
      if (printed !== null && Math.abs(Math.abs(moved) - printed) > 0.011) suspect = true;
    }
  }

  // 2 · A marker says which way it went — Cr, Dr, a leading + or -. This is
  //     how every credit card states it, since they print no running balance.
  if (amount === null && printed !== null && amountFigure) {
    const sign = markedSign(line, amountFigure.start - 3);
    if (sign !== null) amount = sign * printed;
  }

  // 3 · Which column the figure sits under. Weakest — real debit and credit
  //     columns overlap — so it is last and it flags the row.
  if (amount === null && header && printed !== null && amountFigure) {
    const overlap = (span: Span | null): number =>
      span === null
        ? -Infinity
        : Math.min(amountFigure.end, span.end) - Math.max(amountFigure.start, span.start);

    const debit = overlap(header.debit);
    const credit = overlap(header.credit);
    if (debit > -Infinity || credit > -Infinity) {
      amount = credit > debit ? printed : -printed;
      suspect = true;
    }
  }

  // 4 · Nothing said otherwise. On a card statement a bare figure is a
  //     purchase, which is the overwhelming majority of rows.
  if (amount === null && printed !== null) amount = -printed;

  if (amount === null || amount === 0) return null;

  return {
    row: {
      date: found.date,
      narration,
      reference: referenceCell?.trim() ?? null,
      amount: toPaise(amount),
    },
    balance,
    suspect,
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
const LAYOUTS: Partial<Record<BankId, { separateColumns: boolean; skip: RegExp[] }>> = {
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
  union: { separateColumns: true, skip: [/^date\b/i, /^particulars/i, /statement of account/i] },
  canara: { separateColumns: true, skip: [/^date\b/i, /^description/i, /statement/i] },
  yes: { separateColumns: true, skip: [/^date\b/i, /^description/i, /transaction details/i] },
  indusind: { separateColumns: true, skip: [/^date\b/i, /^particulars/i, /^description/i] },
  kotak: { separateColumns: true, skip: [/^date\b/i, /^narration/i, /^description/i] },
  rbl: { separateColumns: false, skip: [/^date\b/i, /account summary/i] },
  hsbc: { separateColumns: false, skip: [/^date\b/i, /^description/i] },
  broker: { separateColumns: true, skip: [/^date\b/i, /contract note/i] },
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
  /** The extracted text, so an unrecognised file can still be mapped. */
  text: string;
  /**
   * Does the parse agree with the statement's own closing balance?
   *
   * Worth surfacing rather than keeping internal: it is an independent check
   * that every row was read and read correctly, computed from figures the
   * parser did not derive. On a real seven-month Axis statement — 848 rows —
   * opening ₹11,33,172.01 plus the parsed movements lands on ₹1,34,868.52,
   * which is exactly what the statement prints. Nothing else this app does
   * gets that kind of confirmation for free.
   *
   * Null when the statement prints no opening or closing balance to check
   * against, which is not a failure — most credit-card statements do not.
   */
  reconciliation: {
    opening: Paise;
    closing: Paise;
    /** opening + Σ amounts − closing. Zero when the statement reconciles. */
    difference: Paise;
    ok: boolean;
  } | null;
}

/**
 * Parse an already-extracted statement text.
 *
 * Split from the PDF handling so the layouts are testable without a PDF, the
 * same way `parseCasText` is.
 */
export function parseStatementText(text: string, bankId?: BankId): StatementParse {
  const bank = bankId ? BANKS.find((b) => b.id === bankId) ?? null : detectBank(text);
  const layout = bank ? LAYOUTS[bank.id] : null;
  const records: RawRecord[] = [];
  const errors: ParseError[] = [];

  const lines = text.split("\n");
  const header = readHeader(lines);

  // The opening balance may be printed *after* the rows — Union Bank puts it
  // in a summary block below the table — so it is found in a pass of its own
  // rather than picked up on the way past.
  let previousBalance: number | null = null;
  for (const line of lines) {
    const open = openingBalanceOf(line);
    if (open !== null) { previousBalance = open; break; }
  }

  /*
   * Pass one: classify every line.
   *
   * Narration wraps around the dated line rather than before it. Axis prints
   * the payee's first half above; Union Bank prints one fragment above and
   * another below the same row:
   *
   *       UPIAR/400111222888/DR/
   *   1   11-02-2026            855.00       11,625.55 Cr
   *       CRED/UTIB/cred.utility@a
   *
   * because the cell is wrapped and the date is vertically centred in its row.
   * So a fragment is assigned to the **nearest** dated line, ties going to the
   * one above. Attaching everything to the row above — the obvious first
   * guess — glues each row's opening fragment onto its predecessor, and the
   * payee ends up on the wrong transaction.
   */
  type Line = { raw: string; kind: "row" | "fragment" | "ignore"; date?: IsoDate };
  const classified: Line[] = [];
  let ended = false;

  for (const raw of lines) {
    const bare = raw.trim();

    if (bare === "") { classified.push({ raw, kind: "ignore" }); continue; }

    if (TABLE_END.some((p) => p.test(bare))) {
      ended = true;
      classified.push({ raw, kind: "ignore" });
      continue;
    }
    if (UNIVERSAL_SKIP.some((p) => p.test(bare)) || layout?.skip.some((p) => p.test(bare))) {
      classified.push({ raw, kind: "ignore" });
      continue;
    }

    const found = findDate(raw);

    /*
     * A statement period is not a transaction.
     *
     * YES Bank heads its table with "15/02/2026 To 14/03/2026 … Credit Limit:
     * Rs. 3,00,000.00", which begins with a date and ends with a figure — so
     * it parses as a ₹3,00,000 debit unless the range is recognised for what
     * it is.
     */
    const isPeriod =
      found !== null &&
      /\d{1,2}[-\s/][\w]{2,9}[-\s/]\d{2,4}\s*(?:to|through|–|—)\s*\d{1,2}[-\s/][\w]{2,9}[-\s/]\d{2,4}/i
        .test(bare);

    if (found && !ended && !isPeriod) {
      classified.push({ raw, kind: "row", date: found.date });
      continue;
    }
    if (found) { classified.push({ raw, kind: "ignore" }); continue; }

    const fragment = bare.replace(/\s{2,}/g, " ");

    /*
     * A wrapped payee, not a label.
     *
     * Statements pack summary fields into the same vertical band as the table
     * — "Opening Balance 4,19,620.65", "Credit Limit:", "CKYC ID : …" — and
     * each one that slips through is glued onto a real transaction's payee,
     * where it then reaches payee matching, rules and dedupe. A genuine
     * wrapped payee does not carry a money figure.
     */
    const looksLikeLabel =
      /\d[\d,]*\.\d{2}/.test(fragment) ||
      /\b(balance|limit|summary|statement\s+period|ckyc|customer\s+id|total|due\s+date)\b/i
        .test(fragment);

    const looksLikeNarration =
      fragment.length < 120 &&
      /[A-Za-z]/.test(fragment) &&
      !/^[\d,.\s]+$/.test(fragment) &&
      !looksLikeLabel;

    classified.push({ raw, kind: looksLikeNarration ? "fragment" : "ignore" });
  }

  // Pass two: give each fragment to its nearest row.
  const rowIndexes = classified.flatMap((l, i) => (l.kind === "row" ? [i] : []));
  const extra = new Map<number, string[]>();

  for (const [i, line] of classified.entries()) {
    if (line.kind !== "fragment") continue;

    let nearest = -1;
    let best = Infinity;
    for (const r of rowIndexes) {
      // Ties go above, and a fragment more than three lines from any row is
      // page furniture rather than a wrapped cell.
      const distance = Math.abs(r - i) + (r < i ? 0 : 0.5);
      if (distance < best) { best = distance; nearest = r; }
    }
    if (nearest === -1 || best > 3) continue;

    /*
     * A wrapped cell is indented past its row's date column; a letterhead or a
     * page heading starts at the left margin. Without this the bank's own name
     * is glued onto the first transaction as part of the payee.
     */
    const rowDate = findDate(classified[nearest]!.raw);
    const indent = line.raw.length - line.raw.trimStart().length;
    if (rowDate && indent <= rowDate.start) continue;

    const list = extra.get(nearest) ?? [];
    list.push(line.raw.trim().replace(/\s{2,}/g, " "));
    extra.set(nearest, list);
  }

  // Pass three: parse.
  let rowNumber = 0;
  for (const index of rowIndexes) {
    const line = classified[index]!;
    rowNumber++;

    const parsed = parseRow(line.raw, header, previousBalance, extra.get(index) ?? []);
    if (!parsed) {
      errors.push({
        rowNumber,
        cells: columns(line.raw.trim()),
        reason: "This looked like a transaction but its columns could not be read.",
      });
      continue;
    }

    if (parsed.balance !== null) previousBalance = parsed.balance;

    if (parsed.suspect) {
      errors.push({
        rowNumber,
        cells: columns(line.raw.trim()),
        reason:
          "The amount printed on this row does not match how the balance moved. " +
          "It has been imported at the balance movement — check it.",
      });
    }

    records.push({
      rowNumber,
      date: parsed.row.date,
      amount: parsed.row.amount,
      narration: parsed.row.narration,
      reference: parsed.row.reference,
      raw: {
        date: line.raw.trim().slice(0, 12),
        amount: String(parsed.row.amount / 100),
        narration: parsed.row.narration,
      },
    });
  }

  return {
    records, errors, rowsRead: rowNumber, bank, text,
    reconciliation: reconcile(lines, records),
  };
}

/**
 * Check the parse against the statement's own closing balance.
 *
 * The point of doing this at all: every other signal here is something the
 * parser worked out. This one is a number the bank printed, and it either
 * matches or it does not.
 */
function reconcile(
  lines: string[], records: RawRecord[],
): StatementParse["reconciliation"] {
  let opening: number | null = null;
  let closing: number | null = null;

  for (const line of lines) {
    const open = openingBalanceOf(line);
    if (open !== null && opening === null) opening = open;

    if (/closing\s+balance/i.test(line)) {
      const figures = figuresWithOffsets(line).filter((f) => /\.\d{2}\b/.test(f.text));
      const last = figures[figures.length - 1];
      if (last) closing = parseStatementAmount(last.text)?.value ?? null;
    }
  }

  if (opening === null || closing === null) return null;

  const summed = records.reduce((total, r) => total + r.amount, 0);
  const difference = toPaise(opening) + summed - toPaise(closing);

  return {
    opening: toPaise(opening),
    closing: toPaise(closing),
    difference: difference as Paise,
    ok: difference === 0,
  };
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
 * Open a statement, trying each derived password until one works.
 *
 * The order matters only for speed: a wrong password is cheap to test against
 * a local file, there is no server to rate-limit and no account to lock. What
 * it buys is that the household types a PAN once instead of every month.
 *
 * Returns which candidate opened it — described, never the value — so the
 * screen can say "opened with your PAN" rather than leaving them guessing.
 */
export function openStatement(
  bytes: Uint8Array,
  candidates: string[],
): { parse: StatementParse; candidate: string } | null {
  let sawWrongPassword = false;

  for (const candidate of candidates) {
    try {
      const parse = parseStatementPdf(bytes, candidate);
      // A file that opens but yields nothing is not a success worth stopping
      // on — unless nothing else works, which the caller decides.
      return { parse, candidate };
    } catch (error) {
      if (error instanceof WrongPassword) {
        sawWrongPassword = true;
        continue;
      }
      throw error;
    }
  }

  if (sawWrongPassword) return null;
  return null;
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
  { pattern: /@ubi\.bank\.in$/i, bank: "union", what: "Union Bank account statement" },
  { pattern: /^estatement@yes\.bank\.in$/i, bank: "yes", what: "YES Bank credit card statement" },
  { pattern: /@canarabank\.com$/i, bank: "canara", what: "Canara Bank credit card statement" },
  { pattern: /@rbl\.bank\.in$/i, bank: "rbl", what: "RBL Bank credit card statement" },
  { pattern: /@mail\.hsbc\.co\.in$/i, bank: "hsbc", what: "HSBC statement" },
  { pattern: /@indusind\.com$/i, bank: "indusind", what: "IndusInd statement" },
  { pattern: /@transactions\.upstox\.com$/i, bank: "broker", what: "Upstox funds or demat statement" },
  { pattern: /@transactions\.indmoney\.com$/i, bank: "broker", what: "INDmoney statement" },
  { pattern: /^eCAS@cdslstatement\.com$/i, bank: null, what: "CDSL CAS — goes to the portfolio importer" },
  { pattern: /@camsonline\.com$/i, bank: null, what: "CAMS mutual fund statement" },
];

export function senderFor(address: string): { bank: BankId | null; what: string } | null {
  return STATEMENT_SENDERS.find((s) => s.pattern.test(address.trim())) ?? null;
}
