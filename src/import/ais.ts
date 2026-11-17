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
 * ## The layout (checked 14-11-2026)
 *
 * Built first from the Handbook alone, then checked and corrected against
 * real statements for 2024-25, 2025-26 and 2026-27 (seen in the session that
 * wrote this, never stored): numbered part headings, a category heading above
 * each table, an information line (serial, code, description, source, count,
 * amount) with its own header row and a detail table under it, a repeated
 * page band carrying the PAN, name and year, and from 2026-27 a "Tax Year
 * (T.Y.)" heading and Income-tax Act, 2025 codes. Those statements were saved
 * through a browser; the portal's own download may place text differently
 * [inferred]. A line of any other shape is counted as not read, never guessed.
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
// Codes as printed: TDS-192, SFT-016(SB), SFT-17-OTU(M), TDS-Ann.II-SAL, and the
// Income-tax Act, 2025's TDS-393(1)[Table: S.No. 5(ii) & 5(iii)], which has spaces.
const CODE = /^(?:TDS|TCS|SFT)-\S.*$/i;
const AMOUNT = /^-?[\d,]+(?:\.\d{1,2})?$/;
const DATE = /^\d{2}[-/](?:\d{2}|[A-Za-z]{3})[-/]\d{4}$/;

function amountOf(cell: string): Paise | null {
  const t = cell.replace(/^(?:Rs\.?|₹|INR)\s*/i, "").trim();
  if (!AMOUNT.test(t) || !/\d/.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) as Paise;
}

/**
 * A part heading. A real AIS (checked against statements for 2024-25, 2025-26
 * and 2026-27, 14-11-2026) prints them as "Part A - General Information",
 * "Part B1-Information relating to tax deducted or collected at source",
 * "Part B2-Information relating to specified financial transaction (SFT)",
 * "Part B3-Information relating to payment of taxes", "Part B4-Information
 * relating to demand and refund" and "Part B7-Any other information in
 * relation to sub-rule (2) of rule 114-I". The words decide; the number only
 * when the words are new. The Handbook's shorter names ("TDS/TCS
 * Information", "SFT Information"…) are still recognised.
 */
function headingOf(line: string): { part: string; section: AisSection | "general" | "unknown" } | null {
  // Ligatures (fi, ffi) do not survive text extraction; "specified" can come out as "speci?ed".
  const t = line.trim().replace(/\s+/g, " ").toLowerCase();
  const numbered = /^part\s*(a|b\d*)\s*[-–:]/.exec(t);
  const bare = !numbered && t.length <= 60;
  if (!numbered && !bare) return null;
  const body = numbered ? t.slice(numbered[0].length) : t;
  const known = (re: RegExp) => re.test(body) && (numbered !== null || new RegExp("^" + re.source).test(body));
  if (known(/general information/)) return { part: "General information", section: "general" };
  if (known(/tds\s*\/\s*tcs information|tax deducted or collected at source/)) return { part: "TDS/TCS information", section: "tds" };
  if (known(/sft information|\(sft\)|financial transaction/)) return { part: "SFT information", section: "sft" };
  if (known(/payment of taxes/)) return { part: "Payment of taxes", section: "taxes-paid" };
  if (known(/demand and refund/)) return { part: "Demand and refund", section: "demand-refund" };
  if (known(/other information/)) return { part: "Other information", section: "other" };
  // A part this does not know — a new one the department adds. Its lines are
  // not read into the part before it; they are counted as not read.
  if (numbered) return { part: "A part this app does not know", section: "unknown" };
  return null;
}

/**
 * The Handbook's category headings, which a real AIS prints on a line of
 * their own above the information lines they cover ("Salary", "Interest from
 * savings bank", "Sale of securities and units of mutual fund"…). They are a
 * better guide than the description: SFT-016's description is "Interest
 * income (SFT-016) - Savings", which says neither "savings bank" nor
 * "deposit" plainly.
 */
