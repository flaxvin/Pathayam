/**
 * 0057 · a rule on an amount saved from the /rules form held the rupees as
 *        typed text; it now holds paise, as a number.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, queryOne, migrate, newId, type DB } from "./db.ts";
import { MIGRATIONS } from "./schema.ts";
import { freshDb } from "../web/harness.test-data.ts";
import { nowIST } from "../core/dates.ts";

function rule(db: DB, conditions: unknown[]): string {
  const id = newId();
  execute(db,
    `INSERT INTO rules (id,name,stage,conditions_json,actions_json,enabled,proposed,created_at)
     VALUES (?,?,?,?,?,1,0,?)`,
    id, "ZZ rule", "default", JSON.stringify(conditions),
    JSON.stringify([{ type: "setCategory", categoryId: "x" }]), nowIST());
  return id;
}

const conditions = (db: DB, id: string) =>
  JSON.parse(queryOne<{ conditions_json: string }>(db,
    `SELECT conditions_json FROM rules WHERE id = ?`, id)!.conditions_json) as { field: string; value: unknown }[];

describe("0057 · rule amounts in paise", () => {
  test("typed rupees become paise; words, numbers and other fields are left", () => {
    const db = freshDb();
    const typed = rule(db, [
      { field: "absoluteAmount", op: "greaterThan", value: "5,000" },
      { field: "narration", op: "contains", value: "5000" },
    ]);
    const exact = rule(db, [{ field: "amount", op: "is", value: "649.50" }]);
    const word = rule(db, [{ field: "absoluteAmount", op: "is", value: "lots" }]);
    const already = rule(db, [{ field: "absoluteAmount", op: "greaterThan", value: 500000 }]);

    db.exec("PRAGMA user_version = 56");
    migrate(db, false, 57);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);

    assert.deepEqual(conditions(db, typed).map((c) => c.value), [500000, "5000"]);
    assert.equal(conditions(db, exact)[0]!.value, 64950);
    assert.equal(conditions(db, word)[0]!.value, "lots");
    assert.equal(conditions(db, already)[0]!.value, 500000);
  });
});
