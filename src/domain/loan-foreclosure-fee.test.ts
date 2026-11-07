/**
 * ENG-12 · A foreclosure charge counts in the loan's lifetime fees.
 *
 * Lifetime fees (and so the total cost of borrowing) sum the loan's "charge"
 * rows. A prepayment charge is one; the foreclosure charge was only a bank
 * transaction, so a ₹6,000 charge for closing early never reached the loan's
 * own figures. It is now a charge row too, tied to that transaction — and
 * undoing the close takes the row back, so the transaction can be undone after.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryAll } from "../db/db.ts";
import { historyFor, undoEvent, type Actor } from "../core/events.ts";
import { nowIST, todayIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createLoan, closeLoan, projectLoan } from "./loans.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(10_00_000),
  }).id;
  const charges = createCategory(db, actor, { groupId: createGroup(db, actor, "Fixed").id, name: "Bank charges" }).id;
  const loan = createLoan(db, actor, {
    lender: "Fictional Bank", loanType: "personal", sanctioned: rupees(3_00_000),
    sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 12,
    tenureMonths: 36, currentOutstanding: rupees(3_00_000), repaymentAccountId: bank,
  });
  return { db, bank, charges, loan };
}

test("the foreclosure charge is among the loan's lifetime fees", () => {
  const plain = setup();
  closeLoan(plain.db, actor, { loanId: plain.loan.id, date: todayIST(), settlement: rupees(3_00_000) });
  const without = projectLoan(plain.db, plain.loan.id)!.metrics.totalCostOfBorrowing;

  const { db, bank, charges, loan } = setup();
  closeLoan(db, actor, {
    loanId: loan.id, date: todayIST(), settlement: rupees(3_00_000),
    foreclosureCharge: rupees(6_000), chargeAccountId: bank, chargeCategoryId: charges,
  });
  assert.equal(projectLoan(db, loan.id)!.metrics.totalCostOfBorrowing, without + rupees(6_000));
});

test("undoing the close takes the charge row back, and then the charge itself undoes", () => {
  const { db, bank, charges, loan } = setup();
  closeLoan(db, actor, {
    loanId: loan.id, date: todayIST(), settlement: rupees(3_00_000),
    foreclosureCharge: rupees(6_000), chargeAccountId: bank, chargeCategoryId: charges,
  });
  const close = historyFor(db, "loan", loan.id).find((e) => e.action === "close")!;
  assert.equal(undoEvent(db, close.id, actor).ok, true);
  assert.deepEqual(
    queryAll(db, `SELECT id FROM loan_payments WHERE loan_id = ? AND kind = 'charge'`, loan.id), [],
  );
  const chargeTx = queryAll<{ id: string }>(
    db, `SELECT id FROM transactions WHERE memo LIKE 'Foreclosure charge%' AND deleted_at IS NULL`,
  )[0]!;
  const created = historyFor(db, "transaction", chargeTx.id).find((e) => e.action === "create")!;
  assert.equal(undoEvent(db, created.id, actor).ok, true);
});
