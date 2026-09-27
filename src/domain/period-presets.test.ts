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
