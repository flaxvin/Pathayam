/**
 * Settling a loan moves money, and a settlement below the outstanding is a
 * waiver — never negative interest.
 *
 * The defect, with the auditor's numbers: a ₹50,000 personal loan settled for
 * ₹40,000. `closeLoan` recorded one foreclosure row with principal ₹50,000 and
 * interest ₹40,000 − ₹50,000 = −₹10,000, and passed no account, so:
 *   - the bank balance did not move — ₹40,000 left in reality, ₹0 in the app;
 *   - the interest report netted −₹10,000 against the year's real interest,
 *     understating a 24(b)/80E claim built from it.
 * Now: ₹40,000 leaves the bank through the loan's payment envelope (principal
 * ₹40,000, interest ₹0), and the ₹10,000 shortfall is a separate row of
 * principal forgiven, with no money behind it. Identity asserted:
 *   principal paid (40,000) + principal forgiven (10,000) = outstanding (50,000)
 *   and the budget identity residual stays 0.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryAll } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, monthOf } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { accountBalances, loadEngineInput } from "../engine/repository.ts";
import { computeBudget, identityResidual } from "../engine/engine.ts";
import { createLoan, closeLoan, outstandingPrincipal } from "./loans.ts";
import { loanInterestByFinancialYear } from "./reports.ts";

const actor: Actor = { memberId: "m", source: "ui" };
const DATE = "2026-06-01";

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "ravi@example.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(10_00_000),
  }).id;
  const loan = createLoan(db, actor, {
    lender: "Fictional Lender", loanType: "personal", sanctioned: rupees(50_000),
    sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 12,
    tenureMonths: 12, currentOutstanding: rupees(50_000), repaymentAccountId: bank,
  });
  return { db, bank, loan };
}

function identityHolds(db: ReturnType<typeof setup>["db"]) {
  for (const useRollup of [false, true]) {
    const states = computeBudget(loadEngineInput(db, { through: monthOf(DATE), useRollup }));
    for (const [month, s] of states) {
      assert.equal(identityResidual(s), 0, `identity broken in ${month} (rollup ${useRollup})`);
    }
  }
}

describe("settling a loan", () => {
  test("below the outstanding: money moves, the shortfall is forgiven, interest is never negative", () => {
    const { db, bank, loan } = setup();
    const before = accountBalances(db).get(bank)!.working;

    closeLoan(db, actor, { loanId: loan.id, date: DATE, settlement: rupees(40_000) });

    assert.equal(accountBalances(db).get(bank)!.working, before - rupees(40_000),
      "the settlement never left the bank");

    const rows = queryAll<{ amount: number; principal: number; interest: number; transaction_id: string | null }>(
      db, `SELECT amount, principal, interest, transaction_id FROM loan_payments WHERE loan_id = ? ORDER BY amount DESC`,
      loan.id,
    );
    assert.ok(rows.every((r) => r.interest >= 0), "negative interest was booked");
    const paid = rows.find((r) => r.amount > 0)!;
    const forgiven = rows.find((r) => r.amount === 0)!;
    assert.equal(paid.principal, rupees(40_000));
    assert.equal(paid.interest, 0);
    assert.ok(paid.transaction_id, "the payment has no transaction behind it");
    assert.equal(forgiven.principal, rupees(10_000));
    assert.equal(paid.principal + forgiven.principal, rupees(50_000), "paid + forgiven ≠ outstanding");
    assert.equal(outstandingPrincipal(db, loan.id), 0);

    const interest = loanInterestByFinancialYear(db).filter((r) => r.lender === "Fictional Lender");
    assert.ok(interest.every((r) => r.interest >= 0), "the interest report carries a negative");

    identityHolds(db);
  });

  test("above the outstanding: the excess is interest, and all of it is paid", () => {
    const { db, bank, loan } = setup();
    const before = accountBalances(db).get(bank)!.working;
    // ₹52,000 against ₹50,000 outstanding: ₹50,000 principal + ₹2,000 interest.
    closeLoan(db, actor, { loanId: loan.id, date: DATE, settlement: rupees(52_000) });

    assert.equal(accountBalances(db).get(bank)!.working, before - rupees(52_000));
    const rows = queryAll<{ principal: number; interest: number }>(
      db, `SELECT principal, interest FROM loan_payments WHERE loan_id = ?`, loan.id,
    );
    assert.deepEqual(
      rows.map((r) => ({ principal: r.principal, interest: r.interest })),
      [{ principal: rupees(50_000), interest: rupees(2_000) }],
    );
    identityHolds(db);
  });
});
