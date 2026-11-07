/**
 * The period presets on /query and /reports.
 *
 * WEALTH-24 · Every query reads `to` as inclusive, and "Last month" ended on
 * the 1st of this month — so this month's salary, paid on the 1st, was in last
 * month's In total and CSV as well as this month's.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { periodFor } from "./reports.ts";

describe("WEALTH-24 · last month", () => {
  test("ends on its own last day, not on the 1st of this month", () => {
    assert.deepEqual(
      { from: periodFor("last-month", "2026-09-15").from, to: periodFor("last-month", "2026-09-15").to },
      { from: "2026-08-01", to: "2026-08-31" },
    );
  });

  test("across a year end and a short February", () => {
    assert.equal(periodFor("last-month", "2026-01-01").to, "2025-12-31");
    assert.equal(periodFor("last-month", "2024-03-01").to, "2024-02-29");
    assert.equal(periodFor("last-month", "2024-03-01").from, "2024-02-01");
  });

  test("does not overlap this month", () => {
    const today = "2026-09-01";
    assert.ok(periodFor("last-month", today).to < periodFor("this-month", today).from);
  });
});

/*
 * REPORTS-1 · "Last 12 months" ran from today − 365 to today, both ends
 * counted: 366 days, so on payday it held thirteen salaries — the In total
 * and the income-vs-spending chart a twelfth high. "Last 3 months" likewise
 * held 91 days. Each now starts the day after the same date that many months
 * ago, so a monthly payment lands in it exactly 12 (or 3) times.
 */
describe("REPORTS-1 · the trailing presets", () => {
  test("last 12 months does not include the same day a year ago", () => {
    assert.equal(periodFor("last-12", "2026-10-27").from, "2025-10-28");
    assert.equal(periodFor("last-12", "2026-10-27").to, "2026-10-27");
  });

  test("last 3 months does not include the same day three months ago", () => {
    assert.equal(periodFor("last-3", "2026-10-27").from, "2026-07-28");
  });

  test("a month end, and a leap day a year on", () => {
    assert.equal(periodFor("last-3", "2026-05-31").from, "2026-03-01");
    assert.equal(periodFor("last-12", "2024-02-29").from, "2023-03-01");
  });

  /*
   * ENG-2 · On a month's last day the window is whole calendar months. From
   * the day after the 30th, "Last 3 months" on 30 April began on 31 January,
   * so a salary paid on the last day of each month (31 Jan, 28 Feb, 31 Mar,
   * 30 Apr) was counted four times; on 28 February a year after a leap year
   * "Last 12 months" began on 29 February and held thirteen.
   */
  test("on a month's last day, whole months: a month-end salary is in it 3 (or 12) times", () => {
    assert.equal(periodFor("last-3", "2026-04-30").from, "2026-02-01");
    assert.equal(periodFor("last-3", "2026-06-30").from, "2026-04-01");
    assert.equal(periodFor("last-3", "2026-11-30").from, "2026-09-01");
    assert.equal(periodFor("last-3", "2027-02-28").from, "2026-12-01");
    assert.equal(periodFor("last-12", "2025-02-28").from, "2024-03-01");

    const monthEnds = ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"];
    const p = periodFor("last-3", "2026-04-30");
    assert.equal(monthEnds.filter((d) => d >= p.from && d <= p.to).length, 3);
  });

  test("a day that is not the month's last is unchanged", () => {
    assert.equal(periodFor("last-3", "2026-04-29").from, "2026-01-30");
    assert.equal(periodFor("last-12", "2027-02-27").from, "2026-02-28");
  });
});
