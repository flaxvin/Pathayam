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
  createSchedule, getSchedule, updateSchedule, skipOccurrence, markPaid, projectCashflow,
  type Recurrence, type Schedule,
} from "./schedules.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { IsoDate } from "../core/dates.ts";
import { execute } from "../db/db.ts";
import { historyFor, undoEvent } from "../core/events.ts";

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

/*
 * S2 · Month-based schedules lost their anchor day. The day was read from the
 * current next_due, which is where the last occurrence *landed*: 31 Jan went to
 * 28 Feb, then 28 Mar, 28 Apr and the 28th for ever. Quarterly from 30 Nov sat
 * on the 28th after February; yearly 29 Feb 2028 was 28 Feb even in 2032; and
 * "next-day" put a 31st on the 1st of every month. The anchor day is now kept
 * in its own column (recurrence_day). The migration is added separately, so
 * these tests add the column themselves — exactly the ALTER the lead applies.
 */
function anchored() {
  const ctx = setup();
  execute(ctx.db, `ALTER TABLE schedules ADD COLUMN recurrence_day INTEGER`);
  return ctx;
}

describe("S2 · a month-based schedule keeps the day it was set to", () => {
  test("monthly on the 31st goes back to the 31st after February", () => {
    const ctx = anchored();
    const s = schedule(ctx, "monthly", "2026-01-31", "last-day");
    assert.deepEqual(
      walk(ctx, s.id, 4),
      ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"],
      "it stayed on the 28th after February",
    );
  });

  test("monthly on the 30th", () => {
    const ctx = anchored();
    const s = schedule(ctx, "monthly", "2026-01-30", "last-day");
    assert.deepEqual(walk(ctx, s.id, 2), ["2026-01-30", "2026-02-28", "2026-03-30"]);
  });

  test("quarterly from 30 Nov and half-yearly from 31 Aug", () => {
    const ctx = anchored();
    const q = schedule(ctx, "quarterly", "2025-11-30", "last-day");
    assert.deepEqual(walk(ctx, q.id, 3), ["2025-11-30", "2026-02-28", "2026-05-30", "2026-08-30"]);
    const h = schedule(ctx, "half-yearly", "2025-08-31", "last-day");
    assert.deepEqual(walk(ctx, h.id, 2), ["2025-08-31", "2026-02-28", "2026-08-31"]);
  });

  test("yearly on 29 Feb is 29 Feb again in 2032", () => {
    const ctx = anchored();
    const s = schedule(ctx, "yearly", "2028-02-29", "last-day");
    assert.deepEqual(
      walk(ctx, s.id, 4),
      ["2028-02-29", "2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29"],
    );
  });

  test("'next-day' spills into the 1st only in the month that needs it", () => {
    const ctx = anchored();
    const s = schedule(ctx, "monthly", "2026-01-31", "next-day");
    assert.deepEqual(
      walk(ctx, s.id, 7),
      ["2026-01-31", "2026-03-01", "2026-03-31", "2026-05-01", "2026-05-31",
        "2026-07-01", "2026-07-31", "2026-08-31"],
      "it moved to the 1st for good (or skipped March's own 31st)",
    );
    const y = schedule(ctx, "yearly", "2028-02-29", "next-day");
    assert.deepEqual(
      walk(ctx, y.id, 4),
      ["2028-02-29", "2029-03-01", "2030-03-01", "2031-03-01", "2032-02-29"],
    );
  });

  test("the projection follows the anchor too", () => {
    const ctx = anchored();
    schedule(ctx, "monthly", "2027-01-31", "last-day");
    const cash = projectCashflow(ctx.db, { today: "2027-01-01" as IsoDate, days: 120 });
    const dates = cash.days.filter((d) => d.outflows.some((o) => o.label === "Rent")).map((d) => d.date);
    assert.deepEqual(dates, ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
  });

  test("editing the amount does not re-anchor the rent on the 28th", () => {
    // The edit form posts next_due back as it stands — 28 Feb for a 31st rent.
    const ctx = anchored();
    const s = schedule(ctx, "monthly", "2026-01-31", "last-day");
    skipOccurrence(ctx.db, actor, s.id);
    updateSchedule(ctx.db, actor, s.id, {
      amount: -rupees(200) as Paise, next_due: "2026-02-28" as IsoDate,
    });
    skipOccurrence(ctx.db, actor, s.id);
    assert.equal(getSchedule(ctx.db, s.id)!.next_due, "2026-03-31");
  });

  test("moving the due date moves the anchor, and undoing the move puts it back", () => {
    const ctx = anchored();
    const s = schedule(ctx, "monthly", "2026-01-31", "last-day");
    updateSchedule(ctx.db, actor, s.id, { next_due: "2026-03-15" as IsoDate });
    assert.equal(getSchedule(ctx.db, s.id)!.recurrence_day, 15);
    const edit = historyFor(ctx.db, "schedule", s.id).find((e) => e.action === "update")!;
    assert.ok(undoEvent(ctx.db, edit.id, actor).ok);
    assert.equal(getSchedule(ctx.db, s.id)!.recurrence_day, 31);
  });

  test("without the column it still advances, reading the day from next_due", () => {
    const ctx = setup();
    const s = schedule(ctx, "monthly", "2026-01-15", "last-day");
    assert.equal(getSchedule(ctx.db, s.id)!.recurrence_day, undefined);
    assert.deepEqual(walk(ctx, s.id, 2), ["2026-01-15", "2026-02-15", "2026-03-15"]);
  });
});
