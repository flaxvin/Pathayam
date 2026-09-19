/**
 * Splitting a transaction as you enter it.
 *
 * A supermarket bill that is half groceries and half household is the ordinary
 * shape of a supermarket bill, and this form could not express it: the lines
 * existed on the edit screen only, so the way to record one was to save it
 * wrong and then correct it.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, testConfig, type TestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned } from "../domain/budget.ts";
import { getSplits } from "../domain/transactions.ts";
import { rupees, formatPaise } from "../core/money.ts";
import { queryOne } from "../db/db.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };
let app: TestApp;
let db: ReturnType<typeof freshDb>;
let bank: string, groceries: string, household: string;

before(async () => {
  db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(100_000),
  }).id;
  const g = createGroup(db, actor, "Flexible");
  groceries = createCategory(db, actor, { groupId: g.id, name: "Groceries" }).id;
  household = createCategory(db, actor, { groupId: g.id, name: "Household" }).id;
  setAssigned(db, actor, "2026-09", groceries, rupees(10_000));
  setAssigned(db, actor, "2026-09", household, rupees(5_000));
  app = await startTestApp(db, { memberId: "m-ravi", config: testConfig({}) });
});
after(async () => { await app.close(); });

function latest() {
  return queryOne<{ id: string; category_id: string | null; amount: number }>(
    db, `SELECT id, category_id, amount FROM transactions ORDER BY created_at DESC LIMIT 1`,
  )!;
}

describe("splitting at entry", () => {
  test("two lines become a split transaction", async () => {
    const res = await app.post("/add", {
      account_id: bank, amount: "2400", direction: "out", date: "2026-09-10",
      payee: "Big Bazaar",
      split_category_0: groceries, split_amount_0: "1500",
      split_category_1: household, split_amount_1: "900",
    });
    assert.equal(res.status, 303);

    const txn = latest();
    assert.equal(txn.amount, -rupees(2_400));
    assert.equal(txn.category_id, null, "a category and lines were both set, filing it twice");

    const lines = getSplits(db, txn.id);
    assert.equal(lines.length, 2);
    assert.equal(
      lines.reduce((t, l) => t + l.amount, 0), -rupees(2_400),
      `the lines do not add up to the transaction`,
    );
  });

  test("lines that do not add up are refused", async () => {
    const res = await app.post("/add", {
      account_id: bank, amount: "2400", direction: "out", date: "2026-09-10",
      split_category_0: groceries, split_amount_0: "1500",
      split_category_1: household, split_amount_1: "500",
    });
    assert.ok(res.status >= 400, "a split that is ₹400 short was accepted");
  });

  test("the category is not required when the lines carry it", async () => {
    // Money out normally demands an envelope; the lines are that envelope.
    const res = await app.post("/add", {
      account_id: bank, amount: "1000", direction: "out", date: "2026-09-11",
      split_category_0: groceries, split_amount_0: "600",
      split_category_1: household, split_amount_1: "400",
    });
    assert.equal(res.status, 303);
  });

  test("with no lines, money out still demands an envelope", async () => {
    const res = await app.post("/add", {
      account_id: bank, amount: "500", direction: "out", date: "2026-09-12",
    });
    assert.equal(res.status, 400, "the B99 rule was lost when splits were added");
  });

  test("an ordinary single-category entry is unaffected", async () => {
    const res = await app.post("/add", {
      account_id: bank, amount: "300", direction: "out", date: "2026-09-13",
      category_id: groceries,
    });
    assert.equal(res.status, 303);
    assert.equal(latest().category_id, groceries);
  });

  test("income splits keep the sign of income", async () => {
    const res = await app.post("/add", {
      account_id: bank, amount: "5000", direction: "in", date: "2026-09-14",
      split_category_0: groceries, split_amount_0: "3000",
      split_category_1: household, split_amount_1: "2000",
    });
    assert.equal(res.status, 303);
    const txn = latest();
    assert.equal(txn.amount, rupees(5_000), `income was recorded as ${formatPaise(txn.amount as never)}`);
    assert.ok(getSplits(db, txn.id).every((l) => l.amount > 0), "a positive split went in negative");
  });
});
