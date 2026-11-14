/**
 * TAX-AIS · Synthetic Annual Information Statements, for tests.
 *
 * Invented names, an invented PAN and invented figures, laid out the way
 * `src/import/ais.ts` reads (that layout is itself [unverified] against a real
 * AIS — see the module header). No real statement is, or should be, in the
 * repository.
 *
 * `aisPdf` writes the text as a one-page PDF, one text run per column, so a
 * test goes through the real chain: decrypt → extract → parse. With a
 * password it is encrypted with the standard security handler, RC4 128-bit,
 * revision 3 (PDF 1.7 §7.6.3, Algorithms 2, 3 and 5) — the reader's decryptor
 * is tested against qpdf's output elsewhere (src/pdf/reader.test.ts), so this
 * encryptor only has to produce a file, not prove the decryptor.
 */

import { createHash } from "node:crypto";
import { rc4 } from "../pdf/rc4.ts";

/** Not a real PAN or person. */
export const AIS_PAN = "ABCDE1234F";
export const AIS_DOB = "01011980";
/** The department's PDF rule: PAN lower case + DDMMYYYY. */
export const AIS_PASSWORD = "abcde1234f01011980";

/** Columns of one line, placed at fixed x positions so the extractor sees gaps. */
export type Cols = string[];

const X = [20, 50, 110, 300, 450, 500, 540];

const MASTER: Cols = ["SR. NO.", "INFORMATION CODE", "INFORMATION DESCRIPTION", "INFORMATION SOURCE", "COUNT", "AMOUNT"];
const TDS_DETAIL: Cols = ["SR. NO.", "QUARTER", "DATE OF PAYMENT/CREDIT", "AMOUNT PAID/CREDITED", "TDS DEDUCTED", "TDS DEPOSITED", "STATUS"];
const SFT_DETAIL: Cols = ["SR. NO.", "REPORTED ON", "ACCOUNT NUMBER", "ACCOUNT TYPE", "INTEREST AMOUNT", "STATUS"];

/**
 * An AIS for FY 2025-26 with one line of every category the reader models.
 *
 * The layout copies a real AIS (seen 14-11-2026: headings, column headers,
 * category headings, detail tables, the page band and footer); every name,
 * number and figure in it is invented.
 */
