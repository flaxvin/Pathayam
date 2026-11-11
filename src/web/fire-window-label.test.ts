/**
 * UI-16 · The FIRE page names the history it annualised.
 *
 * Weekly UI pass 11-11-2026: a household one day old, ₹3,250 spent today, read
 * "Spending, last 1 months, annualised ₹11,86,250" — the figure is one day
 * times 365, and "1 months" is not a phrase. Short histories are now counted
 * in days, and one month is "1 month".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransaction } from "../domain/transactions.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST } from "../core/dates.ts";
import { spendingWindowLabel } from "./pages/fire.ts";

test("the window is said in days while it is short, and singular when it is one", () => {
  assert.equal(spendingWindowLabel(1), "last 1 day");
  assert.equal(spendingWindowLabel(12), "last 12 days");
  assert.equal(spendingWindowLabel(59), "last 59 days");
  assert.equal(spendingWindowLabel(60), "last 2 months");
  assert.equal(spendingWindowLabel(365), "last 12 months");
});

test("a household one day old reads one day, not '1 months'", async () => {
  const db = freshDb();
  seedMember(db, "m-asha", "Asha");
  const actor = { memberId: "m-asha", source: "ui" as const };
  const bank = createAccount(db, actor, {
    name: "Savings", kind: "budget", subtype: "savings",
    openingDate: todayIST(), openingBalance: rupees(2_00_000),
  });
  const group = createGroup(db, actor, "Flexible");
  const food = createCategory(db, actor, { groupId: group.id, name: "Groceries" });
  createTransaction(db, actor, { accountId: bank.id, amount: -rupees(3_250) as Paise, categoryId: food.id, date: todayIST() });
  const app = await startTestApp(db, { memberId: "m-asha" });
  try {
    const page = (await (await app.get("/fire")).text()).replace(/\s+/g, " ");
    assert.match(page, /Spending, last 1 day, annualised/);
    assert.doesNotMatch(page, /1 months/);
    assert.deepEqual(app.failures, []);
  } finally {
    await app.close();
  }
});
