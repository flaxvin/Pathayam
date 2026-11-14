/**
 * Decision 7 (UI-8) · /move refuses to take an envelope below zero beyond what
 * it holds, unless "Allow it to go below zero" is ticked.
 *
 * Moving ₹99,999 from Groceries (holding ₹7,310) to Fuel said "Money moved."
 * and left Groceries at −₹92,689. Now it is refused with what Groceries holds,
 * and the form comes back with what was typed (no script needed). Covering an
 * overspent envelope from one that can spare it still works.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import type { DB } from "../db/db.ts";
import { queryOne } from "../db/db.ts";
import { monthOf, todayIST } from "../core/dates.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { startTestApp, seedMember, freshDb, type TestApp } from "./harness.test-data.ts";

const actor: Actor = { memberId: "m", source: "ui" };
const month = monthOf(todayIST());

let db: DB;
let app: TestApp;
let groceries: string;
let fuel: string;
let eatingOut: string;

const assigned = (category: string) =>
  queryOne<{ amount: number }>(
    db, `SELECT COALESCE(SUM(amount),0) AS amount FROM assignments WHERE category_id = ? AND month = ?`,
    category, month,
  )!.amount;

before(async () => {
  db = freshDb();
  seedMember(db);
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: `${month}-01`, openingBalance: rupees(50_000),
  }).id;
  const group = createGroup(db, actor, "Everyday").id;
  groceries = createCategory(db, actor, { groupId: group, name: "Groceries" }).id;
  fuel = createCategory(db, actor, { groupId: group, name: "Fuel" }).id;
  eatingOut = createCategory(db, actor, { groupId: group, name: "Eating out" }).id;
  setAssigned(db, actor, month, groceries, rupees(7_310));
  // Eating out is overspent by ₹1,200.
  createTransaction(db, actor, {
    accountId: bank, date: `${month}-01`, amount: -rupees(1_200), categoryId: eatingOut,
  });
  app = await startTestApp(db);
});
after(async () => {
  await app.close();
});

test("the form offers the tick", async () => {
  const page = await (await app.get(`/move?month=${month}`)).text();
  assert.match(page, /name="allow_below_zero"/);
  assert.match(page, /Allow it to go below zero/);
});

test("moving more than the source holds is refused, saying how much it holds, and keeps what was typed", async () => {
  const res = await app.post("/move", {
    month, from_category_id: groceries, to_category_id: fuel, amount: "99,999",
  });
  assert.equal(res.status, 422);
  const body = await res.text();
  assert.match(body, /Groceries holds ₹7,310, so moving ₹99,999 would leave it at -₹92,689/);
  assert.match(body, /Allow it to go below zero/);
  assert.match(body, new RegExp(`<option value="${groceries}" selected>`));
  assert.match(body, /value="99999.00"/);
  assert.equal(assigned(groceries), rupees(7_310), "nothing moved");
  assert.equal(assigned(fuel), 0);
});

test("with the script the refusal comes back as the form's error", async () => {
  const res = await app.post("/move", {
    month, from_category_id: groceries, to_category_id: fuel, amount: "99999",
  }, { headers: { Accept: "application/json" } });
  assert.equal(res.status, 422);
  assert.match((await res.json() as { error: string }).error, /Groceries holds ₹7,310/);
  assert.equal(assigned(groceries), rupees(7_310));
});

test("ticked, it moves and the source goes below zero", async () => {
  const res = await app.post("/move", {
    month, from_category_id: groceries, to_category_id: fuel, amount: "8,000", allow_below_zero: "1",
  });
  assert.equal(res.status, 303);
  assert.equal(assigned(groceries), rupees(7_310 - 8_000));
  assert.equal(assigned(fuel), rupees(8_000));
  // Put it back for the next test.
  await app.post("/move", {
    month, from_category_id: fuel, to_category_id: groceries, amount: "8,000",
  });
  assert.equal(assigned(groceries), rupees(7_310));
});

test("covering an overspent envelope from one that can spare it still works, and up to all it holds", async () => {
  const res = await app.post("/move", {
    month, from_category_id: groceries, to_category_id: eatingOut, amount: "1,200",
  });
  assert.equal(res.status, 303);
  assert.equal(assigned(eatingOut), rupees(1_200));
  const all = await app.post("/move", {
    month, from_category_id: groceries, to_category_id: fuel, amount: "6,110",
  });
  assert.equal(all.status, 303, "moving exactly what it holds is fine");
  assert.equal(assigned(groceries), rupees(7_310 - 1_200 - 6_110));
  assert.deepEqual(app.failures, []);
});

test("an envelope already below zero cannot be moved from without the tick", async () => {
  const res = await app.post("/move", {
    month, from_category_id: eatingOut, to_category_id: fuel, amount: "1",
  });
  // Eating out now holds ₹0 (₹1,200 assigned, ₹1,200 spent).
  assert.equal(res.status, 422);
  assert.match(await res.text(), /Eating out holds ₹0, so moving ₹1 would leave it at -₹1/);
});
