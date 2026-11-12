/**
 * WEB-3 · The budget page's digest under a plan without schedules.
 *
 * PLAN-1 promises a module that is off disappears and nothing links to it.
 * The digest at the top of the budget page did not know about modules: with
 * FEATURE_SCHEDULES off, a subscription confirmed before the switch still
 * told the member "Fictional Stream renews tomorrow — ₹649" with a link to
 * /schedules, which answers 404 on this instance.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import type { Actor } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, addDays } from "../core/dates.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createSchedule } from "../domain/schedules.ts";

const RAVI = "m-ravi";
const ravi: Actor = { memberId: RAVI, source: "ui" };

function household() {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  const bank = createAccount(db, ravi, {
    name: "Fictional Savings", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(50_000) as Paise,
  });
  const group = createGroup(db, ravi, "Bills");
  const category = createCategory(db, ravi, { groupId: group.id, name: "Streaming" });
  createSchedule(db, ravi, {
    name: "Fictional Stream", accountId: bank.id, categoryId: category.id,
    amount: -rupees(649) as Paise, recurrence: "monthly", nextDue: addDays(todayIST(), 1),
    isSubscription: true,
  });
  return db;
}

describe("WEB-3 · the digest links only to modules this instance offers", () => {
  test("schedules on: the renewal is there, linking to Schedules", async () => {
    const db = household();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const page = await (await app.get("/")).text();
      assert.match(page, /Fictional Stream renews tomorrow/);
      assert.match(page, /href="\/schedules"/);
    } finally {
      await app.close();
    }
  });

  test("schedules off: no renewal, and no link to /schedules", async () => {
    const db = household();
    const app = await startTestApp(db, { memberId: RAVI, config: { features: { schedules: false } } });
    try {
      const page = await (await app.get("/")).text();
      assert.doesNotMatch(page, /href="\/schedules/);
      assert.doesNotMatch(page, /Fictional Stream renews/);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
