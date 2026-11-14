import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redactString, redactValue } from "./redact.ts";

describe("AI-3 · redaction", () => {
  test("UPI IDs and emails keep only the provider", () => {
    assert.equal(redactString("UPI/ravi.k@okhdfcbank/Groceries"), "UPI/•••@okhdfcbank/Groceries");
    assert.equal(redactString("Paid priya+bills@example.com"), "Paid •••@example.com");
  });

  test("account, card and phone numbers keep the last four digits", () => {
    assert.equal(redactString("A/c 50100234567890"), "A/c ••••7890");
    assert.equal(redactString("Card 4111 1111 1111 1234"), "Card ••••1234");
    assert.equal(redactString("Call +91 98450 12345"), "Call ••••2345");
    assert.equal(redactString("IMPS-412345678901-RENT"), "IMPS-••••8901-RENT");
  });

  test("AI-2 · a number glued to the bank's own letters is masked too", () => {
    // Narrations as banks write them: the reference, phone or UTR runs straight
    // on from a word with no space or slash between.
    assert.equal(redactString("TO TRANSFER-INB IMPS412345678901/RENT"), "TO TRANSFER-INB IMPS••••8901/RENT");
    assert.equal(redactString("UPI-MOB9876543210-PAYMENT"), "UPI-MOB••••3210-PAYMENT");
    assert.equal(redactString("NEFT*HDFC0000123*N123456789012*RAVI"), "NEFT*HDFC0000123*N••••9012*RAVI");
    assert.equal(redactString("ACCT50100234567890XX"), "ACCT••••7890XX");
    assert.equal(redactString("ref_123456789012"), "ref_••••9012");
  });

  test("PAN is masked whole", () => {
    assert.equal(redactString("PAN ABCDE1234F"), "PAN •••••••••• (PAN)");
  });

  test("amounts, dates and short numbers are left alone", () => {
    for (const s of ["₹1,23,456.78", "2026-11-07", "EMI 12 of 240", "Flat 402", "₹45000"]) {
      assert.equal(redactString(s), s);
    }
  });

  // Gaps found 13-11-2026: each of these went to the AI provider whole.
  test("lowercase PAN is masked too", () => {
    assert.equal(redactString("pan abcpe1234f"), "pan •••••••••• (PAN)");
  });

  test("phones written with dots or brackets keep only the last four digits", () => {
    assert.equal(redactString("Call 98765.43210"), "Call ••••3210");
    assert.equal(redactString("Call 987.654.3210"), "Call ••••3210");
    assert.equal(redactString("Call (987) 654-3210"), "Call ••••3210");
    assert.equal(redactString("Office (022) 2345 6789"), "Office ••••6789");
  });

  test("a labelled account, folio, CRN or customer id is masked even when short", () => {
    assert.equal(redactString("acct 1234-5678"), "acct ••••5678");
    assert.equal(redactString("A/c no. 12345678"), "A/c no. ••••5678");
    assert.equal(redactString("Folio 12345678/90"), "Folio ••••7890");
    assert.equal(redactString("CRN 87654321"), "CRN ••••4321");
    assert.equal(redactString("Customer ID: 12345678"), "Customer ID: ••••5678");
  });

  test("amounts and dates survive the wider patterns", () => {
    for (const s of [
      "98,765.43", "98765.43", "₹12,34,567.89", "12345678.90", "₹1,23,45,678.90",
      "13.11.2026", "13-11-2026", "13-11-2026 10:32", "2026-11-13 10:32",
      "account 1234567.89", "Folio total ₹45,000", "ref 12345678", "EMI 12 of 240",
    ]) {
      assert.equal(redactString(s), s, s);
    }
  });

  test("ids, cursors and dates are never touched; numbers stay numbers", () => {
    const out = redactValue({
      id: "123456789012",
      account_id: "123456789012",
      next_cursor: "999999999999",
      date: "2026-11-07",
      amount: 123456789012,
      transactions: [{ payee: "ravi@okicici", memo: "Ref 123456789012" }],
    });
    assert.deepEqual(out, {
      id: "123456789012",
      account_id: "123456789012",
      next_cursor: "999999999999",
      date: "2026-11-07",
      amount: 123456789012,
      transactions: [{ payee: "•••@okicici", memo: "Ref ••••9012" }],
    });
  });
});
