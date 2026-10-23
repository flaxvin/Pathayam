/**
 * A payment that repays no principal is not one of the loan's instalments.
 *
 * Every row of kind "instalment" was counted as a month of the tenure used up,
 * and the first one ended a moratorium. So the interest a serviced moratorium
 * asks for ended it on the first payment. ₹10,00,000 for an education at 10%,
 * a 12-month moratorium with the interest serviced, then 120 instalments:
 *   during:  10,00,000 × 10% ÷ 12                         = ₹8,333.33 a month
 *   after:   EMI = P·r·(1+r)^120 / ((1+r)^120 − 1), r = 10%/12
 *            (1.0083333)^120 = 2.707041
 *            10,00,000 × 0.0083333 × 2.707041 / 1.707041  = ₹13,215.07
 * Once ₹8,333.33 of interest was paid, the page dropped the moratorium and
 * asked for ₹13,279.90 now — the EMI over 119 months — and every interest
 * payment after took another month off the repayment the lender has not begun.
 * Pre-EMI on a loan still being drawn is the same: interest, not a month.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createLoan, projectLoan, recordInstalment } from "./loans.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "ravi@example.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(5_00_000),
  }).id;
  const loan = createLoan(db, actor, {
    lender: "Fictional Bank", loanType: "education", sanctioned: rupees(10_00_000),
    sanctionDate: "2025-01-01", interestModel: "moratorium-serviced", moratoriumMonths: 12,
    annualRatePct: 10, tenureMonths: 120, currentOutstanding: rupees(10_00_000),
    repaymentAccountId: bank,
  });
  return { db, bank, loan };
}

describe("interest serviced during a moratorium", () => {
  test("the moratorium holds: ₹8,333.33 now, ₹13,215.07 over 120 months after", () => {
    const { db, bank, loan } = setup();
    const before = projectLoan(db, loan.id)!;
    assert.equal(before.preEmi, 833_333);
    assert.equal(before.emi, 1_321_507);

    for (const date of ["2025-02-01", "2025-03-01", "2025-04-01"] as const) {
      recordInstalment(db, actor, {
        loanId: loan.id, date, amount: 833_333 as Paise,
        principal: 0 as Paise, interest: 833_333 as Paise, fromAccountId: bank,
      });
    }

    const p = projectLoan(db, loan.id)!;
    assert.equal(p.outstanding, rupees(10_00_000));
    assert.notEqual(p.moratorium, null, "still in its moratorium");
    assert.equal(p.preEmi, 833_333, "the interest is still what is due each month");
    assert.equal(p.emi, 1_321_507, "the EMI to come is over all 120 months");
    assert.equal(p.schedule.months, 120);
  });

  test("the first instalment that repays principal begins the 120", () => {
    const { db, bank, loan } = setup();
    recordInstalment(db, actor, {
      loanId: loan.id, date: "2025-02-01", amount: 833_333 as Paise,
      principal: 0 as Paise, interest: 833_333 as Paise, fromAccountId: bank,
    });
    // ₹13,215.07: ₹8,333.33 of interest, ₹4,881.74 of principal.
    recordInstalment(db, actor, {
      loanId: loan.id, date: "2026-02-01", amount: 1_321_507 as Paise,
      principal: 488_174 as Paise, interest: 833_333 as Paise, fromAccountId: bank,
    });
    const p = projectLoan(db, loan.id)!;
    assert.equal(p.moratorium, null);
    assert.equal(p.schedule.months, 119, "one of the 120 is paid");
    // ₹9,95,118.26 over 119 months at 10% is the same ₹13,215.07, to the paisa or so.
    assert.ok(Math.abs(p.emi - 1_321_507) <= 1, `EMI ${p.emi}`);
  });
});
