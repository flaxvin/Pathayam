/**
 * ENG-10 · An insurance policy's envelope follows a category merge or delete.
 *
 * insurance_policies.category_id was the one pointer at a category that merge
 * and delete left alone: a policy paid from "Insurance old", merged into
 * "Insurance", kept naming the merged-away envelope, and one whose envelope was
 * deleted named a deleted one. Merge now repoints it to the winner and delete to
 * the remap (or clears it, with no remap); each is recorded, so undo puts the
 * policy back on its own envelope.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { historyFor, undoEvent, type Actor } from "../core/events.ts";
import { createGroup, createCategory, mergeCategories, deleteCategory } from "./budget.ts";
import { createPolicy } from "./insurance.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  const group = createGroup(db, actor, "Bills");
  const old = createCategory(db, actor, { groupId: group.id, name: "Insurance old" }).id;
  const kept = createCategory(db, actor, { groupId: group.id, name: "Insurance" }).id;
  const policy = createPolicy(db, actor, {
    insurer: "Fictional Assurance", kind: "health", premium: rupees(24_000), frequency: "yearly",
    categoryId: old,
  }).id;
  const envelopeOf = () =>
    queryOne<{ c: string | null }>(db, `SELECT category_id AS c FROM insurance_policies WHERE id = ?`, policy)!.c;
  return { db, old, kept, envelopeOf };
}

describe("ENG-10 · insurance follows its envelope", () => {
  test("a merge repoints the policy, and undoing it puts it back", () => {
    const { db, old, kept, envelopeOf } = setup();
    mergeCategories(db, actor, old, kept);
    assert.equal(envelopeOf(), kept);
    const ev = historyFor(db, "category", old).find((e) => e.action === "merge")!;
    assert.equal(undoEvent(db, ev.id, actor).ok, true);
    assert.equal(envelopeOf(), old);
  });

  test("a delete with a remap moves it there, and undo brings it back", () => {
    const { db, old, kept, envelopeOf } = setup();
    deleteCategory(db, actor, old, { remapTo: kept, currentBalance: 0 as never });
    assert.equal(envelopeOf(), kept);
    const ev = historyFor(db, "category", old).find((e) => e.action === "delete")!;
    assert.equal(undoEvent(db, ev.id, actor).ok, true);
    assert.equal(envelopeOf(), old);
  });

  test("a delete with no remap clears it, and undo restores it", () => {
    const { db, old, envelopeOf } = setup();
    deleteCategory(db, actor, old, { currentBalance: 0 as never });
    assert.equal(envelopeOf(), null);
    const ev = historyFor(db, "category", old).find((e) => e.action === "delete")!;
    assert.equal(undoEvent(db, ev.id, actor).ok, true);
    assert.equal(envelopeOf(), old);
  });
});
