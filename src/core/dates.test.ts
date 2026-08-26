import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  todayIST,
  isIsoDate,
  isMonthKey,
  monthOf,
  firstDayOfMonth,
  lastDayOfMonth,
  addMonths,
  monthsBetween,
  addDays,
  daysBetween,
  resolveDayOfMonth,
  formatDate,
  formatMonth,
  parseDate,
  fiscalYearOf,
  fiscalYearRange,
  formatFiscalYear,
} from "./dates.ts";

describe("todayIST — L12", () => {
  test("uses IST regardless of the device zone", () => {
    // 20:00 UTC on 25-08 is 01:30 IST on 26-08 — the household's tomorrow.
    assert.equal(todayIST(new Date("2026-08-25T20:00:00Z")), "2026-08-26");
    // 18:00 UTC on 25-08 is 23:30 IST on 25-08 — still today.
    assert.equal(todayIST(new Date("2026-08-25T18:00:00Z")), "2026-08-25");
  });
});

describe("validation", () => {
  test("accepts real dates and rejects impossible ones", () => {
    assert.ok(isIsoDate("2026-08-26"));
    assert.ok(isIsoDate("2024-02-29"));
    assert.equal(isIsoDate("2026-02-30"), false);
    assert.equal(isIsoDate("2026-13-01"), false);
    assert.equal(isIsoDate("26-08-2026"), false);
    assert.equal(isIsoDate(""), false);
  });

  test("validates month keys", () => {
    assert.ok(isMonthKey("2026-08"));
    assert.equal(isMonthKey("2026-13"), false);
    assert.equal(isMonthKey("2026-08-01"), false);
  });
});

describe("month arithmetic", () => {
  test("derives the month of a date", () => {
    assert.equal(monthOf("2026-08-26"), "2026-08");
  });

  test("finds month boundaries including leap February", () => {
    assert.equal(firstDayOfMonth("2026-08"), "2026-08-01");
    assert.equal(lastDayOfMonth("2026-08"), "2026-08-31");
    assert.equal(lastDayOfMonth("2026-02"), "2026-02-28");
    assert.equal(lastDayOfMonth("2024-02"), "2024-02-29");
  });

  test("crosses the year boundary in both directions", () => {
    assert.equal(addMonths("2026-12", 1), "2027-01");
    assert.equal(addMonths("2026-01", -1), "2025-12");
    assert.equal(addMonths("2026-08", 24), "2028-08");
    assert.equal(addMonths("2026-08", 0), "2026-08");
  });

  test("counts months between", () => {
    assert.equal(monthsBetween("2026-08", "2026-11"), 3);
    assert.equal(monthsBetween("2026-08", "2026-08"), 0);
    assert.equal(monthsBetween("2026-11", "2026-08"), -3);
  });
});

describe("day arithmetic", () => {
  test("adds days across a month boundary", () => {
    assert.equal(addDays("2026-08-31", 1), "2026-09-01");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  });

  test("counts days between, which the Buffer metric depends on", () => {
    assert.equal(daysBetween("2026-08-01", "2026-08-31"), 30);
    assert.equal(daysBetween("2026-08-26", "2026-08-26"), 0);
  });
});

describe("resolveDayOfMonth — F7.3", () => {
  test("returns the day when the month has it", () => {
    assert.equal(resolveDayOfMonth("2026-08", 31), "2026-08-31");
  });

  test("applies the configured policy on a short month", () => {
    assert.equal(resolveDayOfMonth("2026-02", 31, "last-day"), "2026-02-28");
    assert.equal(resolveDayOfMonth("2026-02", 31, "skip"), null);
    assert.equal(resolveDayOfMonth("2026-02", 31, "next-day"), "2026-03-01");
  });
});

describe("formatting — L3", () => {
  test("displays DD-MM-YYYY", () => {
    assert.equal(formatDate("2026-08-26"), "26-08-2026");
  });

  test("names the month", () => {
    assert.equal(formatMonth("2026-08"), "August 2026");
  });
});

describe("parseDate — L3 entry shorthand", () => {
  test("accepts DD-MM-YYYY and DD/MM/YYYY", () => {
    assert.equal(parseDate("26-08-2026"), "2026-08-26");
    assert.equal(parseDate("26/08/2026"), "2026-08-26");
    assert.equal(parseDate("5/8/2026"), "2026-08-05");
  });

  test("accepts a two-digit year", () => {
    assert.equal(parseDate("26-08-26"), "2026-08-26");
  });

  test("accepts DD-MM shorthand against the reference year", () => {
    assert.equal(parseDate("26-08", "2026-08-26"), "2026-08-26");
    assert.equal(parseDate("01/09", "2026-08-26"), "2026-09-01");
  });

  test("resolves shorthand to the nearest year, not blindly the current one", () => {
    // Typing 31-12 on 02-01-2027 means the December just gone.
    assert.equal(parseDate("31-12", "2027-01-02"), "2026-12-31");
    // Typing 01-01 on 30-12-2026 means the January coming.
    assert.equal(parseDate("01-01", "2026-12-30"), "2027-01-01");
  });

  test("passes ISO through", () => {
    assert.equal(parseDate("2026-08-26"), "2026-08-26");
  });

  test("returns null rather than guessing", () => {
    assert.equal(parseDate(""), null);
    assert.equal(parseDate("yesterday"), null);
    assert.equal(parseDate("32-01-2026"), null);
    assert.equal(parseDate("2026-02-30"), null);
  });
});

describe("fiscal year — L4", () => {
  test("runs April to March", () => {
    assert.equal(fiscalYearOf("2026-08-26"), 2026);
    assert.equal(fiscalYearOf("2026-04-01"), 2026);
    assert.equal(fiscalYearOf("2026-03-31"), 2025);
    assert.equal(fiscalYearOf("2026-01-15"), 2025);
  });

  test("gives the range and the label", () => {
    assert.deepEqual(fiscalYearRange(2026), { from: "2026-04-01", to: "2027-03-31" });
    assert.equal(formatFiscalYear(2026), "FY 2026-27");
  });
});
