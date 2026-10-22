import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readDocument } from "../pdf/objects.ts";
import { extractText } from "../pdf/text.ts";
import { parseStatementText, detectBank } from "./pdf-statements.ts";
import { passwordCandidates } from "./statement-passwords.ts";

/**
 * Failures found by running every importer over three years of one
 * household's statement emails (22-10-2026). The files themselves stay out of
 * the repository; each test rebuilds the shape that broke, with invented
 * names and figures.
 */

/** Not a real identity — the shape is what matters. */
const IDENTITY = { name: "Ravi Kumar", pan: "ABCDE1234F", dob: "01011970", mobile: null };

/** A one-page PDF whose content stream is `content`, with one simple font. */
function pdf(content: string): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) body += `${String(at).padStart(10, "0")} 00000 n \n`;
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}

describe("a statement laid out thousands of columns wide", () => {
  /*
   * Standard Chartered's card statement sets a one-point font and scales it
   * with the text matrix, so the page came out ten thousand columns wide. Two
   * regular expressions that restart inside every run of padding turned that
   * into a hang: thirty seconds to extract, and the parse never finished.
   */
  test("extracts in moments", () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(`BT /F1 1 Tf 1 0 0 1 0 ${800 - i * 3} Tm (ZZ LEFT) Tj ` +
        `1 0 0 1 20000 ${800 - i * 3} Tm (RIGHT) Tj ` +
        `1 0 0 1 40000 ${800 - i * 3} Tm (END) Tj ET`);
    }
    const started = Date.now();
    const text = extractText(readDocument(pdf(lines.join("\n"))));
    assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
    assert.match(text, /ZZ LEFT\s+RIGHT\s+END/);
  });

  test("parses in moments", () => {
    const wide = " ".repeat(20_000);
    const text = Array.from({ length: 300 }, (_, i) =>
      `ZZ CARD TERMS${wide}clause ${i}${wide}more words${wide}1,234.00`).join("\n");
    const started = Date.now();
    parseStatementText(text);
    assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
  });
});

describe("Standard Chartered", () => {
  test("is recognised from its letterhead", () => {
    assert.equal(detectBank("Credit Card Statement\nStandard Chartered Bank\nStatement Date : 11 Jan 2026")!.id, "sc");
  });

  test("its password — name in capitals and DDMMYY — is tried first", () => {
    // Quoted from its email: "first 4 letters of your name as embossed on your
    // credit card, followed by your date of birth … DDMMYY … in uppercase".
    assert.equal(passwordCandidates(IDENTITY, "sc")[1], "RAVI010170");
  });
});
