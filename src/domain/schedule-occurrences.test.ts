/**
 * Where a schedule goes after this occurrence.
 *
 * S1 · The "skip" short-month policy ended a schedule at the first short month.
 * A rent on the 31st from 31 Jan 2026 was "next due never" once February came
 * round: resolveDayOfMonth answers null for a month without the day, and that
 * null was stored as next_due. The same for the 29th, quarterly from 30 Nov and
 * yearly on 29 Feb — and the cashflow projection then showed the schedule once
 * a year. "Skip" means skip that month and carry on.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import {
  createSchedule, getSchedule, skipOccurrence, markPaid, projectCashflow,
  type Recurrence, type Schedule,
} from "./schedules.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { IsoDate } from "../core/dates.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(100_000),
  }).id;
  const g = createGroup(db, actor, "Home");
  const rent = createCategory(db, actor, { groupId: g.id, name: "Rent" }).id;
  return { db, bank, rent };
}

function schedule(
  ctx: ReturnType<typeof setup>, recurrence: Recurrence, nextDue: string,
  policy: Schedule["short_month_policy"],
) {
  return createSchedule(ctx.db, actor, {
    name: "Rent", accountId: ctx.bank, categoryId: ctx.rent,
    amount: -rupees(100) as Paise, recurrence, nextDue: nextDue as IsoDate,
    shortMonthPolicy: policy,
  });
}

/** Skip `count` occurrences in a row and return every next_due seen. */
function walk(ctx: ReturnType<typeof setup>, id: string, count: number): (string | null)[] {
  const seen: (string | null)[] = [getSchedule(ctx.db, id)!.next_due];
  for (let i = 0; i < count; i++) {
    skipOccurrence(ctx.db, actor, id);
    seen.push(getSchedule(ctx.db, id)!.next_due);
  }
  return seen;
}

describe("S1 · 'skip' skips the short month and carries on", () => {
  test("monthly on the 31st: February and the 30-day months are skipped, not the schedule", () => {
    const ctx = setup();
    const s = schedule(ctx, "monthly", "2026-01-31", "skip");
    assert.deepEqual(
      walk(ctx, s.id, 5),
      ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31", "2026-08-31", "2026-10-31"],
      "the schedule ended at February (next due never)",
    );
  });

  test("monthly on the 29th skips February 2026 only", () => {
    const ctx = setup();
    const s = schedule(ctx, "monthly", "2026-01-29", "skip");
    assert.deepEqual(walk(ctx, s.id, 2), ["2026-01-29", "2026-03-29", "2026-04-29"]);
  });

  test("quarterly from 30 Nov skips the February occurrence", () => {
    const ctx = setup();
    const s = schedule(ctx, "quarterly", "2025-11-30", "skip");
    assert.deepEqual(walk(ctx, s.id, 2), ["2025-11-30", "2026-05-30", "2026-08-30"]);
  });

  test("yearly on 29 Feb comes back in the next leap year", () => {
    const ctx = setup();
    const s = schedule(ctx, "yearly", "2028-02-29", "skip");
    assert.deepEqual(walk(ctx, s.id, 1), ["2028-02-29", "2032-02-29"]);
  });

  test("marking it paid on the due date moves on the same way", () => {
    const ctx = setup();
    const s = schedule(ctx, "monthly", "2026-01-31", "skip");
    markPaid(ctx.db, actor, s.id, "2026-01-31" as IsoDate);
    assert.equal(getSchedule(ctx.db, s.id)!.next_due, "2026-03-31");
  });

  test("the projection shows it every month that has the day, not once", () => {
    const ctx = setup();
    schedule(ctx, "monthly", "2027-01-31", "skip");
    const cash = projectCashflow(ctx.db, { today: "2027-01-01" as IsoDate, days: 365 });
    const dates = cash.days.filter((d) => d.outflows.some((o) => o.label === "Rent")).map((d) => d.date);
    assert.deepEqual(dates, [
      "2027-01-31", "2027-03-31", "2027-05-31", "2027-07-31", "2027-08-31",
      "2027-10-31", "2027-12-31",
    ]);
  });
});
