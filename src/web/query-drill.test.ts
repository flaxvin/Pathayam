/**
 * /query: what a figure drills into is the figure.
 *
 * WEALTH-33 · A group's link carried the period and category only, so a
 * Groceries group of −₹2,000 filtered to the card opened on −₹5,000 across
 * every account.
 *
 * WEALTH-34 · An EMI's loan-account leg was counted as money "In".
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import { todayIST } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { createLoan, recordInstalment } from "../domain/loans.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

const ravi: Actor = { memberId: "m", source: "ui" };

/** A headline figure ("In", "Out") on a /query page. */
const figure = (page: string, label: string) =>
  page.match(new RegExp(`<div class="faint">${label}</div>\\s*<strong[^>]*>([^<]+)<`))?.[1]?.trim();
const out = (page: string) => figure(page, "Out");

describe("WEALTH-33 · a group's drill-down keeps the filter", () => {
  test("filtered to one account, the category link opens that account's spending", async () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    const bank = createAccount(db, ravi, {
      name: "Bank", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: rupees(50_000),
    }).id;
    const card = createAccount(db, ravi, {
      name: "Fictional Card", kind: "credit", subtype: "credit-card", openingDate: "2026-01-01", openingBalance: 0,
    }).id;
    const groceries = createCategory(db, ravi, { groupId: createGroup(db, ravi, "Living").id, name: "Groceries" }).id;
    const today = todayIST();
    createTransaction(db, ravi, { accountId: bank, amount: -rupees(3_000), date: today, categoryId: groceries, memo: "Veg from the bank" });
    createTransaction(db, ravi, { accountId: card, amount: -rupees(2_000), date: today, categoryId: groceries, memo: "Veg on the card" });

    const app = await startTestApp(db, { memberId: "m" });
    try {
      const page = await (await app.get(`/query?period=this-month&account=${card}&group_by=category`)).text();
      const link = page.match(/<a href="([^"]*category=[^"]*)">Groceries<\/a>/)?.[1]?.replace(/&amp;/g, "&");
      assert.ok(link, "the Groceries group links to its transactions");
      assert.match(link!, new RegExp(`account=${card}`));

      const drilled = await (await app.get(link!)).text();
      assert.equal(out(drilled), "-₹2,000");
    } finally {
      await app.close();
    }
  });
});

describe("WEALTH-34 · a loan's own ledger is not money in", () => {
  test("paying an EMI from the bank is Out only; the loan's rows are there when asked for", async () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    const bank = createAccount(db, ravi, {
      name: "Bank", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: rupees(50_000),
    }).id;
    const loan = createLoan(db, ravi, {
      lender: "Fictional Bank", loanType: "personal", sanctioned: rupees(100_000), sanctionDate: "2026-01-01",
      interestModel: "reducing", annualRatePct: 12, tenureMonths: 12,
      currentOutstanding: rupees(100_000), repaymentAccountId: bank,
    });
    recordInstalment(db, ravi, { loanId: loan.id, date: todayIST(), amount: rupees(8_885), fromAccountId: bank });

    const app = await startTestApp(db, { memberId: "m" });
    try {
      const page = await (await app.get("/query?period=this-month")).text();
      assert.equal(figure(page, "In"), "₹0");
      assert.equal(out(page), "-₹8,885");

      const csv = await (await app.get("/query.csv?period=this-month")).text();
      // The loan account ("Fictional Bank Personal loan") has no row in it.
      assert.doesNotMatch(csv, /Personal loan/);

      const own = await (await app.get(`/query?period=this-month&account=${loan.account_id}`)).text();
      assert.equal(figure(own, "In"), "₹8,885");
    } finally {
      await app.close();
    }
  });
});
