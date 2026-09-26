/**
 * Settling and closing a loan through the routes.
 *
 * WEALTH-19 · `settlement_account_id` was read raw while the charge's account
 * two lines above it went through the visibility check. Ravi, who is told
 * Priya's private savings account does not exist, could settle his loan out of
 * it: 303 "settled and closed", and a −₹1,00,000 instalment created by him in
 * her account.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne } from "../db/db.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { createLoan, getLoan } from "../domain/loans.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";

const ravi: Actor = { memberId: "m-ravi", source: "ui" };
const priya: Actor = { memberId: "m-priya", source: "ui" };

async function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  seedMember(db, "m-priya", "Priya");
  const bank = createAccount(db, ravi, {
    name: "Household Bank", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(10_00_000) as Paise,
  }).id;
  const hers = createAccount(db, priya, {
    name: "Priya private savings", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(3_00_000) as Paise,
    holderMemberId: "m-priya", visibility: "private",
    budgetId: ensurePersonalBudget(db, "m-priya", "Priya").id,
  }).id;
  const loan = createLoan(db, ravi, {
    lender: "Fictional Bank", loanType: "personal", sanctioned: rupees(1_00_000) as Paise,
    sanctionDate: "2025-01-01", interestModel: "reducing", annualRatePct: 12, tenureMonths: 24,
    currentOutstanding: rupees(1_00_000) as Paise, repaymentAccountId: bank,
  });
  const app = await startTestApp(db, { memberId: "m-ravi" });
  return { db, app, bank, hers, loan };
}

const count = (db: ReturnType<typeof freshDb>, accountId: string) =>
  queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?`, accountId)!.n;

describe("WEALTH-19 · a settlement is paid from an account the member can see", () => {
  test("another member's private account, as settlement_account_id: 404 and nothing moves", async () => {
    const { db, app, hers, loan } = await setup();
    try {
      const res = await app.post(`/loans/${loan.id}/settle`, {
        settlement: "100000", settlement_account_id: hers,
      });
      assert.equal(res.status, 404);
      assert.equal(count(db, hers), 0, "a transaction reached her private account");
      assert.equal(getLoan(db, loan.id)!.closed_at, null, "the loan closed anyway");
    } finally { await app.close(); }
  });

  test("and as charge_account_id, the form's fallback: 404 as well", async () => {
    const { db, app, hers, loan } = await setup();
    try {
      const res = await app.post(`/loans/${loan.id}/settle`, {
        settlement: "100000", charge_account_id: hers,
      });
      assert.equal(res.status, 404);
      assert.equal(count(db, hers), 0);
    } finally { await app.close(); }
  });

  test("his own account still settles it", async () => {
    const { db, app, bank, loan } = await setup();
    try {
      const res = await app.post(`/loans/${loan.id}/settle`, {
        settlement: "100000", settlement_account_id: bank,
      });
      assert.equal(res.status, 303);
      assert.notEqual(getLoan(db, loan.id)!.closed_at, null);
    } finally { await app.close(); }
  });

  test("a tracking account cannot pay a loan", async () => {
    const { db, app, loan } = await setup();
    try {
      const res = await app.post(`/loans/${loan.id}/settle`, {
        settlement: "100000", settlement_account_id: loan.account_id,
      });
      assert.equal(res.status, 422);
      assert.equal(getLoan(db, loan.id)!.closed_at, null);
    } finally { await app.close(); }
  });
});
