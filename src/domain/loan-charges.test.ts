/**
 * A prepayment penalty is not interest.
 *
 * The charge row was written with its whole amount in the interest column, and
 * that put the same money in two places at once: in `fees`, which sums the
 * charge rows' amounts, and again in `paidInterest`, which sums every row's
 * interest — so `totalCostOfBorrowing`, being interest plus fees, counted it
 * twice.
 *
 * The part that actually costs money is the other one. `loanInterestByFinancialYear`
 * sums the interest column across every loan payment, and that is the figure a
 * household carries to a section 24(b) home-loan interest deduction. A ₹2,000
 * penalty on a loan that had paid no interest at all was reported as ₹2,000 of
 * interest for the year — a deduction claimed on money that was never interest
 * on borrowed capital.
 *
 * The foreclosure charge always wrote zeros, because it inserts its row
 * directly and so never met the repayment split rule that forced the
 * prepayment charge to put the amount *somewhere*. Two paths, same kind of
 * cost, different answers. They agree now.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { createAccount } from "./accounts.ts";
import { createLoan, recordDisbursement, recordPrepayment, projectLoan, recordInstalment } from "./loans.ts";
import { loanInterestByFinancialYear } from "./reports.ts";
import { Refusal } from "../core/refusal.ts";
import { rupees, type Paise } from "../core/money.ts";
import { queryAll } from "../db/db.ts";
import type { IsoDate } from "../core/dates.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-04-01", openingBalance: rupees(5_000_000),
  }).id;
  const loan = createLoan(db, actor, {
    lender: "HDFC Home Loan", loanType: "home",
    sanctioned: rupees(3_000_000) as Paise, sanctionDate: "2026-04-01" as IsoDate,
    interestModel: "reducing", annualRatePct: 8.5, tenureMonths: 240,
    firstInstalmentDate: "2026-05-05" as IsoDate, repaymentAccountId: bank,
  });
  recordDisbursement(db, actor, {
    loanId: loan.id, date: "2026-04-05" as IsoDate, amount: rupees(3_000_000) as Paise,
    destination: "budget-account", destinationAccountId: bank,
  });
  return { db, bank, loan };
}

describe("a prepayment charge", () => {
  test("is not reported as interest for the financial year", () => {
    const { db, bank, loan } = setup();
    recordPrepayment(db, actor, {
      loanId: loan.id, date: "2026-06-15" as IsoDate,
      amount: rupees(100_000) as Paise, charge: rupees(2_000) as Paise,
      mode: "tenure", fromAccountId: bank,
    });

    const fy = loanInterestByFinancialYear(db);
    const total = fy.reduce((sum, r) => sum + r.interest, 0);
    assert.equal(
      total, 0,
      "a penalty for closing early was reported as deductible interest — no " +
      "interest has been paid on this loan at all",
    );
  });

  test("is stored as neither principal nor interest", () => {
    const { db, bank, loan } = setup();
    recordPrepayment(db, actor, {
      loanId: loan.id, date: "2026-06-15" as IsoDate,
      amount: rupees(100_000) as Paise, charge: rupees(2_000) as Paise,
      mode: "tenure", fromAccountId: bank,
    });

    const charge = queryAll<{ amount: number; principal: number; interest: number }>(
      db, `SELECT amount, principal, interest FROM loan_payments WHERE kind = 'charge'`,
    );
    assert.equal(charge.length, 1);
    assert.equal(charge[0]!.amount, rupees(2_000), "the charge lost its amount");
    assert.equal(charge[0]!.principal, 0);
    assert.equal(charge[0]!.interest, 0);
  });

  test("is counted once in the cost of borrowing, not twice", () => {
    const { db, bank, loan } = setup();
    const before = projectLoan(db, loan.id)!.metrics.totalCostOfBorrowing;

    recordPrepayment(db, actor, {
      loanId: loan.id, date: "2026-06-15" as IsoDate,
      amount: rupees(100_000) as Paise, charge: rupees(2_000) as Paise,
      mode: "tenure", fromAccountId: bank,
    });
    const after = projectLoan(db, loan.id)!;

    assert.equal(after.metrics.interestPaid, 0, "the fee was counted as interest paid");
    // Prepaying reduces projected interest, so the total falls — but the ₹2,000
    // must appear in it exactly once. Compare against the fee-free arithmetic.
    const interestPart = after.metrics.interestProjected;
    assert.equal(
      after.metrics.totalCostOfBorrowing, interestPart + rupees(2_000),
      "the charge is in the total more than once, or not at all",
    );
    assert.ok(after.metrics.totalCostOfBorrowing < before, "prepaying did not reduce the cost");
  });

  test("a charge carrying a split is refused outright", () => {
    // The rule that forced the old behaviour: a repayment must account for
    // itself as principal plus interest. A charge repays nothing, so writing
    // one with either is the mistake this whole file is about.
    const { db, bank, loan } = setup();
    assert.throws(
      () => recordInstalment(db, actor, {
        loanId: loan.id, date: "2026-06-15" as IsoDate, amount: rupees(2_000) as Paise,
        principal: 0, interest: rupees(2_000) as Paise, kind: "charge",
        fromAccountId: bank,
      }),
      (e: Error) => e instanceof Refusal && /a cost, not a repayment/i.test(e.message),
    );
  });

  test("an ordinary instalment must still add up", () => {
    const { db, bank, loan } = setup();
    assert.throws(
      () => recordInstalment(db, actor, {
        loanId: loan.id, date: "2026-06-15" as IsoDate, amount: rupees(26_000) as Paise,
        principal: rupees(5_000) as Paise, interest: rupees(1_000) as Paise, kind: "instalment",
        fromAccountId: bank,
      }),
      (e: Error) => e instanceof Refusal && /adds up to/.test(e.message),
      "the split rule was weakened for everything, not just charges",
    );
  });
});
