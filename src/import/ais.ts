/**
 * TAX-AIS · Reading the Income Tax Department's Annual Information Statement.
 *
 * The AIS is what the department already knows about a person's year: tax
 * deducted at source, interest and dividends reported by banks and companies,
 * salary from the employer's TDS return, securities sold. The tax page used to
 * take TDS as one typed figure "from Form 16 or 26AS (nothing is read from
 * either)"; this reads it instead.
 *
 * ## What was checked, and against what (retrieved 13/14-11-2026)
 *
 *   · **Formats.** The e-filing portal offers the AIS as PDF, JSON and CSV
 *     (incometax.gov.in, AIS help page and AIS FAQ Q-9). The department's own
 *     AIS page says the *whole* statement downloads only as PDF or JSON; CSV
 *     is per category.
 *   · **The PDF's password** is the PAN in lower case followed by the date of
 *     birth as DDMMYYYY, e.g. `aaaaa1234a21011991`
 *     (incometaxindia.gov.in/en/annual-information-statement). The JSON is
 *     opened in the department's offline AIS Utility with the PAN in *upper*
 *     case instead — it is a file for that utility.
 *   · **The JSON's fields are not published.** No primary source, and no
 *     credible secondary one, documents them. So this reads the PDF only, and
 *     names no JSON field: a guessed field name is a number read from the
 *     wrong place.
 *   · **The categories** — "Salary", "Dividend", "Interest from savings bank",
 *     "Interest from deposit", "Interest from others", "Sale of securities and
 *     units of mutual fund" — are the section headings of the department's AIS
 *     Handbook (v2.0, March 2022, Directorate of Income Tax (Systems)), as are
 *     Part A "General Information" and Part B's "TDS/TCS Information",
 *     "SFT Information", "Payment of Taxes", "Demand and Refund" and
 *     "Other Information" (also in the AIS FAQ, Q-2).
 *
 * ## What is assumed [unverified]
 *
 * The table layout of the PDF itself. No source shows it, and there is no real
 * AIS in this repository (nor should there be). The reading below assumes each
 * information line is one text line of columns — serial number, an
 * information code (TDS-192, SFT-016…), its description, the information
 * source, a count and an amount — and that the lines under it with a date are
 * its quarter-by-quarter detail, whose last amount is the TDS deposited. A
 * PDF laid out otherwise does not produce wrong figures: its lines fail the
 * shape, and are reported as not read.
 *
 * ## What is never kept
 *
 * The PAN is read only to check the file is the member's own, and is then
 * dropped. Name, address, Aadhaar, account numbers and dates are never
 * extracted into anything returned. What leaves this module is the year,
 * and per line a category, the information description, the source's name
 * (a bank or employer), the amount and the TDS.
 */

import { readDocument, expandObjectStreams } from "../pdf/objects.ts";
import { decryptDocument, isEncrypted, WrongPassword } from "../pdf/decrypt.ts";
import { extractText } from "../pdf/text.ts";
import type { Paise } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";

export { WrongPassword };

/** The parts of Part B the reader knows by heading. */
export type AisSection = "tds" | "sft" | "taxes-paid" | "demand-refund" | "other";

/** What a line is, for the estimate. `unread` is a line of a category not modelled. */
export type AisCategory =
  | "salary"
  | "interest-savings"
  | "interest-deposit"
  | "interest-other"
  | "dividend"
  | "securities-sale"
  | "unread";

export const AIS_CATEGORIES: readonly AisCategory[] = [
  "salary", "interest-savings", "interest-deposit", "interest-other", "dividend", "securities-sale", "unread",
];

export interface AisLine {
  section: "tds" | "sft" | "other";
  category: AisCategory;
  /** The information code as printed (TDS-194A, SFT-016…), or null. Not personal. */
  code: string | null;
  /** The information description, as printed — a category name, not personal. */
  label: string;
  /** The bank, company or employer that reported it. */
  source: string;
  amount: Paise;
  /** TDS deposited against it, summed over its detail rows; 0 where none. */
  tds: Paise;
}

export interface AisStatement {
  /** Starting year: 2025 is FY 2025-26. */
  fy: number;
  /** Upper case. Used for the ownership check, never stored. */
  pan: string;
  lines: AisLine[];
  /**
   * What was in the file and not read, by part — counts, never text: an
   * unread line can be an address or an account number.
   */
  notRead: { part: string; lines: number }[];
}

/** The PDF password, as the department states it: PAN lower case + DDMMYYYY. */
export function aisPassword(pan: string, dob: string): string {
  return `${pan.trim().toLowerCase()}${dob.replace(/\D/g, "")}`;
}

/**
 * Read an AIS from its PDF bytes. `password` is used and discarded (PR5).
 * Throws `WrongPassword` when it does not open, and a Refusal when what opened
 * is not an AIS this can read.
 */
export function parseAisPdf(bytes: Uint8Array, password: string): AisStatement {
  const doc = readDocument(bytes);
  if (isEncrypted(doc)) decryptDocument(doc, password);
  expandObjectStreams(doc);
  return parseAisText(extractText(doc));
}