export function sampleAis(opts: { pan?: string; fy?: string; extra?: Cols[]; taxYear?: boolean } = {}): (string | Cols)[] {
  const pan = opts.pan ?? AIS_PAN;
  const fy = opts.fy ?? "2025-26";
  const year = opts.taxYear ? `Tax Year (T .Y .) ${fy}` : `Financial Year ${fy}`;
  return [
    `Annual Information Statement (AIS - Form 168)    ${year}`,
    "Part A - General Information",
    ["Permanent Account Number (PAN)", "Aadhaar Number", "Name of Assessee"],
    [pan, "XXXX XXXX 0000", "TEST PERSON"],
    ["Date of Birth", "Mobile Number", "E-mail Address"],
    ["01/01/1980", "9000000000", "TEST@EXAMPLE.IN"],
    "Address",
    "1 EXAMPLE ROAD, NOWHERE, 000000",
    "---------- Annual Information Statement (Part B) ----------",
    "(All amount values are in INR)",
    "Part B1-Information relating to tax deducted or collected at source",
    "Salary",
    MASTER,
    ["1", "TDS-192", "Salary received (Section 192)", "EXAMPLE SOFTWARE LTD (BLRE00000A)", "4", "12,00,000"],
    TDS_DETAIL,
    ["1", "Q4(Jan-Mar)", "15/03/2026", "3,00,000", "20,000", "20,000", "Active"],
    ["2", "Q3(Oct-Dec)", "15/12/2025", "3,00,000", "20,000", "20,000", "Active"],
    ["3", "Q2(Jul-Sep)", "15/09/2025", "3,00,000", "20,000", "20,000", "Active"],
    ["4", "Q1(Apr-Jun)", "15/06/2025", "3,00,000", "20,000", "20,000", "Active"],
    "Interest from deposit",
    MASTER,
    ["2", "TDS-194A", "Interest other than \"Interest on Securities\"", "SAMPLE BANK (MUMS00000B)", "1", "50,000"],
    "(Section 194A)",
    TDS_DETAIL,
    ["1", "Q3(Oct-Dec)", "31/12/2025", "50,000", "5,000", "5,000", "Active"],
    "Dividend",
    MASTER,
    ["3", "TDS-194", "Dividend (Section 194)", "EXAMPLE INDUSTRIES LTD (MUME00000C)", "1", "8,000"],
    TDS_DETAIL,
    ["1", "Q2(Jul-Sep)", "10/08/2025", "8,000", "800", "800", "Active"],
    "Note - If there is variation between the TDS/TCS information as displayed in Form26AS on TRACES portal, and the",
    "information displayed on TRACES portal for the purpose of filing of tax return.",
    "Part B2-Information relating to specified financial transaction (SFT)",
    "Interest from savings bank",
    MASTER,
    ["1", "SFT-016(SB)", "Interest income (SFT-016) - Savings", "SAMPLE BANK (AAAAA0000A.AB000)", "1", "4,200"],
    SFT_DETAIL,
    ["1", "28/05/2026", "000000000000", "Saving", "4,200", "Active"],
    "Download ID : ABCDE1234F000000000000",
    "Generation Date : 01/06/2026, 10:00:00                          Page 1 of 2",
    ["PAN", "Name", "Financial Year"],
    [pan, "TEST PERSON", fy],
    "Interest from deposit",
    MASTER,
    ["2", "SFT-016(TD)", "Interest income (SFT-016) - Term Deposit", "SAMPLE BANK (AAAAA0000A.AB000)", "1", "48,000"],
    SFT_DETAIL,
    ["1", "28/05/2026", "000000000001", "Time Deposit", "48,000", "Active"],
    "Dividend",
    MASTER,
    ["3", "SFT-015", "Dividend income (SFT-015)", "EXAMPLE INDUSTRIES LTD (AAAAA0000B.AB001)", "1", "8,000"],
    "Sale of securities and units of mutual fund",
    MASTER,
    ["4", "SFT-17-OTU(M)", "Sale of other unit (Depository)", "EXAMPLE DEPOSITORY", "3", "2,50,000.00"],
    "(AAAAA0000CMUMC00000A)",
    ["SR. NO.", "DATE OF SALE/TRANSFER", "SECURITY NAME (SECURITY CODE)", "SECURITY CLASS", "QUANTITY", "SALES CONSIDERATION", "STATUS"],
    ["1", "16/03/2026", "EXAMPLE FUND-DIRECT-GROWTH", "Other Units", "1,000", "2,50,000", "Active"],
    "Rent received",
    MASTER,
    ["5", "SFT-004", "Rent received (SFT-004)", "SOMEONE ELSE", "1", "60,000"],
    ...(opts.extra ?? []),
    "Part B7-Any other information in relation to sub-rule (2) of rule 114-I",
    "Salary",
    MASTER,
    ["1", "TDS-Ann.II-SAL", "Salary (TDS Annexure II)", "EXAMPLE SOFTWARE LTD (BLRE00000A)", "1", "12,00,000"],
    ["SR. NO.", "EMPLOYMENT START DATE", "EMPLOYMENT END DATE", "GROSS SALARY U/S 17(1)", "GROSS SALARY", "STATUS"],
    ["1", "01/04/2025", "31/03/2026", "12,00,000", "12,00,000", "Active"],
    "Part B3-Information relating to payment of taxes",
    ["SR. NO.", "FINANCIAL YEAR", "MAJOR HEAD", "MINOR HEAD", "TAX (A)", "TOTAL", "DATE OF DEPOSIT"],
    ["1", fy, "Income Tax", "Advance Tax", "10,000", "10,000", "15/09/2025"],
    "Part B4-Information relating to demand and refund",
    "Refund",
    ["SR. NO.", "FINANCIAL YEAR", "MODE", "NATURE OF REFUND", "REFUND AMOUNT", "DATE OF PAYMENT"],
    "No Transactions Present",
    "Download ID : ABCDE1234F000000000000",
    "Generation Date : 01/06/2026, 10:00:00                          Page 2 of 2",
  ];
}

