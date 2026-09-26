/**
 * WEALTH-16 · The loan account's balance is what is still owed.
 *
 * Every instalment credited the loan's tracking account with the whole amount
 * paid, interest included, while the outstanding fell by the principal alone.
 * With the auditor's figures: ₹10,00,000 at 9% over 240 months, one EMI of
 * ₹8,997.26 paid from the bank. The schedule said ₹9,98,502.74 owed; the loan
 * account said ₹9,91,002.74, and net worth raised a drift line telling the
 * household that "a payment entered straight onto the account" was to blame —
 * for a payment the app booked itself. A prepayment charge was credited to the
 * debt in full, though a fee repays nothing.
 *
 * Asserted for every path that pays a loan: the bank or card leg carries the
 * whole instalment, the loan leg the principal, and the account balance equals
 * outstandingPrincipal after each step, with no drift reported.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import {
  createLoan, recordInstalment, recordPrepayment, closeLoan, outstandingPrincipal, projectLoan,
} from "./loans.ts";
import { accountDrifts } from "./account-drift.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "ravi@example.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(50_00_000),
  }).id;
  const loan = createLoan(db, actor, {
    lender: "Fictional Bank", loanType: "home", sanctioned: rupees(10_00_000),
    sanctionDate: "2025-01-01", interestModel: "reducing", annualRatePct: 9,
    tenureMonths: 240, currentOutstanding: rupees(10_00_000), repaymentAccountId: bank,
    firstInstalmentDate: "2025-02-05",
  });
  return { db, bank, loan };
}

function ledgerOwed(db: DB, accountId: string): number {
  return -queryOne<{ bal: number }>(
    db,
    `SELECT opening_balance + COALESCE((SELECT SUM(amount) FROM transactions
                                         WHERE account_id = a.id AND deleted_at IS NULL), 0) AS bal
       FROM accounts a WHERE id = ?`,
    accountId,
  )!.bal || 0;
}

function inStep(db: DB, loanId: string, accountId: string, when: string) {
  assert.equal(ledgerOwed(db, accountId), outstandingPrincipal(db, loanId),
    `${when}: the loan account and the outstanding disagree`);
  assert.deepEqual(accountDrifts(db, { viewerMemberId: "m" }).map((d) => d.explanation), [],
    `${when}: net worth reports a drift the app caused`);
}

describe("WEALTH-16 · an instalment credits the loan with its principal", () => {
  test("one EMI from the bank: ₹9,98,502.74 owed, on the account and the schedule", () => {
    const { db, bank, loan } = setup();
    const emi = projectLoan(db, loan.id)!.emi;
    assert.equal(emi, 8_997_26);
    const paid = recordInstalment(db, actor, {
      loanId: loan.id, date: "2025-02-05", amount: emi, fromAccountId: bank,
    });
    assert.equal(paid.principal, 1_497_26);
    assert.equal(outstandingPrincipal(db, loan.id), 9_98_502_74);
    inStep(db, loan.id, loan.account_id, "after one EMI");

    // The whole instalment still leaves the bank, and the loan leg is kept.
    assert.equal(queryOne<{ amount: number }>(
      db, `SELECT amount FROM transactions WHERE id = ?`, paid.transaction_id)!.amount, -emi);
    assert.equal(queryOne<{ amount: number }>(
      db, `SELECT amount FROM transactions WHERE id = ?`, paid.loan_transaction_id)!.amount, 1_497_26);
  });

  test("a prepayment and its charge: the charge repays nothing", () => {
    const { db, bank, loan } = setup();
    recordPrepayment(db, actor, {
      loanId: loan.id, date: "2025-03-01", amount: rupees(50_000) as Paise, mode: "tenure",
      fromAccountId: bank, charge: rupees(1_000) as Paise,
    });
    assert.equal(outstandingPrincipal(db, loan.id), rupees(9_50_000));
    inStep(db, loan.id, loan.account_id, "after a prepayment with a charge");
  });

  test("an instalment charged to a card", () => {
    const { db, loan } = setup();
    const card = createAccount(db, actor, {
      name: "Card", kind: "credit", subtype: "credit-card", openingDate: "2025-01-01", openingBalance: 0,
    }).id;
    recordInstalment(db, actor, {
      loanId: loan.id, date: "2025-02-05", amount: 8_997_26 as Paise, fromAccountId: card,
    });
    inStep(db, loan.id, loan.account_id, "after a card-paid EMI");
  });

  test("a settlement above the outstanding: the excess is interest, and the account ends at nil", () => {
    const { db, bank, loan } = setup();
    recordInstalment(db, actor, {
      loanId: loan.id, date: "2025-02-05", amount: 8_997_26 as Paise, fromAccountId: bank,
    });
    const owed = outstandingPrincipal(db, loan.id);
    closeLoan(db, actor, {
      loanId: loan.id, date: "2025-02-20", settlement: (owed + rupees(3_000)) as Paise,
      settlementAccountId: bank,
    });
    assert.equal(ledgerOwed(db, loan.account_id), 0);
    assert.equal(outstandingPrincipal(db, loan.id), 0);
  });
});
