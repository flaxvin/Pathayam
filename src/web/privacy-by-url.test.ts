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
import { todayIST } from "../core/dates.ts";
import { createAccount } from "../domain/accounts.ts";
import { createLoan } from "../domain/loans.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { createTransaction } from "../domain/transactions.ts";
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

/**
 * H2.2 · And a private account's *transactions* are its holder's alone too.
 *
 * Every index respected the flag — the accounts list, net worth, the loans page
 * — while `queryTransactions`, the query every other screen is built on,
 * respected nothing. Query, its CSV export, Search and the whole reports page
 * showed one member's private spending to the rest of the household: payee,
 * amount, envelope, line by line. The flag was on the account and the ledger
 * read straight past it.
 */
describe("H2.2 · private spending does not appear in anybody else's reports", () => {
  const RENT = "Astonishingly Distinctive Payee";

  async function household(): Promise<{ app: TestApp; close: () => Promise<void> }> {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    seedMember(db, PRIYA, "Priya");

    const shared = createAccount(db, ravi, {
      name: "Joint", kind: "budget", subtype: "savings",
      openingDate: "2026-01-01", openingBalance: rupees(1_00_000),
    });
    // A private account has to sit in its holder's own budget — the app refuses
    // it in the household's, because a balance inside Ready to Assign cannot be
    // hidden by hiding its name.
    const his = ensurePersonalBudget(db, RAVI, "Ravi");
    const secret = createAccount(db, ravi, {
      name: "IDFC Savings", kind: "budget", subtype: "savings",
      openingDate: "2026-01-01", openingBalance: rupees(2_00_000),
      holderMemberId: RAVI, visibility: "private", budgetId: his.id,
    });
    const group = createGroup(db, ravi, "Everyday");
    const category = createCategory(db, ravi, { groupId: group.id, name: "Books" });

    createTransaction(db, ravi, {
      accountId: secret.id, amount: -rupees(4_321) as Paise, date: todayIST(),
      categoryId: category.id, payeeName: RENT, cleared: true, ownerMemberId: RAVI,
    });
    void shared;

    const app = await startTestApp(db, { memberId: PRIYA });
    return { app, close: () => app.close() };
  }

  test("not in Query, its CSV, or Search", async () => {
    const { app, close } = await household();
    try {
      for (const path of ["/query", "/query.csv"]) {
        const body = await (await app.get(path)).text();
        assert.ok(
          !body.includes(RENT),
          `${path} shows Priya a payee from Ravi's private account`,
        );
        assert.ok(!body.includes("IDFC"), `${path} names the private account itself`);
      }

      /*
       * Search echoes the term back into its own box, so the name being on the
       * page proves nothing. What must not be there is the row: the account it
       * was spent from, and the amount.
       */
      const found = await (await app.get(`/search?q=${encodeURIComponent(RENT)}`)).text();
      assert.ok(!found.includes("IDFC"), "search names the private account");
      assert.ok(!found.includes("4,321"), "search shows the amount spent on it");
      assert.deepEqual(app.failures, []);
    } finally {
      await close();
    }
  });

  test("nor anywhere on the reports page", async () => {
    const { app, close } = await household();
    try {
      const body = await (await app.get("/reports")).text();
      assert.ok(!body.includes(RENT), "the reports page names a private payee");
      assert.deepEqual(app.failures, []);
    } finally {
      await close();
    }
  });

  test("but the holder sees their own", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    const his = ensurePersonalBudget(db, RAVI, "Ravi");
    const secret = createAccount(db, ravi, {
      name: "IDFC Savings", kind: "budget", subtype: "savings",
      openingDate: "2026-01-01", openingBalance: rupees(2_00_000),
      holderMemberId: RAVI, visibility: "private", budgetId: his.id,
    });
    const group = createGroup(db, ravi, "Everyday");
    const category = createCategory(db, ravi, { groupId: group.id, name: "Books" });
    createTransaction(db, ravi, {
      accountId: secret.id, amount: -rupees(4_321) as Paise, date: todayIST(),
      categoryId: category.id, payeeName: RENT, cleared: true, ownerMemberId: RAVI,
    });

    const app = await startTestApp(db, { memberId: RAVI });
    try {
      // Query is budget-scoped like every screen that means one budget's money,
      // so his own budget is where his own account's spending lives.
      const body = await (await app.get(`/query?budget=${encodeURIComponent(his.id)}`)).text();
      assert.ok(body.includes(RENT), "Ravi cannot see his own spending");
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
