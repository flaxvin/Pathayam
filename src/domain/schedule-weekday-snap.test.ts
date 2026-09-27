/**
 * IMPORTS-SCHEDULES-13 · A "first Sunday" schedule's first due date is a first Sunday.
 *
 * createSchedule stored next_due as typed, and the form defaults it to today:
 * created on Wednesday 7 Oct 2026, "the first Sunday of each month" ran
 * 7 Oct, 1 Nov, 6 Dec — a payment on the calendar that the rule never names,
 * and one that Mark paid posted.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import type { IsoDate, WeekdayOrdinal } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createSchedule, updateSchedule, getSchedule } from "./schedules.ts";
import { freshHousehold, RAVI } from "../engine/identity.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

function setup() {
  const db = freshHousehold();
  const categoryId = createCategory(db, actor, { groupId: createGroup(db, actor, "ZZ G").id, name: "ZZ Chit" }).id;
  const accountId = createAccount(db, actor, {
    name: "ZZ Bank", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 500_000,
  }).id;
  const make = (nextDue: string, ordinal: WeekdayOrdinal = 1, weekday = 0) => createSchedule(db, actor, {
    name: "ZZ Chit fund", accountId, categoryId, amount: -200_000 as Paise, recurrence: "monthly-nth-weekday",
    recurrenceOrdinal: ordinal, recurrenceWeekday: weekday, nextDue: nextDue as IsoDate,
  });
  return { db, accountId, categoryId, make };
}

describe("IMPORTS-SCHEDULES-13 · a weekday rule's first date is on the rule", () => {
  test("created on a Wednesday, the first Sunday is next month's", () => {
    assert.equal(setup().make("2026-10-07").next_due, "2026-11-01");
  });

  test("a date already on the rule, or before this month's, is this month's", () => {
    const { make } = setup();
    assert.equal(make("2026-10-04").next_due, "2026-10-04");
    assert.equal(make("2026-10-01", -1, 5).next_due, "2026-10-30"); // last Friday
  });

  test("changing a schedule to a weekday rule lands its date on the rule", () => {
    const { db, accountId, categoryId } = setup();
    const s = createSchedule(db, actor, {
      name: "ZZ Chit fund", accountId, categoryId, amount: -200_000 as Paise,
      recurrence: "monthly", nextDue: "2026-10-07" as IsoDate,
    });
    updateSchedule(db, actor, s.id, { recurrence: "monthly-nth-weekday", recurrence_ordinal: 2, recurrence_weekday: 6 });
    assert.equal(getSchedule(db, s.id)!.next_due, "2026-10-10"); // second Saturday
    updateSchedule(db, actor, s.id, { next_due: "2026-10-11" as IsoDate });
    assert.equal(getSchedule(db, s.id)!.next_due, "2026-11-14");
    updateSchedule(db, actor, s.id, { name: "ZZ Chit" });
    assert.equal(getSchedule(db, s.id)!.next_due, "2026-11-14");
  });
});
