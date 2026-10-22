import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readDocument } from "../pdf/objects.ts";
import { extractText } from "../pdf/text.ts";
import { parseStatementText, detectBank, nonBankDocument } from "./pdf-statements.ts";
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

describe("an Axis Relationship Statement", () => {
  // The bank's name appears nowhere above the table: only the reward-points
  // heading, and the IFSC as a cell under its heading on the line above.
  const head = [
    " ZZ CUSTOMER                                Registered Mobile No: XXXXXX0000",
    " Relationship Statement for the period from: 01-01-2026 to 31-01-2026",
    "Axis eDGE Reward Points Summary",
    " Account No.            Branch          IFSC Code         Balance",
    " 91101XXXXX20000        ZZ BRANCH       UTIB0009999       INR 1,000.00 Cr",
  ];

  test("is recognised as Axis", () => {
    assert.equal(detectBank(head.join("\n"))!.id, "axis");
    assert.equal(detectBank(head.filter((l) => !/eDGE/.test(l)).join("\n"))!.id, "axis");
  });

  test("an IFSC inside a narration still decides nothing", () => {
    assert.equal(detectBank("ZZ FICTIONAL BANK\n  NEFT/UTIB0009999/ZZ PAYEE\n"), null);
  });

  test("a date wrapped from a sentence is not a broken row", () => {
    const result = parseStatementText([
      ...head,
      "Tran Date   Particulars                   Debit         Credit        Balance",
      "            Opening Balance                                           1,000.00",
      "05-01-2026  UPI/ZZ SHOP                     100.00                       900.00",
      "            Closing Balance                                              900.00",
      " This is to certify the interest paid on your account during period 01-01-2026 to",
      " 31-01-2026",
      "12-02-26. For details, visit https://example.invalid/terms",
    ].join("\n"), "axis");
    assert.deepEqual(result.records.map((r) => r.amount), [-10_000]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.reconciliation!.ok, true);
  });
});

describe("a Union Bank loan account's quarterly statement", () => {
  // The Dr marker of each summary balance wraps onto a line of its own, and
  // each interest row's period wraps its end date below the row.
  const text = [
    "STATEMENT OF ACCOUNT FOR THE PERIOD 01-07-2026 TO 30-09-2026",
    " SI       Date                  Particulars                Withdrawal     Deposit       Balance",
    "  1     26-07-2026                 ZZ0000001                                28,000.00   10,72,000.00 Dr",
    "  2     31-07-2026     000000000000018:N Int.:30-06-2026 to   8,000.00                  10,80,000.00 Dr",
    "                                 30-07-2026",
    "     Summary               Total Debits :     8,000.00     Opening Balance :     11,00,000.00",
    "                                                                                            Dr",
    "                               Total Credits :   28,000.00     Closing Balance :     10,80,000.00",
    "                                                                                            Dr",
  ].join("\n");

  test("reconciles, with no rows reported broken", () => {
    const result = parseStatementText(text, "union");
    assert.deepEqual(result.records.map((r) => r.amount), [2_800_000, -800_000]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.reconciliation!.opening, -110_000_000);
    assert.equal(result.reconciliation!.ok, true);
  });
});

describe("an interest row that quotes its own period", () => {
  test("is a row, not a statement period", () => {
    // IndusInd: tested anywhere on the line, "01-07-2025 to 30-09-2025" made
    // this a period, and the statement read nothing at all.
    const result = parseStatementText([
      "  Date     Particulars                       Chq No/Ref No   Withdrawal   Deposit   Balance",
      "01-Jul-2025 Brought Forward                                                          267.00",
      "30-Sep-2025  000000000000:Int.Pd:01-07-2025 to 30-09-2025                    2.00     269.00",
      "30-Sep-2025 Closing Balance                                                          269.00",
    ].join("\n"), "indusind");
    assert.deepEqual(result.records.map((r) => r.amount), [200]);
    assert.deepEqual(result.errors, []);
  });
});

describe("a document from a statement sender that is not a bank statement", () => {
  test("a fund statement naming its payout bank is not that bank's", () => {
    const text = [
      "ZZ FICTIONAL MUTUAL FUND",
      "Folio No. 00000000        Bank Name : AXIS BANK        IFSC Code : UTIB0009999",
      "01-08-2026  Purchase - SIP        5,000.00       12.345      405.0000      12.345",
    ].join("\n");
    assert.equal(detectBank(text), null);
    assert.equal(nonBankDocument(text), "a mutual fund statement");
    const result = parseStatementText(text);
    assert.equal(result.notAStatement, "a mutual fund statement");
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.errors, []);
  });

  test("an exchange's funds and securities balance reads nothing", () => {
    const result = parseStatementText([
      "With reference to NSE circular NSE/INSP/00000 dated December 17, 2020",
      "the funds and securities balances provided are what is maintained with your broker",
      "01-10-2026   ZZ SECURITY      10      1,234.50",
    ].join("\n"));
    assert.ok(result.notAStatement);
    assert.deepEqual(result.errors, []);
  });

  test("a bank statement mentioning a fund in a narration is still read", () => {
    assert.equal(nonBankDocument([
      "ZZ FICTIONAL BANK   Statement of Account",
      "Date        Narration                 Withdrawal      Deposit        Balance",
      "01-08-2026  ACH/ZZ MUTUAL FUND SIP    5,000.00                       1,000.00",
    ].join("\n")), null);
  });
});
