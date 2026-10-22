/**
 * Recording a lender's statement through the route.
 *
 * UI-PASS-4 · The form took "abc" instalments remaining and a negative
 * outstanding, and answered "Statement recorded." for both.
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
    openingDate: "2025-01-01", openingBalance: rupees(10_00_000) as Paise,
  }).id;
  const loan = createLoan(db, ravi, {
    lender: "Fictional Bank", loanType: "personal", sanctioned: rupees(1_00_000) as Paise,
    sanctionDate: "2025-01-01", interestModel: "reducing", annualRatePct: 12, tenureMonths: 24,
    currentOutstanding: rupees(1_00_000) as Paise, repaymentAccountId: bank,
  });
  const app = await startTestApp(db, { memberId: "m-ravi" });
  return { db, app, loan };
}

const statements = (db: ReturnType<typeof freshDb>) =>
  queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM loan_statements`)!.n;

describe("UI-PASS-4 · a lender statement holds only figures a statement can show", () => {
  for (const [label, body] of [
    ["a negative outstanding", { lender_outstanding: "-500" }],
    ["negative interest paid", { lender_outstanding: "90000", interest_paid_ytd: "-20" }],
    ["words for instalments remaining", { lender_outstanding: "90000", instalments_remaining: "abc" }],
    ["a fraction of an instalment", { lender_outstanding: "90000", instalments_remaining: "2.5" }],
    ["negative instalments", { lender_outstanding: "90000", instalments_remaining: "-3" }],
  ] as const) {
    test(`${label} is refused and nothing is stored`, async () => {
      const { db, app, loan } = await setup();
      try {
        const res = await app.post(`/loans/${loan.id}/statement`, { as_of: "2025-06-01", ...body });
        assert.equal(res.status, 422);
        assert.equal(statements(db), 0);
      } finally { await app.close(); }
    });
  }

  test("a real one is recorded", async () => {
    const { db, app, loan } = await setup();
    try {
      const res = await app.post(`/loans/${loan.id}/statement`, {
        as_of: "2025-06-01", lender_outstanding: "90000", interest_paid_ytd: "4500", instalments_remaining: "19",
      });
      assert.equal(res.status, 303);
      assert.equal(statements(db), 1);
    } finally { await app.close(); }
  });
});