const PAN = /\b([A-Z]{5}\d{4}[A-Z])\b/;
const CODE = /^(?:TDS|TCS|SFT)-[0-9A-Z()/-]+$/i;
const AMOUNT = /^-?[\d,]+(?:\.\d{1,2})?$/;
const DATE = /^\d{2}[-/](?:\d{2}|[A-Za-z]{3})[-/]\d{4}$/;

function amountOf(cell: string): Paise | null {
  const t = cell.replace(/^(?:Rs\.?|₹|INR)\s*/i, "").trim();
  if (!AMOUNT.test(t) || !/\d/.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) as Paise;
}

/** The headings this knows, in the words of the AIS FAQ and Handbook. */
function headingOf(line: string): { part: string; section: AisSection | "general" | "unknown" } | null {
  const t = line.trim().replace(/\s+/g, " ").toLowerCase();
  if (t.length > 60) return null;
  if (/^(?:part\s*a\s*[-–:]?\s*)?general information\b/.test(t)) return { part: "General information", section: "general" };
  if (/^(?:part\s*b\d*\s*[-–:]?\s*)?tds\s*\/\s*tcs information\b/.test(t)) return { part: "TDS/TCS information", section: "tds" };
  if (/^(?:part\s*b\d*\s*[-–:]?\s*)?sft information\b/.test(t)) return { part: "SFT information", section: "sft" };
  if (/^(?:part\s*b\d*\s*[-–:]?\s*)?payment of taxes\b/.test(t)) return { part: "Payment of taxes", section: "taxes-paid" };
  if (/^(?:part\s*b\d*\s*[-–:]?\s*)?demand and refund\b/.test(t)) return { part: "Demand and refund", section: "demand-refund" };
  if (/^(?:part\s*b\d*\s*[-–:]?\s*)?other information\b/.test(t)) return { part: "Other information", section: "other" };
  // A part this does not know — a new one the department adds. Its lines are
  // not read into the part before it; they are counted as not read.
  if (/^part\s*[a-z]\d*\s*[-–:]/.test(t)) return { part: "A part this app does not know", section: "unknown" };
  return null;
}

/**
 * The category, from the description first (the Handbook's own words) and
 * the code second. Section 192 is salary (Handbook §4.1) and 194 dividend
 * (§4.3). The Handbook files 194A deductions under "Interest from deposit"
 * (§4.5) alongside SFT-016's term and recurring deposit interest, so a 194A
 * line is deposit interest here too — which is what lets the summary keep the
 * higher of a bank's two reports of the same interest instead of adding both.
 */
export function categoryOf(code: string | null, label: string): AisCategory {
  const d = label.toLowerCase();
  const c = (code ?? "").toUpperCase();
  if (/sale of securities|units of mutual fund/.test(d) && /sale/.test(d)) return "securities-sale";
  if (/purchase/.test(d)) return "unread";
  if (/\bsalary\b/.test(d) || c === "TDS-192") return "salary";
  if (/interest from savings bank|savings bank interest|interest on savings/.test(d)) return "interest-savings";
  if (/interest from deposit|interest on (?:time|term|fixed|recurring) deposit/.test(d) || c === "TDS-194A") {
    return "interest-deposit";
  }
  if (/\binterest\b/.test(d) || c === "TDS-193") return "interest-other";
  if (/\bdividend\b/.test(d) || c === "TDS-194" || c === "SFT-015" || c === "SFT-018") return "dividend";
  return "unread";
}

/** The not-read part a TCS line is counted under. */
export const TCS_PART = "TCS (tax collected at source)";

/** A TCS line: its code (TCS-206C…), or a description that says so. */
export function isTcs(code: string | null, label: string): boolean {
  return /^TCS-/i.test(code ?? "") || /tax collected at source|\btcs\b/i.test(label);
}

/**
 * Whether a line's deducted amount is TDS beyond doubt: a TDS-… code, or no
 * code and a category this reads. An uncategorised line without a TDS code
 * is shown, never summed into the TDS box (review 2).
 */
export function isClearlyTds(line: { code: string | null; label: string; category: AisCategory }): boolean {
  if (isTcs(line.code, line.label)) return false;
  if (line.code !== null) return /^TDS-/i.test(line.code);
  return line.category !== "unread";
}

/** Header rows and page furniture, which are expected and not "unread". */
function isFurniture(line: string): boolean {
  const t = line.toLowerCase();
  return /information (?:code|description|source)|sr\.?\s*no|\bquarter\b.*\bdate\b|amount paid|tds deposited|^\s*page \d+|annual information statement/.test(t);
}

/**
 * The parser proper, over already-extracted text. Split out, like the CAS
 * reader's, because it is the part worth testing line by line.
 */
