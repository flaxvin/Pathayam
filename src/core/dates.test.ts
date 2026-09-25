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
  statementPeriodOf,
  formatDate,
  formatMonth,
  parseDate,
  calendarDate,
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

  test("and February knows which years are long", () => {
    assert.equal(resolveDayOfMonth("2024-02", 31, "last-day"), "2024-02-29");
    assert.equal(resolveDayOfMonth("2026-02", 30, "last-day"), "2026-02-28");
    assert.equal(resolveDayOfMonth("2026-04", 31, "last-day"), "2026-04-30");
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

  test("reads the shapes bank exports use, as the PDF and alert readers do", () => {
    assert.equal(parseDate("15-Jan-2026"), "2026-01-15");
    assert.equal(parseDate("15 Jan 2026"), "2026-01-15");
    assert.equal(parseDate("15 January 26"), "2026-01-15");
    assert.equal(parseDate("15-Sept-2026"), "2026-09-15");
    assert.equal(parseDate("2026/01/15"), "2026-01-15");
    assert.equal(parseDate("15-01-2026 10:32"), "2026-01-15");
    assert.equal(parseDate("28-08-26, 00:01:28 IST"), "2026-08-28");
    assert.equal(parseDate("2026-01-15T10:32:00"), "2026-01-15");
    assert.equal(parseDate("31-Feb-2026"), null);
    assert.equal(parseDate("15-Jnu-2026"), null);
    assert.equal(parseDate("15-01-2026 99"), null);
  });

  test("an implausible year is refused, not stored 2,000 years early", () => {
    // "01-02-0026" is a typo for 2026. parseDate returned "0026-02-01"; an
    // imported row carrying it sorted before every other transaction, into a
    // month no report shows and no dedupe tier compares against.
    assert.equal(parseDate("01-02-0026"), null);
    assert.equal(parseDate("0026-02-01"), null);
    assert.equal(parseDate("01-02-1899"), null);
    assert.equal(parseDate("01-02-2200"), null);
    assert.equal(parseDate("01-02-202"), null);
    assert.equal(parseDate("01-02-1900"), "1900-02-01");
    assert.equal(parseDate("01-02-69"), "2069-02-01");
    assert.equal(parseDate("01-02-70"), "1970-02-01");
  });

  test("the calendar check is the one every reader shares", () => {
    assert.equal(calendarDate(2026, 2, 31), null);
    assert.equal(calendarDate(2028, 2, 29), "2028-02-29");
    assert.equal(calendarDate(2026, 13, 1), null);
    assert.equal(calendarDate(2026, 1, 0), null);
    assert.equal(calendarDate(26, 1, 15), null);
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

describe("statementPeriodOf — which cycle a card charge belongs to", () => {
  /**
   * A statement dated the 18th covers everything after the previous 18th up to
   * and including this one. A charge on the 19th is next month's problem, and
   * being a day out here is the difference between a cycle that reconciles
   * against the paper statement and one that does not.
   */
  test("on the statement date itself, the cycle ends that day", () => {
    const period = statementPeriodOf("2026-09-18", 18);
    assert.equal(period.end, "2026-09-18");
    assert.equal(period.start, "2026-08-19");
  });

  test("the day after starts the next cycle", () => {
    const period = statementPeriodOf("2026-09-19", 18);
    assert.equal(period.start, "2026-09-19");
    assert.equal(period.end, "2026-10-18");
  });

  test("a charge mid-cycle lands in the cycle containing it", () => {
    assert.deepEqual(
      { ...statementPeriodOf("2026-10-02", 18) },
      { start: "2026-09-19", end: "2026-10-18", label: "19 Sep – 18 Oct" },
    );
  });

  test("a statement day of 31 clamps in every short month", () => {
    // February's statement is dated the 28th, so its cycle runs 1–28 Feb.
    const feb = statementPeriodOf("2026-02-10", 31);
    assert.equal(feb.end, "2026-02-28");
    assert.equal(feb.start, "2026-02-01");

    // And the one after it starts on 1 March.
    const mar = statementPeriodOf("2026-03-01", 31);
    assert.equal(mar.start, "2026-03-01");
    assert.equal(mar.end, "2026-03-31");

    // A leap February gets the 29th.
    assert.equal(statementPeriodOf("2024-02-10", 31).end, "2024-02-29");
  });

  test("every day of a year lands in exactly one cycle, with no gaps", () => {
    // The property that matters: cycles tile the calendar. A gap or an overlap
    // would put a charge on no statement or on two.
    for (const day of [18, 1, 28, 31]) {
      let cursor = "2026-01-01" as never;
      let period = statementPeriodOf(cursor, day);
      let guard = 0;
      while (cursor < "2026-12-31" && guard++ < 400) {
        assert.ok(cursor >= period.start && cursor <= period.end,
          `${cursor} outside ${period.start}..${period.end} for day ${day}`);
        cursor = addDays(cursor, 1);
        const next = statementPeriodOf(cursor, day);
        if (next.end !== period.end) {
          assert.equal(next.start, addDays(period.end, 1), `gap after ${period.end} for day ${day}`);
          period = next;
        }
      }
    }
  });
});
