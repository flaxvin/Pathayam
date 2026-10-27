/**
 * LOANS-2 · The projected schedule is dated from the next instalment, not the
 * first one.
 *
 * The projection amortises what is still owed over the instalments left, but
 * dated its rows from the loan's first instalment date. Three EMIs into a
 * twelve-month loan whose first fell on 05-02-2025, the next instalment read
 * "05-02-2025" on the loan page, the schedule "closed" on 05-10-2025 instead of
 * 05-01-2026, and the cashflow calendar — which keeps only rows dated today or
 * later — dropped the last three instalments of every loan part-way through.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { createLoan, recordInstalment, projectLoan } from "./loans.ts";

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
    lender: "Fictional Bank", loanType: "personal", sanctioned: rupees(1_00_000),
    sanctionDate: "2025-01-01", interestModel: "reducing", annualRatePct: 12,
    tenureMonths: 12, currentOutstanding: rupees(1_00_000), repaymentAccountId: bank,
    firstInstalmentDate: "2025-01-31",
  });
  return { db, bank, loan };
}

describe("LOANS-2 · projected instalments carry their own due dates", () => {
  test("before any instalment, the schedule starts on the first instalment date", () => {
    const { db, loan } = setup();
    const s = projectLoan(db, loan.id)!.schedule;
    assert.equal(s.instalments[0]!.dueDate, "2025-01-31");
    assert.equal(s.closesOn, "2025-12-31");
  });

  test("three instalments in, the next is the fourth — and the loan still closes in December", () => {
    const { db, bank, loan } = setup();
    for (const date of ["2025-01-31", "2025-02-28", "2025-03-31"]) {
      recordInstalment(db, actor, { loanId: loan.id, date, amount: 888488, fromAccountId: bank });
    }
    const s = projectLoan(db, loan.id)!.schedule;
    assert.equal(s.months, 9);
    assert.equal(s.instalments[0]!.dueDate, "2025-04-30");
    // Month-end due day kept, not clamped to the 28th from February.
    assert.equal(s.instalments[1]!.dueDate, "2025-05-31");
    assert.equal(s.closesOn, "2025-12-31");
  });
});
