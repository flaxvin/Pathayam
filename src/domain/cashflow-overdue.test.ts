/**
 * DEBUG-ENGINE-15 · A schedule that has not been ticked off for a long while
 * still costs money in the days ahead.
 *
 * The projection walked each schedule forward from its next due date, at most
 * 400 steps. A daily milk delivery nobody marks paid fell behind by 400 days
 * after thirteen months — and from then on it was gone from "Will you make
 * it?" entirely: ₹60 a day, ₹3,600 over the 60-day window, not projected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createSchedule, projectCashflow } from "./schedules.ts";
import { rupees, type Paise } from "../core/money.ts";
import { addDays, type IsoDate } from "../core/dates.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

test("a daily schedule 500 days behind is still projected every day ahead", () => {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const today = "2026-10-22" as IsoDate;
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2024-01-01", openingBalance: rupees(50_000) as Paise,
  }).id;
  const group = createGroup(db, actor, "Everyday");
  const milk = createCategory(db, actor, { groupId: group.id, name: "Milk" }).id;
  createSchedule(db, actor, {
    name: "Milk", accountId: bank, categoryId: milk, amount: -rupees(60) as Paise,
    recurrence: "daily", nextDue: addDays(today, -500),
  });

  const cashflow = projectCashflow(db, { today, days: 10 });
  const milkDays = cashflow.days.filter((d) => d.outflows.some((o) => o.label === "Milk"));
  assert.equal(milkDays.length, 11, "today and each of the next ten days");
  assert.equal(cashflow.lowestBalance, rupees(50_000 - 60 * 11));
  db.close();
});
