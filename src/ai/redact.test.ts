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

  test("PAN is masked whole", () => {
    assert.equal(redactString("PAN ABCDE1234F"), "PAN •••••••••• (PAN)");
  });

  test("amounts, dates and short numbers are left alone", () => {
    for (const s of ["₹1,23,456.78", "2026-11-07", "EMI 12 of 240", "Flat 402", "₹45000"]) {
      assert.equal(redactString(s), s);
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
