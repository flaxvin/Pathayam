/**
 * W18-UI-1 · A loan that has not been drawn yet is not "paid off".
 *
 * Add a car loan without "what you owe today" (the dealer has not been paid
 * yet), and its page opened with a green "This is paid off. Closing it files
 * it away" and a Close it button — on a loan created seconds earlier. The
 * notice tested only `outstanding <= 0`, and an undrawn loan owes nothing yet.
 * Paid off means something was borrowed and has all been repaid.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createLoan, recordPrepayment } from "../domain/loans.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";

const meera: Actor = { memberId: "m-meera", source: "ui" };

function setup() {
  const db = freshDb();
  seedMember(db, "m-meera", "Meera");
  const bank = createAccount(db, meera, {
    name: "Savings", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(20_00_000) as Paise,
  }).id;
  return { db, bank };
}

describe("W18-UI-1 · the paid-off notice on a loan's page", () => {
  test("a loan with nothing drawn yet is not called paid off", async () => {
    const { db, bank } = setup();
    const loan = createLoan(db, meera, {
      lender: "Fictional Car Loans", loanType: "car", sanctioned: rupees(7_50_000) as Paise,
      sanctionDate: "2026-11-01", interestModel: "reducing", annualRatePct: 9.15, tenureMonths: 60,
      repaymentAccountId: bank,
    });
    const app = await startTestApp(db, { memberId: "m-meera" });
    try {
      const page = await (await app.get(`/loans/${loan.id}`)).text();
      assert.match(page, /undrawn/i, "the page is the loan's, with its undrawn sanction");
      assert.doesNotMatch(page, /This is paid off/);
      assert.doesNotMatch(page, new RegExp(`action="/loans/${loan.id}/close"`));
    } finally { await app.close(); }
  });

  test("a loan repaid in full still offers to close", async () => {
    const { db, bank } = setup();
    const loan = createLoan(db, meera, {
      lender: "Fictional Bank", loanType: "personal", sanctioned: rupees(1_00_000) as Paise,
      sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 12, tenureMonths: 12,
      currentOutstanding: rupees(1_00_000) as Paise, repaymentAccountId: bank,
    });
    recordPrepayment(db, meera, {
      loanId: loan.id, date: "2026-01-01", amount: rupees(1_00_000) as Paise, mode: "tenure", fromAccountId: bank,
    });
    const app = await startTestApp(db, { memberId: "m-meera" });
    try {
      const page = await (await app.get(`/loans/${loan.id}`)).text();
      assert.match(page, /This is paid off/);
    } finally { await app.close(); }
  });
});
