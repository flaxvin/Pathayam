/**
 * "The first Sunday of each month", end to end.
 *
 * `monthly-nth-weekday` was in the `Recurrence` union and counted in the
 * annualisation table behind the subscriptions view, but `nextOccurrence()` had
 * no case for it: it fell through to the default and advanced by day of month.
 * A schedule set to the first Sunday would have landed on whatever date that
 * was when it was created and then stayed there for ever, saying nothing. It
 * was unreachable from the UI, which is the only reason nobody met it.
 *
 * And the value was never checked. Every route cast the form field —
 * `field(body, "recurrence") as Recurrence` — so any string at all was stored,
 * and then behaved as monthly. The column has no CHECK to catch it either.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import {
  createSchedule, updateSchedule, nextOccurrence, parseRecurrence,
  describeRecurrence, RECURRENCES, getSchedule,
} from "./schedules.ts";
import { Refusal } from "../core/refusal.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { IsoDate } from "../core/dates.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(100_000),
  }).id;
  const g = createGroup(db, actor, "Home");
  const help = createCategory(db, actor, { groupId: g.id, name: "Domestic help" }).id;
  return { db, bank, help };
}

function firstSunday(db: ReturnType<typeof setup>["db"], bank: string, help: string) {
  return createSchedule(db, actor, {
    name: "Domestic help", accountId: bank, categoryId: help,
    amount: -rupees(4_000) as Paise,
    recurrence: "monthly-nth-weekday",
    recurrenceOrdinal: 1, recurrenceWeekday: 0,
    nextDue: "2026-10-04" as IsoDate,
  });
}

describe("a schedule that falls on a weekday", () => {
  test("advances to the weekday, not to the same date next month", () => {
    const { db, bank, help } = setup();
    const s = firstSunday(db, bank, help);

    // The first Sundays: 4 Oct, 1 Nov, 6 Dec 2026, 3 Jan 2027.
    let at = nextOccurrence(s, "2026-10-04" as IsoDate);
    assert.equal(at, "2026-11-01", "it advanced by day of month instead of to the first Sunday");

    at = nextOccurrence({ ...s, next_due: at }, at!);
    assert.equal(at, "2026-12-06");

    at = nextOccurrence({ ...s, next_due: at }, at!);
    assert.equal(at, "2027-01-03");
  });

  test("an overdue schedule catches up to this month, not to next", () => {
    /*
     * `nextOccurrence` answers "the one after this", so `from` is the later of
     * next_due and the date asked about — the same contract the weekly case
     * has, where it returns next_due + 7. When a schedule has fallen behind,
     * `from` is today, and the occurrence still ahead in *this* month is the
     * right answer; jumping to next month would skip a payment.
     */
    const { db, bank, help } = setup();
    const s = firstSunday(db, bank, help);
    const behind = { ...s, next_due: "2026-09-06" as IsoDate };
    assert.equal(
      nextOccurrence(behind, "2026-10-01" as IsoDate), "2026-10-04",
      "it skipped a Sunday that had not happened yet",
    );
  });

  test("the last one in the month is not the fourth", () => {
    const { db, bank, help } = setup();
    const s = createSchedule(db, actor, {
      name: "Cleaner", accountId: bank, categoryId: help,
      amount: -rupees(1_000) as Paise,
      recurrence: "monthly-nth-weekday",
      recurrenceOrdinal: -1, recurrenceWeekday: 0,
      nextDue: "2026-10-25" as IsoDate,
    });
    // November 2026 has five Sundays: 1, 8, 15, 22, 29.
    assert.equal(nextOccurrence(s, "2026-10-25" as IsoDate), "2026-11-29");
  });

  test("the pair is stored, because a date cannot say which it meant", () => {
    const { db, bank, help } = setup();
    const s = firstSunday(db, bank, help);
    const row = getSchedule(db, s.id)!;
    assert.equal(row.recurrence_ordinal, 1);
    assert.equal(row.recurrence_weekday, 0);
    assert.equal(describeRecurrence(row), "The first Sunday of each month");
  });

  test("changing away from a weekday rule clears the pair", () => {
    // Left behind, it would be waiting to move somebody's payment to a day they
    // had not chosen if the schedule ever came back to a weekday rule.
    const { db, bank, help } = setup();
    const s = firstSunday(db, bank, help);
    const after = updateSchedule(db, actor, s.id, { recurrence: "monthly" });
    assert.equal(after.recurrence_ordinal, null);
    assert.equal(after.recurrence_weekday, null);
  });

  test("changing to a weekday rule keeps what was chosen with it", () => {
    const { db, bank, help } = setup();
    const s = createSchedule(db, actor, {
      name: "Rent", accountId: bank, categoryId: help,
      amount: -rupees(32_000) as Paise, recurrence: "monthly",
      nextDue: "2026-10-05" as IsoDate,
    });
    const after = updateSchedule(db, actor, s.id, {
      recurrence: "monthly-nth-weekday", recurrence_ordinal: -1, recurrence_weekday: 5,
    });
    assert.equal(after.recurrence_ordinal, -1);
    assert.equal(after.recurrence_weekday, 5);
    assert.equal(describeRecurrence(after), "The last Friday of each month");
  });

  test("a row written before the columns existed still advances sensibly", () => {
    // Nothing can have been written that way in practice, since the value was
    // unreachable — but a null pair must not throw, and the weekday of next_due
    // is the only guess available.
    const { db, bank, help } = setup();
    const s = firstSunday(db, bank, help);
    const legacy = { ...s, recurrence_ordinal: null, recurrence_weekday: null };
    assert.equal(nextOccurrence(legacy, "2026-10-04" as IsoDate), "2026-11-01");
  });
});

describe("the recurrence value is checked, not cast", () => {
  test("every value the app knows is accepted", () => {
    for (const r of RECURRENCES) assert.equal(parseRecurrence(r), r);
  });

  test("a typo is refused rather than silently becoming monthly", () => {
    assert.throws(
      () => parseRecurrence("fortnighly"),
      (e: Error) => e instanceof Refusal && /not a recurrence/.test(e.message),
      "an unknown value was accepted, and would have advanced monthly in silence",
    );
  });

  test("so is anything that is not a string at all", () => {
    for (const bad of [null, undefined, 7, {}, []]) {
      assert.throws(() => parseRecurrence(bad), Refusal, `${JSON.stringify(bad)} was accepted`);
    }
  });

  test("creating with a bad ordinal is refused", () => {
    const { db, bank, help } = setup();
    assert.throws(
      () => createSchedule(db, actor, {
        name: "Odd", accountId: bank, categoryId: help,
        amount: -rupees(100) as Paise, recurrence: "monthly-nth-weekday",
        recurrenceOrdinal: 5 as never, recurrenceWeekday: 0,
        nextDue: "2026-10-04" as IsoDate,
      }),
      Refusal,
      "a fifth weekday was accepted, and does not exist in every month",
    );
  });
});
