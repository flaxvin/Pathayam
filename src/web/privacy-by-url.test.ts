/**
 * H2.2 · A list filter is not a privacy control.
 *
 * Loans, family arrangements and the accounts behind them can be marked private
 * to one member. Every index respected that — `listLoans` filtered, net worth
 * hid the line — and every per-entity route then read the row straight out of
 * the table by id. A member who had once seen a loan, or who simply walked the
 * ids, could open its detail page, export its schedule, record an instalment
 * against it, change whose it was, or close it.
 *
 * These tests drive the URLs directly as the wrong member, which is the only
 * way the hole was ever reachable and so the only way it can be shown shut.
 * Every one of them fails against the code as it stood.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";
import type { Actor } from "../core/events.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createLoan } from "../domain/loans.ts";
import { createFamilyLoan } from "../domain/family-loans.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi: Actor = { memberId: RAVI, source: "ui" };

/** Priya is signed in. Ravi holds a private loan and a private arrangement. */
async function appAsPriya(): Promise<{ app: TestApp; loanId: string; familyId: string }> {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, PRIYA, "Priya");

  const bank = createAccount(db, ravi, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(5_00_000),
  });

  const loan = createLoan(db, ravi, {
    lender: "Bajaj", loanType: "personal", sanctioned: rupees(2_00_000),
    sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 14,
    tenureMonths: 24, currentOutstanding: rupees(2_00_000), repaymentAccountId: bank.id,
    holderMemberId: RAVI, visibility: "private",
  });

  const family = createFamilyLoan(db, ravi, {
    counterparty: "Cousin Manu", holderMemberId: RAVI, visibility: "private",
  });

  const app = await startTestApp(db, { memberId: PRIYA });
  return { app, loanId: loan.id, familyId: family.id };
}

describe("H2.2 · a private loan is not readable by its URL", () => {
  let app: TestApp;
  let loanId: string;
  let familyId: string;

  before(async () => {
    ({ app, loanId, familyId } = await appAsPriya());
  });
  after(async () => {
    assert.deepEqual(app.failures, [], "nothing 500ed");
    await app.close();
  });

  test("the index does not list it", async () => {
    const body = await (await app.get("/loans")).text();
    assert.ok(!body.includes("Bajaj"), "Priya's loans page does not name Ravi's lender");
  });

  test("every per-loan GET answers not-found", async () => {
    for (const path of [
      `/loans/${loanId}`,
      `/loans/${loanId}/rate`,
      `/loans/${loanId}/prepay`,
      `/loans/${loanId}/pay`,
      `/loans/${loanId}/statement`,
      `/loans/${loanId}/schedule.csv`,
    ]) {
      const res = await app.get(path);
      assert.equal(res.status, 404, `${path} answered ${res.status}`);
      assert.ok(
        !(await res.text()).includes("Bajaj"),
        `${path} named the lender in its reply`,
      );
    }
  });

  test("every per-loan POST answers not-found, and changes nothing", async () => {
    for (const [path, form] of [
      [`/loans/${loanId}/close`, {}],
      [`/loans/${loanId}/settle`, { date: "2026-09-13" }],
      [`/loans/${loanId}/holder`, { holder_member_id: PRIYA }],
      [`/loans/${loanId}/disburse`, { amount: "1000", destination: "third-party" }],
      [`/loans/${loanId}/pay`, { amount: "5000" }],
      [`/loans/${loanId}/prepay`, { amount: "5000", mode: "tenure" }],
      [`/loans/${loanId}/rate`, { annual_rate_pct: "1", effective_from: "2026-09-01" }],
      [`/loans/${loanId}/statement`, { lender_outstanding: "1", as_of: "2026-09-01" }],
    ] as [string, Record<string, string>][]) {
      const res = await app.post(path, form);
      assert.equal(res.status, 404, `${path} answered ${res.status}`);
    }

    // The decisive assertion: nothing above landed.
    const loan = app.db.prepare("SELECT closed_at FROM loans WHERE id = ?").get(loanId) as
      { closed_at: string | null };
    assert.equal(loan.closed_at, null, "the loan is still open");
    const payments = app.db
      .prepare("SELECT COUNT(*) AS n FROM loan_payments WHERE loan_id = ?").get(loanId) as { n: number };
    assert.equal(payments.n, 0, "and nothing was recorded against it");
  });

  test("a private family arrangement is not readable either", async () => {
    const list = await (await app.get("/family")).text();
    assert.ok(!list.includes("Cousin Manu"), "the list does not name it");

    for (const path of [
      `/family/${familyId}`,
    ]) {
      assert.equal((await app.get(path)).status, 404, path);
    }
    for (const path of [
      `/family/${familyId}/advance`,
      `/family/${familyId}/repayment`,
      `/family/${familyId}/write-off`,
      `/family/${familyId}/close`,
    ]) {
      assert.equal((await app.post(path, { amount: "100" })).status, 404, path);
    }
  });

  test("it stays out of the net-worth total, not merely off the list", async () => {
    // A total that includes what you cannot see publishes it by subtraction.
    const body = await (await app.get("/networth")).text();
    assert.ok(!body.includes("Bajaj"), "no line");
    assert.ok(!body.includes("Cousin Manu"), "no arrangement either");
  });
});

describe("H2.2 · the holder still sees their own", () => {
  test("Ravi's own private loan opens for Ravi", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    const bank = createAccount(db, ravi, {
      name: "HDFC", kind: "budget", subtype: "savings",
      openingDate: "2026-01-01", openingBalance: rupees(5_00_000),
    });
    const loan = createLoan(db, ravi, {
      lender: "Bajaj", loanType: "personal", sanctioned: rupees(2_00_000),
      sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 14,
      tenureMonths: 24, currentOutstanding: rupees(2_00_000), repaymentAccountId: bank.id,
      holderMemberId: RAVI, visibility: "private",
    });

    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const res = await app.get(`/loans/${loan.id}`);
      assert.equal(res.status, 200);
      assert.ok((await res.text()).includes("Bajaj"), "the holder sees their own lender");
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
