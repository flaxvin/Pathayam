import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseStatementText } from "./pdf-statements.ts";

/*
 * Rows the statement parser only meets once the PDF reader stops splitting
 * words: before glyph widths were read, "Int.Pd:30-06-2026 to 29-09-2026"
 * came out as "I nt. Pd :3 0- 0 6- 2 0 26 to …" and matched nothing.
 */
const ICICI_SAVINGS = [
  "ICICI Bank Limited  IFSC ICIC0001234",
  " DATE       MODE              PARTICULARS                                                    DEPOSITS        WITHDRAWALS               BALANCE",
  " 01-09-2026                    B/F                                                                                                         611.04",
  " 30-09-2026                    000000000001:Int.Pd:30-06-2026 to 29-09-2026                        4.00                                    615.04",
  "                               Total:                                                               4.00                  0.00              615.04",
  " Summary  of TDS/Interest on Fixed Deposits during the period September 01, 2026 - September 30, 2026",
  "  Opening Balance (Cumulative)               704.00                0.00",
  "  Closing Balance (Cumulative)               704.00                0.00",
].join("\n");

describe("statement rows that mention a period", () => {
  test("an interest credit whose narration names its period is still a row", () => {
    const result = parseStatementText(ICICI_SAVINGS, "icici");
    assert.deepEqual(result.records.map((r) => [r.date, r.amount]), [["2026-09-30", 400]]);
  });

  test("a line that opens with a period is still not a row", () => {
    const text = ICICI_SAVINGS.replace(
      " 01-09-2026                    B/F",
      " 15/02/2026 To 14/03/2026      Credit Limit: Rs. 3,00,000.00\n 01-09-2026                    B/F",
    );
    assert.equal(parseStatementText(text, "icici").records.length, 1);
  });
});

describe("the closing balance a statement reconciles to", () => {
  test("ICICI's cumulative TDS summary is not the account's closing balance", () => {
    // With it read as the closing balance, a correct parse reported a ₹615.04
    // discrepancy; with no account closing line at all, there is nothing to check.
    assert.equal(parseStatementText(ICICI_SAVINGS, "icici").reconciliation, null);
  });
});
