/**
 * IMPORTS-SCHEDULES-31 · Deleting an envelope takes its schedules along.
 *
 * deleteCategory moved transactions and split lines to the "move history to"
 * envelope and left schedules, schedule lines and waiting imported rows filed
 * to the deleted one. "ZZflix" −₹649 on "Streaming old", deleted into
 * "Subscriptions", then answered every Mark paid with '"Streaming old" has
 * been deleted.' A merge moved a schedule but not a split schedule's lines.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne, type DB } from "../db/db.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import type { IsoDate } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, deleteCategory, mergeCategories } from "./budget.ts";
import { createSchedule, setScheduleSplits, getScheduleSplits, getSchedule, markPaid } from "./schedules.ts";
import { freshHousehold, RAVI } from "../engine/identity.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

function setup() {
  const db = freshHousehold();
  const group = createGroup(db, actor, "ZZ Everyday").id;
  const old = createCategory(db, actor, { groupId: group, name: "ZZ Streaming old" }).id;
  const subs = createCategory(db, actor, { groupId: group, name: "ZZ Subscriptions" }).id;
  const other = createCategory(db, actor, { groupId: group, name: "ZZ Other" }).id;
  const bank = createAccount(db, actor, {
    name: "ZZ Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: 1_000_000,
  }).id;
  const plain = createSchedule(db, actor, {
    name: "ZZflix", accountId: bank, categoryId: old, amount: -64_900 as Paise,
    recurrence: "monthly", nextDue: "2026-10-05" as IsoDate,
  }).id;
  const split = createSchedule(db, actor, {
    name: "ZZ Bundle", accountId: bank, categoryId: other, amount: -100_000 as Paise,
    recurrence: "monthly", nextDue: "2026-10-07" as IsoDate,
  }).id;
  setScheduleSplits(db, actor, split, [
    { categoryId: other, amount: -60_000 as Paise }, { categoryId: old, amount: -40_000 as Paise },
  ]);
  return { db, old, subs, other, plain, split };
}

const lineCategories = (db: DB, id: string) => getScheduleSplits(db, id).map((l) => l.category_id);

describe("IMPORTS-SCHEDULES-31 · schedules on a deleted envelope", () => {
  test("a remap moves the schedule and its lines; Mark paid works; undo puts them back", () => {
    const { db, old, subs, other, plain, split } = setup();
    deleteCategory(db, actor, old, { currentBalance: 0, remapTo: subs });
    assert.equal(getSchedule(db, plain)!.category_id, subs);
    assert.deepEqual(lineCategories(db, split), [other, subs]);
    markPaid(db, actor, plain);
    markPaid(db, actor, split);

    const event = queryOne<{ id: string }>(db,
      `SELECT id FROM events WHERE entity = 'category' AND entity_id = ? AND action = 'delete'`, old)!.id;
    assert.equal(undoEvent(db, event, actor, { force: true }).ok, true);
    assert.equal(getSchedule(db, plain)!.category_id, old);
    assert.deepEqual(lineCategories(db, split), [other, old]);
  });

  test("without a remap the delete is refused, naming the schedules", () => {
    const { db, old } = setup();
    assert.throws(
      () => deleteCategory(db, actor, old, { currentBalance: 0 }),
      (e: unknown) => e instanceof Refusal && /"ZZ Bundle", "ZZflix"/.test(e.message),
    );
  });

  test("a merge moves a split schedule's lines too", () => {
    const { db, old, subs, other, split } = setup();
    mergeCategories(db, actor, old, subs);
    assert.deepEqual(lineCategories(db, split), [other, subs]);
    markPaid(db, actor, split);
  });
});