const SUBHEADINGS: readonly [RegExp, AisCategory][] = [
  [/^salary$/, "salary"],
  [/^dividend$/, "dividend"],
  [/^interest from savings bank$/, "interest-savings"],
  [/^interest from deposits?$/, "interest-deposit"],
  [/^interest from others?$/, "interest-other"],
  [/^sale of securities and units of mutual funds?$/, "securities-sale"],
];

/** A category heading line: words only, no figures, starting at the margin. */
function subheadingOf(raw: string): string | null {
  if (/^\s/.test(raw)) return null;
  const t = raw.trim().replace(/\s+/g, " ");
  if (t.length > 80 || /\d/.test(t) || /^(?:part\b|note\b|download id|generation date)/i.test(t)) return null;
  if (!/^[A-Za-z][A-Za-z ,/&()'-]*$/.test(t)) return null;
  return t;
}

/**
 * The category, from the description first (the Handbook's own words) and
 * the code second. Section 192 is salary (Handbook §4.1) and 194 dividend
 * (§4.3). The Handbook files 194A deductions under "Interest from deposit"
 * (§4.5) alongside SFT-016's term and recurring deposit interest, so a 194A
 * line is deposit interest here too — which is what lets the summary keep the
 * higher of a bank's two reports of the same interest instead of adding both.
 */
export function categoryOf(code: string | null, label: string, subheading: string | null = null): AisCategory {
  const h = (subheading ?? "").toLowerCase().replace(/\s+/g, " ");
  for (const [re, category] of SUBHEADINGS) if (re.test(h)) return category;
  const d = label.toLowerCase();
  const c = (code ?? "").toUpperCase();
  if (/^SFT-016\s*\(SB\)/.test(c)) return "interest-savings";
  if (/^SFT-016\s*\((?:TD|RD)\)/.test(c)) return "interest-deposit";
  if (/sale of securities|units of mutual fund/.test(d) && /sale/.test(d)) return "securities-sale";
  if (/purchase/.test(d)) return "unread";
  if (/\bsalary\b/.test(d) || c === "TDS-192") return "salary";
  if (/interest from savings bank|savings bank interest|interest on savings/.test(d)) return "interest-savings";
  if (/interest from deposit|interest on (?:time|term|fixed|recurring) deposit/.test(d) || c === "TDS-194A") {
    return "interest-deposit";
  }
  if (/\binterest\b/.test(d) || c === "TDS-193") return "interest-other";
  if (/\bdividend\b/.test(d) || c === "TDS-194" || c === "SFT-015") return "dividend";
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
  const rawLines = text.split("\n").map((l) => l.trimEnd());
  const all = rawLines.join("\n");

  if (!/annual information statement/i.test(all)) {
    throw new Refusal(
      "That PDF opened, but it is not an Annual Information Statement — nothing was imported. " +
      "Download the AIS as PDF from the e-filing portal (AIS, then Annual Information Statement).",
    );
  }

  const fy = yearOf(rawLines);
  if (fy === null) {
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
  let subheading: string | null = null;
  /** The information line the rows below belong to. */
  let current: AisLine | null = null;
  /** Where the description and source columns start, from the header row. */
  let columns: { description: number; source: number } | null = null;
  /** Inside the detail table under an information line (after its own header row). */
  let inDetail = false;
  /** Whether the detail table's last amount is the TDS deposited. */
  let detailIsTds = false;
  let skippingTcs = false;
  let pageHeader = false;

  for (const raw of rawLines) {
    const line = raw.trim();
    if (line === "") continue;

    // Page furniture: the repeated "PAN / Name / Financial Year" band, whose
    // next line is the PAN, the person's name and the year; the footer.
    if (pageHeader) { pageHeader = false; continue; }
    if (/^PAN\s{2,}Name\s{2,}(?:Financial|Tax)\s+Year/i.test(line)) { pageHeader = true; continue; }
    if (/^(?:download id|generation date)\s*:/i.test(line)) continue;
    if (/^note\s*-/i.test(line) || /no transactions present/i.test(line)) { current = null; inDetail = false; continue; }

    const heading = headingOf(line);
    if (heading) {
      section = heading.section;
      part = heading.part;
      current = null; subheading = null; inDetail = false; skippingTcs = false;
      continue;
    }
    // Part A is identity — name, PAN, address. Read for the PAN above and
    // otherwise left alone; nothing in it is a figure.
    if (section === null || section === "general") continue;

    // The header row of an information table, or of the detail under one.
    if (/^SR\.?\s*NO\.?\b/i.test(line) || /^SR\.\s/i.test(line)) {
      if (/INFORMATION\s+CODE/i.test(line)) {
        const d = raw.search(/INFORMATION\s+DESCRIPTION/i);
        const src = raw.search(/INFORMATION\s+SOURCE/i);
        columns = d > 0 && src > d ? { description: d, source: src } : null;
        inDetail = false;
        current = null;
      } else {
        inDetail = true;
        detailIsTds = /TDS\s+DEPOSITED/i.test(line);
      }
      skippingTcs = skippingTcs && !/INFORMATION\s+CODE/i.test(line);
      continue;
    }
    if (isFurniture(line) && !/^\d/.test(line)) continue;

    const sub = subheadingOf(raw);
    if (sub !== null && !/^\d/.test(line)) {
      subheading = sub;
      current = null; inDetail = false; skippingTcs = false;
      continue;
    }

    const serial = /^\d{1,4}\s/.test(line);
    if (!serial) {
      // A wrapped cell — the rest of a description, a source's identifier, a
      // security's name. Part of the row above; never a figure of its own.
      if (current && !inDetail && columns && raw.search(/\S/) >= columns.source - 2) {
        current.source = cleanSource(`${current.source} ${line}`);
      }
      continue;
    }

    if (section === "taxes-paid" || section === "demand-refund" || section === "unknown") {
      if (!inDetail || section !== "unknown") unread(part);
      continue;
    }

    if (inDetail) {
      if (skippingTcs || !current) continue;
      const cells = line.split(/\s{2,}/).map((c) => c.trim()).filter((c) => c !== "");
      if (current.section === "tds" && detailIsTds && isClearlyTds(current)) {
        const status = cells[cells.length - 1]!;
        // [inferred] Only an "Active" row counts; the portal marks rows the
        // taxpayer has disputed or the deductor has revised otherwise.
        if (/^[A-Za-z]+$/.test(status) && !/^active$/i.test(status)) continue;
        const amounts = cells.slice(1).map(amountOf).filter((a): a is Paise => a !== null);
        // Amount paid/credited, TDS deducted, TDS deposited: the last is what was deposited.
        if (amounts.length >= 2) current.tds = (current.tds + amounts[amounts.length - 1]!) as Paise;
      }
      // An SFT or Part B7 detail row (an account, a client ID, a sale) is the
      // line above in parts; its total is already on that line.
      continue;
    }

    const main = informationLine(raw, columns);
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
      skippingTcs = false;
      const category = categoryOf(main.code, main.label, subheading);
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
 * The year the statement is for. A real AIS heads its first page "Financial
 * Year 2024-25", or from 2026-27, under the Income-tax Act, 2025, "Tax Year
 * (T.Y.) 2026-27" (a tax year is the financial year, s3 of that Act); its
 * later pages repeat it in a band whose figures sit on the next line. Only
 * the heading and that band are read: the body's notes mention other years
 * ("For financial year 2022-23 and earlier…"), which must not be taken.
 */
function yearOf(rawLines: string[]): number | null {
  const head = rawLines.slice(0, 3).join(" ");
  const named = /(?:financial\s+year|tax\s+year\s*\(\s*t\s*\.\s*y\s*\.?\s*\))\s*[:\-]?\s*(\d{4})\s*-\s*(\d{2,4})/i.exec(head)
    ?? /\b(?:financial|tax)\s+year\s*[:\-]?\s*(\d{4})\s*-\s*(\d{2,4})/i.exec(head);
  let fy: number | null = named ? Number(named[1]) : null;
  if (fy === null) {
    const ay = /assessment\s+year\s*[:\-]?\s*(\d{4})\s*-\s*(\d{2,4})/i.exec(head);
    if (ay) fy = Number(ay[1]) - 1;
  }
  if (fy === null) {
    for (let i = 0; i + 1 < rawLines.length; i++) {
      if (/(?:financial|tax)\s+year\s*$/i.test(rawLines[i]!.trim())) {
        const m = /(\d{4})\s*-\s*(\d{2,4})\s*$/.exec(rawLines[i + 1]!.trim());
        if (m) { fy = Number(m[1]); break; }
      }
    }
  }
  if (fy === null || !Number.isInteger(fy) || fy < 2000 || fy > 9998) return null;
  return fy;
}

/**
 * A source's name without its identifier: "HDFC BANK LIMITED (MUMH03189E)"
 * is a TAN, "(AAACH2702H.AB772)" a reporting entity's PAN and registration.
 * Neither is the person's, but neither is needed, and both stay out.
 */
function cleanSource(source: string): string {
  return source.replace(/\s*\((?=[A-Z0-9.]*\d)[A-Z0-9.]{8,}\)/g, "").replace(/\s+/g, " ").trim();
}

/**
 * One information line: a serial number, a code, the description, the
 * source, a count and an amount — the columns of a real AIS (checked
 * 14-11-2026). Cells are split on runs of spaces; where a long description
 * runs into the source with a single space, the header's column positions
 * decide, falling back on the source being the upper-case name that ends the
 * run ("… received EXAMPLE JEWELLERS LIMITED").
 */
function informationLine(raw: string, columns: { description: number; source: number } | null): {
  code: string | null; label: string; source: string; amount: Paise;
} | null {
  const cells = raw.trim().split(/\s{2,}/).map((c) => c.trim()).filter((c) => c !== "");
  if (cells.length < 4) return null;
  if (!/^\d{1,4}$/.test(cells[0]!)) return null;
  const amount = amountOf(cells[cells.length - 1]!);
  if (amount === null || amount < 0) return null;
  if (!/^\d{1,6}$/.test(cells[cells.length - 2]!)) return null;
  const middle = cells.slice(1, -2);
  let code: string | null = null;
  if (middle.length > 0 && CODE.test(middle[0]!)) code = middle.shift()!.replace(/\s+/g, " ").toUpperCase();
  let label: string;
  let source: string;
  if (middle.length >= 2) {
    label = middle[0]!;
    source = middle.slice(1).join(" ");
  } else if (middle.length === 1) {
    const split = splitRun(middle[0]!, raw, columns);
    if (!split) return null;
    [label, source] = split;
  } else return null;
  source = cleanSource(source);
  // A label or source that is itself a number is a row of some other shape.
  if (source === "" || amountOf(label) !== null || amountOf(source) !== null) return null;
  return { code, label, source, amount };
}

/** Split a description that ran into its source. */
function splitRun(run: string, raw: string, columns: { description: number; source: number } | null): [string, string] | null {
  const words = run.split(" ");
  // The source is the longest upper-case tail ("EXAMPLE JEWELLERS LIMITED (BLRE00000Z)").
  let i = words.length;
  while (i > 0 && !/[a-z]/.test(words[i - 1]!)) i--;
  if (i > 0 && i < words.length && words.slice(i).some((w) => /[A-Z]{2}/.test(w))) {
    return [words.slice(0, i).join(" "), words.slice(i).join(" ")];
  }
  if (columns) {
    const at = raw.indexOf(run);
    const cut = columns.source - at;
    if (cut > 0 && cut < run.length) {
      const sp = run.lastIndexOf(" ", cut);
      if (sp > 0) return [run.slice(0, sp).trim(), run.slice(sp + 1).trim()];
    }
  }
  return null;
}
