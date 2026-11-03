/**
 * IMP-2 · Which way a card statement's bare-sign figure went.
 *
 * A card prints one amount column and marks the few refunds. Two ways the mark
 * was misread:
 *
 * - "−1,240.00" with the Unicode minus (U+2212) that PDF generators emit. The
 *   CSV reader (`parseAmount`) has long read it as a minus; the PDF reader did
 *   not, so the refund fell through to "a bare figure is a purchase" and
 *   imported as ₹1,240 spent.
 * - A narration that ends in a hyphen ("AMAZON PAY-") before the column gap.
 *   The hyphen was taken for ICICI's refund minus, so a ₹499 purchase imported
 *   as ₹499 back.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseStatementText } from "./pdf-statements.ts";

describe("IMP-2 · card refund signs in PDFs", () => {
  test("a Unicode minus marks a refund, as an ASCII one does", () => {
    const result = parseStatementText(`YES BANK
Date Description Amount
15/02/2026  A PURCHASE    100.00
16/02/2026  A REFUND      −1,240.00`);
    assert.deepEqual(result.records.map((r) => r.amount), [-10_000, 124_000]);
  });

  test("a hyphen at the end of the narration is not a refund minus", () => {
    const result = parseStatementText(`YES BANK
Date Description Amount
16/02/2026  AMAZON PAY-  499.00
17/02/2026  A REFUND     -40.00`);
    assert.deepEqual(result.records.map((r) => r.amount), [-49_900, 4_000]);
  });

  test("HDFC's spaced plus still marks a credit", () => {
    const result = parseStatementText(`HDFC BANK Credit Card
DATE & TIME  TRANSACTION DESCRIPTION  AMOUNT
18/03/2026| 00:00   10% Swiggy Cashback          +  1,500.00`);
    assert.deepEqual(result.records.map((r) => r.amount), [150_000]);
  });
});
