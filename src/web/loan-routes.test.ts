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

describe("WEALTH-38 · adding a loan checks what it is given", () => {
  const base = (bank: string): Record<string, string> => ({
    lender: "Fictional Lender", loan_type: "personal", sanctioned: "100000", sanction_date: "2026-01-01",
    interest_model: "reducing", annual_rate: "12", tenure_months: "12", repayment_account_id: bank,
  });

  test("nonsense is a 422 with a sentence, never a 500, and nothing is saved", async () => {
    const { db, app, bank } = await setup();
    try {
      const cases: Record<string, string>[] = [
        { tenure_months: "abc" }, { tenure_months: "1.5" }, { tenure_months: "0" },
        { annual_rate: "abc" }, { annual_rate: "-3" }, { annual_rate: "1e20" },
        { loan_type: "bogus" }, { interest_model: "bogus" },
        { interest_model: "moratorium-serviced", moratorium_months: "abc" },
        { current_outstanding: "500000" },
      ];
      const before = count(db, `SELECT COUNT(*) AS n FROM loans`);
      for (const over of cases) {
        const res = await app.post("/loans/new", { ...base(bank), ...over });
        assert.equal(res.status, 422, JSON.stringify(over));
      }
      assert.equal(count(db, `SELECT COUNT(*) AS n FROM loans`), before);
    } finally { await app.close(); }
  });

  test("a sound loan still saves, and a capitalised moratorium may owe more than it drew", async () => {
    const { db, app, bank } = await setup();
    try {
      assert.equal((await app.post("/loans/new", base(bank))).status, 303);
      assert.equal((await app.post("/loans/new", {
        ...base(bank), interest_model: "moratorium-capitalised", moratorium_months: "24",
        current_outstanding: "120000",
      })).status, 303);
      assert.equal(count(db, `SELECT COUNT(*) AS n FROM loans`), 3);
    } finally { await app.close(); }
  });
});

describe("WEBUX-13 · a rate change is bounded like a new loan's rate", () => {
  test("1e20%, a negative rate and a date before the sanction are 422s, and no period is added", async () => {
    const { db, app, loan } = await setup();
    try {
      const periods = () => count(db, `SELECT COUNT(*) AS n FROM loan_rates WHERE loan_id = ?`, loan.id);
      for (const body of [
        { annual_rate_pct: "1e20", effective_from: "2025-06-01" },
        { annual_rate_pct: "1e308", effective_from: "2025-06-01" },
        { annual_rate_pct: "-1", effective_from: "2025-06-01" },
        { annual_rate_pct: "11", effective_from: "1900-01-01" },
      ]) {
        const res = await app.post(`/loans/${loan.id}/rate`, body);
        assert.equal(res.status, 422, JSON.stringify(body));
      }
      assert.equal(periods(), 1);
      assert.equal((await app.get(`/loans/${loan.id}/rate?annual_rate_pct=1e20`)).status, 422);

      assert.equal((await app.post(`/loans/${loan.id}/rate`, { annual_rate_pct: "11", effective_from: "2025-06-01" })).status, 303);
      assert.equal(periods(), 2);
    } finally { await app.close(); }
  });

  test("an instalment that cannot cover the interest is said in rupees", async () => {
    const { app, loan } = await setup();
    try {
      const res = await app.post(`/loans/${loan.id}/rate`, {
        annual_rate_pct: "99", effective_from: "2025-06-01", keep: "emi",
      });
      assert.equal(res.status, 422);
      const text = await res.text();
      assert.match(text, /An instalment of ₹[\d,]+(\.\d\d)? does not cover the ₹[\d,]+(\.\d\d)? of interest/);
    } finally { await app.close(); }
  });
});

describe("WEALTH-37 · the prepayment calculator answers nonsense with a sentence", () => {
  const good = { principal: "500000", rate: "9", months: "120", amount: "10000", at_month: "12" };

  test("zero, text, negative, fractional and out-of-range inputs are 422s on POST and GET", async () => {
    const { app } = await setup();
    try {
      for (const over of [
        { months: "0" }, { principal: "0" }, { rate: "abc" }, { months: "abc" }, { rate: "-5" },
        { months: "1.5" }, { at_month: "0" }, { at_month: "121" }, { amount: "900000" },
      ]) {
        const form = { ...good, ...over };
        const post = await app.post("/loans/what-if", form);
        assert.equal(post.status, 422, `POST ${JSON.stringify(over)}`);
        assert.doesNotMatch(await post.text(), /NaN/);
        const get = await app.get(`/loans/what-if?${new URLSearchParams(form)}`);
        assert.equal(get.status, 422, `GET ${JSON.stringify(over)}`);
      }
    } finally { await app.close(); }
  });

  test("sound inputs, a 0% loan and the bare page still price", async () => {
    const { app } = await setup();
    try {
      assert.equal((await app.post("/loans/what-if", good)).status, 200);
      assert.equal((await app.post("/loans/what-if", { ...good, rate: "0" })).status, 200);
      assert.equal((await app.get("/loans/what-if")).status, 200);
    } finally { await app.close(); }
  });

  test("a loan's own prepay page opens on an amount that does not clear it", async () => {
    const { db, app, bank } = await setup();
    try {
      const small = createLoan(db, ravi, {
        lender: "Fictional Bank", loanType: "personal", sanctioned: rupees(60_000) as Paise,
        sanctionDate: "2025-01-01", interestModel: "reducing", annualRatePct: 12, tenureMonths: 12,
        currentOutstanding: rupees(60_000) as Paise, repaymentAccountId: bank,
      });
      const res = await app.get(`/loans/${small.id}/prepay`);
      assert.equal(res.status, 200);
      assert.doesNotMatch(await res.text(), /NaN/);
    } finally { await app.close(); }
  });
});

describe("WEALTH-20 · a loan with money outstanding is settled, not closed", () => {
  test("POST /loans/:id/close with ₹5,00,000 outstanding is a 422, and the loan stays open", async () => {
    const { db, app, loan } = await setup();
    try {
      const res = await app.post(`/loans/${loan.id}/close`, {});
      assert.equal(res.status, 422);
      assert.equal(count(db, `SELECT COUNT(*) AS n FROM loans WHERE id = ? AND closed_at IS NOT NULL`, loan.id), 0);
    } finally { await app.close(); }
  });
});
