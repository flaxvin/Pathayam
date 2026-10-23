/**
 * "Reduce the tenure" on a flat-rate loan keeps the instalment, not raises it.
 *
 * The tenure a kept instalment needs was always worked out as a reducing
 * balance loan, even for a flat one. ₹2,40,000 at 15% flat over 24 months:
 *   interest  = 2,40,000 × 15% ÷ 12        = ₹3,000 a month, every month
 *   instalment = 2,40,000 ÷ 24 + 3,000      = ₹13,000
 * After twelve instalments ₹1,20,000 is owed; ₹30,000 prepaid leaves ₹90,000.
 * Kept at ₹13,000, ₹10,000 of each instalment is principal: 90,000 ÷ 10,000 =
 * 9 more instalments, tenure 12 + 9 = 21. Priced as reducing balance at 15%
 * (₹1,125 interest on ₹90,000, so ~₹11,875 principal) it took 8, the tenure
 * became 20, and the flat schedule then asked 90,000 ÷ 8 + 3,000 = ₹14,250 —
 * the choice that promises the same instalment raised it by ₹1,250.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, type IsoDate } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createLoan, getLoan, projectLoan, recordInstalment, recordPrepayment } from "./loans.ts";

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
    lender: "Fictional Finance", loanType: "personal", sanctioned: rupees(2_40_000),
    sanctionDate: "2025-01-01", interestModel: "flat", annualRatePct: 15,
    tenureMonths: 24, currentOutstanding: rupees(2_40_000), repaymentAccountId: bank,
  });
  for (let i = 1; i <= 12; i++) {
    const date = (i < 12 ? `2025-${String(i + 1).padStart(2, "0")}-05` : "2025-12-20") as IsoDate;
    recordInstalment(db, actor, { loanId: loan.id, date, amount: rupees(13_000) as Paise, fromAccountId: bank });
  }
  return { db, loan };
}

describe("a flat-rate loan, prepaid by reducing the tenure", () => {
  test("₹30,000 off ₹1,20,000: still ₹13,000, nine instalments left, tenure 21", () => {
    const { db, loan } = setup();
    assert.equal(projectLoan(db, loan.id)!.emi, rupees(13_000));

    recordPrepayment(db, actor, {
      loanId: loan.id, date: "2026-01-10", amount: rupees(30_000) as Paise, mode: "tenure",
    });

    const p = projectLoan(db, loan.id)!;
    assert.equal(p.outstanding, rupees(90_000));
    assert.equal(p.emi, rupees(13_000), "the instalment the borrower chose to keep");
    assert.equal(p.schedule.months, 9);
    assert.equal(getLoan(db, loan.id)!.tenure_months, 21);
  });

  test("₹25,000 off: ₹95,000 needs ten instalments, none above the ₹13,000 kept", () => {
    const { db, loan } = setup();
    recordPrepayment(db, actor, {
      loanId: loan.id, date: "2026-01-10", amount: rupees(25_000) as Paise, mode: "tenure",
    });
    const p = projectLoan(db, loan.id)!;
    // 95,000 ÷ 10,000 = 9.5, so ten: 9,500 + 3,000 = ₹12,500 each.
    assert.equal(p.schedule.months, 10);
    assert.equal(p.emi, rupees(12_500));
    assert.equal(getLoan(db, loan.id)!.tenure_months, 22);
  });
});
