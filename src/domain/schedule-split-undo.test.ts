/**
 * Undoing a change to a schedule's split puts the split back — it does not
 * delete the schedule.
 *
 * setScheduleSplits recorded its events with no before-state, and the schedule
 * undo handler read a missing before-state as "this was a creation". So undoing
 * "Set Rent to split across 2 envelopes", or "Rent is one envelope again",
 * removed the rent schedule entirely and reported success. Found by the
 * schedules fixer while working on something else.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createSchedule, setScheduleSplits, getSchedule, getScheduleSplits } from "./schedules.ts";
import { undoEvent } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";
import { queryOne, type DB } from "../db/db.ts";
import type { IsoDate } from "../core/dates.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

function lastSplitEvent(db: DB): string {
  return queryOne<{ id: string }>(db,
    `SELECT id FROM events WHERE entity = 'schedule' AND action = 'split' ORDER BY seq DESC LIMIT 1`)!.id;
}

function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const bank = createAccount(db, actor, { name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(100_000) }).id;
  const g = createGroup(db, actor, "Home");
  const rent = createCategory(db, actor, { groupId: g.id, name: "Rent" }).id;
  const upkeep = createCategory(db, actor, { groupId: g.id, name: "Upkeep" }).id;
  const s = createSchedule(db, actor, { name: "Flat", accountId: bank, categoryId: rent,
    amount: -rupees(32_000) as Paise, recurrence: "monthly", nextDue: "2026-10-05" as IsoDate });
  return { db, rent, upkeep, id: s.id };
}

describe("undoing a split change", () => {
  test("undoing a split puts the single envelope back and keeps the schedule", () => {
    const { db, rent, upkeep, id } = setup();
    setScheduleSplits(db, actor, id, [
      { categoryId: rent, amount: -rupees(30_000) as Paise },
      { categoryId: upkeep, amount: -rupees(2_000) as Paise },
    ]);
    const r = undoEvent(db, lastSplitEvent(db), actor);
    assert.equal(r.ok, true);
    assert.ok(getSchedule(db, id), "undoing the split deleted the whole schedule");
    assert.equal(getScheduleSplits(db, id).length, 0);
    assert.equal(getSchedule(db, id)!.category_id, rent);
  });

  test("undoing 'one envelope again' puts the split back", () => {
    const { db, rent, upkeep, id } = setup();
    setScheduleSplits(db, actor, id, [
      { categoryId: rent, amount: -rupees(30_000) as Paise },
      { categoryId: upkeep, amount: -rupees(2_000) as Paise },
    ]);
    setScheduleSplits(db, actor, id, [{ categoryId: upkeep, amount: -rupees(32_000) as Paise }]);
    undoEvent(db, lastSplitEvent(db), actor);
    assert.ok(getSchedule(db, id), "the schedule was deleted");
    const lines = getScheduleSplits(db, id).map((l) => [l.category_id, l.amount]);
    assert.deepEqual(lines, [[rent, -rupees(30_000)], [upkeep, -rupees(2_000)]]);
  });
});
