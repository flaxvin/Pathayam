/**
 * WEBUX-4 · The demo has nothing in it dated after the day it was made.
 *
 * The public demo is re-seeded every Wednesday at 04:00 IST. The quarterly bank
 * statement was the one block of the scenario without the "has this day
 * happened yet" guard, and the current month is always a statement month — so
 * seeded on 07-10-2026 the HDFC register carried cleared rows on 12-10, 17-10
 * and 21-10, and this month's Activity counted spending still to come.
 *
 * The clock is frozen at a morning early in a statement month, the case that
 * failed.
 */

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, queryAll } from "../db/db.ts";
import { todayIST } from "../core/dates.ts";
import { simulateHousehold } from "./scenario.ts";

describe("WEBUX-4 · a demo seeded early in the month", () => {
  test("files nothing on a day that has not happened yet", () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-07T04:00:00+05:30") });
    try {
      const db = openDatabase({ path: ":memory:", verbose: false });
      ensureHousehold(db);
      // The full run: its last month, index 35, is a statement month.
      simulateHousehold(db);
      const today = todayIST();
      assert.equal(today, "2026-10-07");
      const ahead = queryAll<{ date: string; amount: number }>(
        db,
        `SELECT date, amount FROM transactions WHERE deleted_at IS NULL AND date > ? ORDER BY date`,
        today,
      );
      assert.deepEqual(ahead, [], "the demo has transactions dated after the day it was seeded");
      db.close();
    } finally {
      mock.timers.reset();
    }
  });
});