/** The text a PDF of these lines extracts to, for parser tests without a PDF. */
export function aisText(lines: (string | Cols)[]): string {
  return lines.map((l) => (typeof l === "string" ? l : l.filter((c) => c !== "").join("    "))).join("\n");
}

const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

export function aisPdf(lines: (string | Cols)[], password?: string): Uint8Array {
  const content = lines.map((line, i) => {
    const y = 820 - i * 12;
    if (typeof line === "string") return `BT /F1 8 Tf 1 0 0 1 20 ${y} Tm (${escape(line)}) Tj ET`;
    return line.map((cell, c) => cell === "" ? "" :
      `BT /F1 8 Tf 1 0 0 1 ${X[c] ?? 20 + c * 80} ${y} Tm (${escape(cell)}) Tj ET`).filter(Boolean).join("\n");
  }).join("\n");

  const id = createHash("md5").update("synthetic-ais").digest();
  const enc = password === undefined ? null : encryption(password, new Uint8Array(id));
  const streamBytes = enc ? rc4(objectKey(enc.key, 4), Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");

  const objects: (string | { dict: string; data: Uint8Array })[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    { dict: `<< /Length ${streamBytes.length} >>`, data: streamBytes },
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  if (enc) {
    objects.push(`<< /Filter /Standard /V 2 /R 3 /Length 128 /P -4 /O <${hex(enc.o)}> /U <${hex(enc.u)}> >>`);
  }

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  let length = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(length);
    const chunk = typeof o === "string"
      ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, "latin1")
      : Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`, "latin1"),
        Buffer.from(o.data),
        Buffer.from("\nendstream\nendobj\n", "latin1"),
      ]);
    parts.push(chunk);
    length += chunk.length;
  });
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) tail += `${String(at).padStart(10, "0")} 00000 n \n`;
  tail += `trailer << /Size ${objects.length + 1} /Root 1 0 R` +
    (enc ? ` /Encrypt ${objects.length} 0 R /ID [<${hex(new Uint8Array(id))}> <${hex(new Uint8Array(id))}>]` : "") +
    ` >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(tail, "latin1"));
  return new Uint8Array(Buffer.concat(parts));
}

// --- The standard security handler, R3, 128-bit -------------------------------------

const PAD = Buffer.from(
  "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex",
);

function padded(password: string): Buffer {
  const p = Buffer.from(password, "latin1").subarray(0, 32);
  return Buffer.concat([p, PAD.subarray(0, 32 - p.length)]);
}

const md5 = (...parts: Uint8Array[]) => {
  const h = createHash("md5");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

function xorKey(key: Uint8Array, i: number): Uint8Array {
  return key.map((b) => b ^ i);
}

function encryption(password: string, id: Uint8Array): { key: Uint8Array; o: Uint8Array; u: Uint8Array } {
  // Algorithm 3: /O, with the owner password the same as the user's.
  let ok = md5(padded(password));
  for (let i = 0; i < 50; i++) ok = md5(ok);
  let o: Uint8Array = rc4(ok, padded(password));
  for (let i = 1; i <= 19; i++) o = rc4(xorKey(ok, i), o);

  // Algorithm 2: the file key.
  const p = Buffer.alloc(4);
  p.writeInt32LE(-4);
  let key = md5(padded(password), o, p, id);
  for (let i = 0; i < 50; i++) key = md5(key);

  // Algorithm 5: /U.
  let u: Uint8Array = rc4(key, md5(PAD, id));
  for (let i = 1; i <= 19; i++) u = rc4(xorKey(key, i), u);
  return { key, o, u: new Uint8Array([...u, ...new Uint8Array(16)]) };
}

function objectKey(key: Uint8Array, num: number): Uint8Array {
  return md5(key, new Uint8Array([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, 0, 0]));
}

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}
