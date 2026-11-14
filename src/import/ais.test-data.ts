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

/** An AIS for FY 2025-26 with one line of every category the reader models. */
export function sampleAis(opts: { pan?: string; fy?: string; extra?: Cols[] } = {}): (string | Cols)[] {
  const pan = opts.pan ?? AIS_PAN;
  const fy = opts.fy ?? "2025-26";
  return [
    "Annual Information Statement (AIS)",
    `Financial Year ${fy}`,
    "Part A - General Information",
    ["PAN", pan],
    ["Name", "TEST PERSON"],
    ["Address", "1 EXAMPLE ROAD, NOWHERE 000000"],
    "Part B1 - TDS/TCS Information",
    ["SR. NO.", "INFORMATION CODE", "INFORMATION DESCRIPTION", "INFORMATION SOURCE", "COUNT", "AMOUNT"],
    ["1", "TDS-192", "Salary received (Section 192)", "EXAMPLE SOFTWARE LTD (BLRE00000A)", "4", "12,00,000.00"],
    ["", "Q1", "15/06/2025", "3,00,000.00", "20,000.00", "20,000.00"],
    ["", "Q2", "15/09/2025", "3,00,000.00", "20,000.00", "20,000.00"],
    ["", "Q3", "15/12/2025", "3,00,000.00", "20,000.00", "20,000.00"],
    ["", "Q4", "15/03/2026", "3,00,000.00", "20,000.00", "20,000.00"],
    ["2", "TDS-194A", "Interest other than Interest on securities", "SAMPLE BANK (MUMS00000B)", "1", "50,000.00"],
    ["", "Q3", "31/12/2025", "50,000.00", "5,000.00", "5,000.00"],
    ["3", "TDS-194", "Dividend", "EXAMPLE INDUSTRIES LTD (MUME00000C)", "1", "8,000.00"],
    ["", "Q2", "10/08/2025", "8,000.00", "800.00", "800.00"],
    "Part B2 - SFT Information",
    ["SR. NO.", "INFORMATION CODE", "INFORMATION DESCRIPTION", "INFORMATION SOURCE", "COUNT", "AMOUNT"],
    ["1", "SFT-016(SB)", "Interest from savings bank", "SAMPLE BANK", "1", "4,200.00"],
    ["2", "SFT-016(TD)", "Interest from deposit", "SAMPLE BANK", "1", "48,000.00"],
    ["3", "SFT-015", "Dividend", "EXAMPLE INDUSTRIES LTD", "1", "8,000.00"],
    ["4", "SFT-017", "Sale of securities and units of mutual fund", "EXAMPLE DEPOSITORY", "3", "2,50,000.00"],
    ["5", "SFT-004", "Rent received", "SOMEONE ELSE", "1", "60,000.00"],
    ...(opts.extra ?? []),
    "Part B3 - Payment of Taxes",
    ["1", "Advance tax", "BSR 0000000", "15/09/2025", "10,000.00"],
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
