/**
 * The loan routes, driven as the browser and the client script drive them.
 *
 * Each block below is a defect the round-2 audit found at the route: a write
 * that skipped the idempotency wrapper, and inputs that answered 500 or were
 * saved when they should have been a sentence.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne } from "../db/db.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createLoan } from "../domain/loans.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";

const ravi: Actor = { memberId: "m-ravi", source: "ui" };

async function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const bank = createAccount(db, ravi, {
    name: "Household Bank", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(50_00_000) as Paise,
  }).id;
  const loan = createLoan(db, ravi, {
    lender: "Fictional Bank", loanType: "personal", sanctioned: rupees(5_00_000) as Paise,
    sanctionDate: "2025-01-01", interestModel: "reducing", annualRatePct: 12, tenureMonths: 60,
    currentOutstanding: rupees(5_00_000) as Paise, repaymentAccountId: bank,
  });
  const app = await startTestApp(db, { memberId: "m-ravi" });
  return { db, app, bank, loan };
}

const count = (db: ReturnType<typeof freshDb>, sql: string, ...args: unknown[]) =>
  queryOne<{ n: number }>(db, sql, ...args)!.n;

describe("WEALTH-17 · a replayed prepayment is applied once", () => {
  test("two POSTs with the same Idempotency-Key record one prepayment and one debit", async () => {
    const { db, app, bank, loan } = await setup();
    try {
      for (let i = 0; i < 2; i++) {
        const res = await app.post(
          `/loans/${loan.id}/prepay`, { amount: "50000", mode: "tenure" },
          { headers: { "Idempotency-Key": "prepay-retry-1" } },
        );
        assert.equal(res.status, 303);
      }
      assert.equal(
        count(db, `SELECT COUNT(*) AS n FROM loan_payments WHERE loan_id = ? AND kind = 'prepayment'`, loan.id), 1,
      );
      assert.equal(
        count(db, `SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND deleted_at IS NULL AND amount < 0`, bank), 1,
      );
    } finally { await app.close(); }
  });

  test("the preview still only recalculates", async () => {
    const { db, app, loan } = await setup();
    try {
      const res = await app.post(`/loans/${loan.id}/prepay`, { amount: "50000", preview: "1" });
      assert.equal(res.status, 303);
      assert.equal(count(db, `SELECT COUNT(*) AS n FROM loan_payments WHERE loan_id = ?`, loan.id), 0);
    } finally { await app.close(); }
  });
});
