/**
 * 0056 · rules left naming an envelope that was merged away follow the merge
 *        to the envelope still there; one naming a deleted envelope with no
 *        merge behind it is switched off.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, queryOne, migrate, newId, type DB } from "./db.ts";
import { MIGRATIONS } from "./schema.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { createGroup, createCategory, mergeCategories } from "../domain/budget.ts";
import { nowIST } from "../core/dates.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

function rule(db: DB, categoryId: string): string {
  const id = newId();
  execute(db,
    `INSERT INTO rules (id,name,stage,conditions_json,actions_json,enabled,proposed,created_at)
     VALUES (?,?,?,?,?,1,0,?)`,
    id, "ZZ rule", "default", JSON.stringify([{ field: "narration", op: "contains", value: "ZZ" }]),
    JSON.stringify([{ type: "setCategory", categoryId }]), nowIST());
  return id;
}

const row = (db: DB, id: string) =>
  queryOne<{ actions_json: string; enabled: number }>(db, `SELECT actions_json, enabled FROM rules WHERE id = ?`, id)!;

describe("0056 · rules follow a merged envelope", () => {
  test("through two merges to the envelope still there; a plain deleted one is switched off", () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const g = createGroup(db, actor, "Food");
    const a = createCategory(db, actor, { groupId: g.id, name: "A" }).id;
    const b = createCategory(db, actor, { groupId: g.id, name: "B" }).id;
    const c = createCategory(db, actor, { groupId: g.id, name: "C" }).id;
    const gone = createCategory(db, actor, { groupId: g.id, name: "Gone" }).id;
    const kept = createCategory(db, actor, { groupId: g.id, name: "Kept" }).id;
    const onA = rule(db, a);
    const onGone = rule(db, gone);
    const onKept = rule(db, kept);
    mergeCategories(db, actor, a, b);
    mergeCategories(db, actor, b, c);
    // What the old merge left behind: the rule still naming A.
    execute(db, `UPDATE rules SET actions_json = ? WHERE id = ?`,
      JSON.stringify([{ type: "setCategory", categoryId: a }]), onA);
    execute(db, `UPDATE categories SET deleted_at = ? WHERE id = ?`, nowIST(), gone);

    db.exec("PRAGMA user_version = 55");
    migrate(db, false, 56);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);

    assert.ok(row(db, onA).actions_json.includes(c), "the rule did not reach C");
    assert.equal(row(db, onA).enabled, 1);
    assert.equal(row(db, onGone).enabled, 0, "a rule into a deleted envelope still fires");
    assert.equal(row(db, onKept).enabled, 1);
    assert.ok(row(db, onKept).actions_json.includes(kept));
  });
});
