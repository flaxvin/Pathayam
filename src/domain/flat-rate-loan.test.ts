/**
 * A flat-rate loan is projected on its own schedule, not as reducing balance.
 *
 * The defect: `projectLoan` ran every loan through the reducing-balance
 * schedule, so a flat quote was projected as if it were a reducing rate of the
 * same number. ₹1,00,000 at 12% flat over 12 months:
 *   flat:      interest = 1,00,000 × 12% × 1 year = ₹12,000
 *              EMI      = (1,00,000 + 12,000) ÷ 12 = ₹9,333.33
 *   projected: EMI ₹8,884.88, interest ₹6,618.55 (reducing balance at 12%)
 * The envelope target followed the projected EMI, so the household set aside
 * ₹448.45 a month less than the lender takes. And the fallback split for an
 * instalment paid without the lender's figures used the reducing balance too,
 * so the outstanding ran ahead of the lender's.
 *
 * Now the schedule, the EMI, the envelope target and the estimated split all
 * come from the flat schedule: ₹1,000 interest and ₹8,333.33 principal a
 * month, every month.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createLoan, projectLoan, recordInstalment, paymentCategoryForLoan, listPayments } from "./loans.ts";
import { getTarget } from "./budget.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "ravi@example.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(10_00_000),
  }).id;
  const loan = createLoan(db, actor, {
    lender: "Fictional Finance", loanType: "personal", sanctioned: rupees(1_00_000),
    sanctionDate: "2025-01-01", interestModel: "flat", annualRatePct: 12,
    tenureMonths: 12, currentOutstanding: rupees(1_00_000), repaymentAccountId: bank,
  });
  return { db, bank, loan };
}

describe("a flat-rate loan", () => {
  test("EMI ₹9,333.33 and interest ₹12,000, in the schedule, the baseline and the target", () => {
    const { db, loan } = setup();
    const p = projectLoan(db, loan.id)!;

    assert.equal(p.emi, 933_333, "EMI is (P + P·r·years) ÷ n");
    assert.equal(p.schedule.totalInterest, rupees(12_000));
    assert.equal(p.baseline.totalInterest, rupees(12_000));
    assert.equal(p.schedule.months, 12);
    for (const row of p.schedule.instalments) {
      assert.equal(row.interest, rupees(1_000), `instalment ${row.number} is not flat`);
      assert.equal(row.opening - row.principal, row.closing, `instalment ${row.number} does not reconcile`);
    }
    assert.equal(p.schedule.instalments.at(-1)!.closing, 0);

    const target = getTarget(db, paymentCategoryForLoan(db, loan.id)!.id)!;
    assert.equal(target.amount, p.emi, "the envelope target and the EMI disagree");
  });

  test("paying the EMI without the lender's split files ₹1,000 interest each month", () => {
    const { db, bank, loan } = setup();
    for (let i = 1; i <= 12; i++) {
      const due = projectLoan(db, loan.id)!.emi;
      recordInstalment(db, actor, {
        loanId: loan.id, date: `2025-${String(i + 1).padStart(2, "0")}-05`.replace("2025-13", "2026-01"),
        amount: due, fromAccountId: bank,
      });
    }
    const payments = listPayments(db, loan.id);
    assert.ok(payments.every((pay) => pay.interest === rupees(1_000)), "the estimated split is not flat");
    const interest = payments.reduce((t, pay) => t + pay.interest, 0);
    assert.equal(interest, rupees(12_000));
    assert.equal(projectLoan(db, loan.id)!.outstanding, 0, "twelve EMIs did not close it");
  });
});
