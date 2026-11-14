/**
 * Decision 5 (E1) · A goal's monthly figure starts from what was saved at the
 * start of this month.
 *
 * ₹1,20,000 due next month with ₹60,000 assigned this month read "₹60,000 to
 * go. Putting ₹30,000 aside each month for the next 2", which leaves next
 * month ₹30,000 short. This month's share is ₹60,000 and it is in, so the rest
 * is ₹60,000 next month.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import type { DB } from "../db/db.ts";
import { todayIST, monthOf, addMonths, lastDayOfMonth, formatMonth } from "../core/dates.ts";
import { createAccount } from "../domain/accounts.ts";
import { setAssigned } from "../domain/budget.ts";
import { createGoal, goalCategoryIds, goalProgress } from "../domain/goals.ts";
import { aiGoals } from "../ai/analysis.ts";
import { startTestApp, seedMember, freshDb, type TestApp } from "./harness.test-data.ts";

const actor: Actor = { memberId: "m", source: "ui" };

let db: DB;
let app: TestApp;
const month = monthOf(todayIST());
const next = addMonths(month, 1);
const nextName = formatMonth(next).split(" ")[0]!;

before(async () => {
  db = freshDb();
  seedMember(db);
  createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: `${month}-01`, openingBalance: rupees(2_00_000),
  });
  const goal = createGoal(db, actor, {
    name: "Laptop", targetAmount: rupees(1_20_000), targetDate: lastDayOfMonth(next),
  });
  setAssigned(db, actor, month, goalCategoryIds(db, goal.id)[0]!, rupees(60_000));
  app = await startTestApp(db);
});
after(async () => {
  await app.close();
});

test("the Goals page: this month's share is in, so it asks ₹60,000 next month", async () => {
  const body = await (await app.get("/goals")).text();
  assert.match(body, new RegExp(`This month(?:'|&#39;)s share is in; ₹60,000 in ${nextName} gets you there on time`));
  assert.doesNotMatch(body, /₹30,000 aside each month/);
  assert.deepEqual(app.failures, []);
});

test("the analysis tool gives the same figure and says it starts next month", () => {
  const [g] = aiGoals(db, "m").goals as { required_monthly: number; months_remaining: number; monthly_from: string }[];
  assert.equal(g!.required_monthly, 60_000);
  assert.equal(g!.months_remaining, 1);
  assert.equal(g!.monthly_from, next);
});

function only(balance: number, opening: number, target = rupees(1_20_000), months = 2) {
  const d = freshDb();
  seedMember(d);
  const due = lastDayOfMonth(addMonths("2026-11", months - 1));
  const goal = createGoal(d, actor, { name: "Trip", targetAmount: target, targetDate: due });
  const id = goalCategoryIds(d, goal.id)[0]!;
  const [p] = goalProgress(d, new Map([[id, { name: "Trip", balance, opening }]]), "2026-11-14");
  return p!;
}

test("nothing in yet: the share is worked out from the start of the month, over every month left", () => {
  const p = only(0, 0);
  assert.equal(p.requiredMonthly, rupees(60_000));
  assert.equal(p.monthsRemaining, 2);
  assert.equal(p.monthlyFrom, "2026-11");
  assert.match(p.reading, /Putting ₹60,000 aside each month for the next 2/);
});

test("part of this month's share in: the figure stays at the share and says what is still to go", () => {
  const p = only(rupees(20_000), 0);
  assert.equal(p.requiredMonthly, rupees(60_000));
  assert.equal(p.stillThisMonth, rupees(40_000));
  assert.match(p.reading, /₹40,000 more this month keeps you on track/);
});

test("saved earlier counts from the start: ₹30,000 opening, ₹45,000 in this month covers it", () => {
  // Share = (1,20,000 − 30,000) / 2 = 45,000; the rest 45,000 next month.
  const p = only(rupees(75_000), rupees(30_000));
  assert.equal(p.monthlyFrom, "2026-12");
  assert.equal(p.requiredMonthly, rupees(45_000));
  assert.match(p.reading, /₹45,000 in December/);
});

test("more months: once covered, the rest is spread from next month", () => {
  const p = only(rupees(40_000), 0, rupees(1_20_000), 3);
  assert.equal(p.monthlyFrom, "2026-12");
  assert.equal(p.monthsRemaining, 2);
  assert.equal(p.requiredMonthly, rupees(40_000));
  assert.match(p.reading, /₹40,000 a month from December, for 2 months/);
});
