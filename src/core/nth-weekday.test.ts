/**
 * "The first Sunday of each month", as arithmetic.
 *
 * The cases that matter are the boundaries: a month whose 1st already falls on
 * the weekday wanted, a month where it falls the day after, and "last" in a
 * month with five of them — where last and fourth are different dates, which is
 * the whole reason "last" exists as its own value rather than a fifth ordinal.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { nthWeekdayOfMonth, weekdayOf, type MonthKey } from "./dates.ts";

describe("the nth weekday of a month", () => {
  test("the first Sunday, across months that start differently", () => {
    // 2026-11-01 is itself a Sunday; 2026-10-01 is a Thursday.
    assert.equal(nthWeekdayOfMonth("2026-11" as MonthKey, 0, 1), "2026-11-01");
    assert.equal(nthWeekdayOfMonth("2026-10" as MonthKey, 0, 1), "2026-10-04");
  });

  test("later ordinals are simply seven days apart", () => {
    assert.equal(nthWeekdayOfMonth("2026-10" as MonthKey, 0, 2), "2026-10-11");
    assert.equal(nthWeekdayOfMonth("2026-10" as MonthKey, 0, 3), "2026-10-18");
    assert.equal(nthWeekdayOfMonth("2026-10" as MonthKey, 0, 4), "2026-10-25");
  });

  test("last is not fourth when the month holds five", () => {
    // October 2026 has Sundays on the 4th, 11th, 18th and 25th — four of them.
    assert.equal(nthWeekdayOfMonth("2026-10" as MonthKey, 0, -1), "2026-10-25");
    // November 2026 has five: 1, 8, 15, 22, 29.
    assert.equal(nthWeekdayOfMonth("2026-11" as MonthKey, 0, 4), "2026-11-22");
    assert.equal(
      nthWeekdayOfMonth("2026-11" as MonthKey, 0, -1), "2026-11-29",
      "last collapsed to fourth, which is the bug that makes 'fifth' unusable",
    );
  });

  test("the last day of the month being the weekday wanted", () => {
    // 2026-10-31 is a Saturday, so the last Saturday is the 31st itself.
    assert.equal(nthWeekdayOfMonth("2026-10" as MonthKey, 6, -1), "2026-10-31");
  });

  test("February, including a leap year", () => {
    assert.equal(nthWeekdayOfMonth("2027-02" as MonthKey, 1, -1), "2027-02-22");
    assert.equal(nthWeekdayOfMonth("2028-02" as MonthKey, 1, -1), "2028-02-28");
  });

  test("every result really is the weekday asked for", () => {
    for (let m = 1; m <= 12; m++) {
      const month = `2027-${String(m).padStart(2, "0")}` as MonthKey;
      for (let wd = 0; wd <= 6; wd++) {
        for (const ord of [1, 2, 3, 4, -1] as const) {
          const date = nthWeekdayOfMonth(month, wd, ord);
          assert.equal(weekdayOf(date), wd, `${month} ord ${ord} wd ${wd} -> ${date}`);
          assert.equal(date.slice(0, 7), month, `${date} left ${month}`);
        }
      }
    }
  });
});