export function parseAisText(text: string): AisStatement {
  const rawLines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  const all = rawLines.join("\n");

  if (!/annual information statement/i.test(all)) {
    throw new Refusal(
      "That PDF opened, but it is not an Annual Information Statement — nothing was imported. " +
      "Download the AIS as PDF from the e-filing portal (AIS, then Annual Information Statement).",
    );
  }

  // The year. "Financial Year 2025-26", or "Assessment Year 2026-27" a year on.
  let fy: number | null = null;
  const fyMatch = /financial\s+year\s*[:\-]?\s*(\d{4})\s*-\s*(\d{2,4})/i.exec(all);
  if (fyMatch) fy = Number(fyMatch[1]);
  else {
    const ay = /assessment\s+year\s*[:\-]?\s*(\d{4})\s*-\s*(\d{2,4})/i.exec(all);
    if (ay) fy = Number(ay[1]) - 1;
  }
  if (fy === null || !Number.isInteger(fy) || fy < 2000 || fy > 9998) {
    throw new Refusal("That AIS does not say which financial year it is for, so nothing was imported.");
  }

  // The PAN, nearest a "PAN" label first; else the first PAN-shaped token.
  const panLabelled = /\bPAN\b[^A-Z0-9]{0,20}([A-Z]{5}\d{4}[A-Z])\b/.exec(all);
  const pan = panLabelled?.[1] ?? PAN.exec(all)?.[1] ?? null;
  if (!pan) {
    throw new Refusal("That AIS shows no PAN, so whose it is cannot be checked. Nothing was imported.");
  }

  const lines: AisLine[] = [];
  const notRead = new Map<string, number>();
  const unread = (part: string) => notRead.set(part, (notRead.get(part) ?? 0) + 1);

  let section: AisSection | "general" | "unknown" | null = null;
  let part = "Before Part A";
  let current: AisLine | null = null;
  let skippingTcs = false;

  for (const raw of rawLines) {
    const line = raw.trim();
    if (line === "") continue;
    const heading = headingOf(line);
    if (heading) {
      section = heading.section;
      part = heading.part;
      current = null;
      continue;
    }
    // Part A is identity — name, PAN, address. Read for the PAN above and
    // otherwise left alone; nothing in it is a figure.
    if (section === null || section === "general") continue;
    if (isFurniture(line)) continue;

    const cells = line.split(/\s{2,}/).map((c) => c.trim()).filter((c) => c !== "");

    // A detail row under the last information line: a date, then amounts.
    const dateAt = cells.findIndex((c) => DATE.test(c));
    // The dated rows under a TCS line belong to it and are not read either.
    if (skippingTcs && dateAt >= 0) continue;
    skippingTcs = false;
    if (current && dateAt >= 0) {
      const amounts = cells.slice(dateAt + 1).map(amountOf).filter((a): a is Paise => a !== null);
      if (current.section === "tds" && amounts.length >= 2 && isClearlyTds(current)) {
        // [unverified] amount paid/credited, TDS deducted, TDS deposited: the last is what was deposited.
        current.tds = (current.tds + amounts[amounts.length - 1]!) as Paise;
      }
      // An SFT detail row (a reported date, perhaps an account number) is
      // the line above in parts; its total is already on that line.
      continue;
    }

    const main = informationLine(cells);
    // Tax collected at source shares the part with TDS but is not TDS: it is
    // not read (docs/limitations.md), and never summed into the TDS box
    // (review 2). Counted as not read, under its own name.
    if (main && section === "tds" && isTcs(main.code, main.label)) {
      current = null;
      skippingTcs = true;
      unread(TCS_PART);
      continue;
    }
    if (main && (section === "tds" || section === "sft" || section === "other")) {
      const category = categoryOf(main.code, main.label);
      current = {
        section, category, code: main.code, label: main.label, source: main.source,
        amount: main.amount, tds: 0 as Paise,
      };
      lines.push(current);
      continue;
    }

    current = null;
    unread(part);
  }

  return {
    fy, pan, lines,
    notRead: [...notRead].map(([p, n]) => ({ part: p, lines: n })),
  };
}

/**
 * One information line: a serial number, an optional code, the description,
 * the source, a count and an amount — the columns the Handbook names (with
 * "Information Source" and "Information Description"); their order is
 * [unverified].
 */
function informationLine(cells: string[]): {
  code: string | null; label: string; source: string; amount: Paise;
} | null {
  if (cells.length < 4) return null;
  if (!/^\d{1,4}$/.test(cells[0]!)) return null;
  const amount = amountOf(cells[cells.length - 1]!);
  if (amount === null || amount < 0) return null;
  if (!/^\d{1,6}$/.test(cells[cells.length - 2]!)) return null;
  const middle = cells.slice(1, -2);
  let code: string | null = null;
  if (middle.length > 0 && CODE.test(middle[0]!)) code = middle.shift()!.toUpperCase();
  if (middle.length < 2) return null;
  const label = middle[0]!;
  const source = middle.slice(1).join(" ");
  // A label or source that is itself a number is a row of some other shape.
  if (amountOf(label) !== null || amountOf(source) !== null) return null;
  return { code, label, source, amount };
}
