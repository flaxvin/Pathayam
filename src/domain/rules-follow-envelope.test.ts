/**
 * A rule follows its envelope (IMPORTS-SCHEDULES-18, MONEY-CORE-26).
 *
 * Merging or remapping an envelope moved its history, schedules and queued rows
 * and left the rules naming the envelope that was gone: hidden from /rules,
 * still filing every import into it, and — through "Apply to existing" —
 * writing the dead id onto transactions, which broke the identity.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, mergeCategories, deleteCategory } from "./budget.ts";
import { createTransaction } from "./transactions.ts";
import { applyRetroactive } from "../import/learning.ts";
import { loadRules, ingest, listStaged } from "../import/pipeline.ts";
import { parseStatement } from "../import/csv.ts";
import { undoEvent } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";
import { execute, newId, queryOne, type DB } from "../db/db.ts";
import { nowIST, type IsoDate } from "../core/dates.ts";
import type { Rule } from "../import/rules.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const bank = createAccount(db, actor, { name: "ZZ Bank", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(10_000) }).id;
  const g = createGroup(db, actor, "Food");
  const eatingOut = createCategory(db, actor, { groupId: g.id, name: "Eating out" }).id;
  const dining = createCategory(db, actor, { groupId: g.id, name: "Dining" }).id;
  const rule = newId();
  execute(db,
    `INSERT INTO rules (id,name,stage,conditions_json,actions_json,enabled,proposed,created_at)
     VALUES (?,?,?,?,?,1,0,?)`,
    rule, "Zzfood to eating out", "default",
    JSON.stringify([{ field: "narration", op: "contains", value: "ZZFOOD" }]),
    JSON.stringify([{ type: "setCategory", categoryId: eatingOut }]), nowIST());
  return { db, bank, eatingOut, dining, rule };
}

const target = (db: DB, rule: string) =>
  (JSON.parse(queryOne<{ actions_json: string }>(db,
    `SELECT actions_json FROM rules WHERE id = ?`, rule)!.actions_json) as { categoryId: string }[])[0]!.categoryId;

function importZzfood(db: DB, bank: string) {
  const { result } = parseStatement(`Date,Narration,Amount\n05-09-2026,UPI/ZZFOOD/ORDER,-450.00`);
  ingest(db, actor, { accountId: bank, source: "csv", adapter: "csv", fileName: "f.csv",
    records: result.records, errors: result.errors, rowsRead: result.rowsRead });
  return listStaged(db)[0]!;
}

describe("a rule follows its envelope", () => {
  test("merging moves the rule to the winner, and imports are filed there", () => {
    const { db, bank, eatingOut, dining, rule } = setup();
    mergeCategories(db, actor, eatingOut, dining);
    assert.equal(target(db, rule), dining);
    assert.equal(importZzfood(db, bank).category_id, dining);
  });

  test("deleting with a remap moves it, and undoing the delete moves it back", () => {
    const { db, eatingOut, dining, rule } = setup();
    deleteCategory(db, actor, eatingOut, { remapTo: dining, currentBalance: 0 as Paise });
    assert.equal(target(db, rule), dining);
    const ev = queryOne<{ id: string }>(db,
      `SELECT id FROM events WHERE entity = 'category' AND action = 'delete'`)!.id;
    assert.equal(undoEvent(db, ev, actor).ok, true);
    assert.equal(target(db, rule), eatingOut);
  });

  test("deleting without a remap is refused, naming the rule", () => {
    const { db, eatingOut, rule } = setup();
    assert.throws(
      () => deleteCategory(db, actor, eatingOut, { currentBalance: 0 as Paise }),
      /"Zzfood to eating out"/,
    );
    assert.equal(target(db, rule), eatingOut);
  });

  test("Apply to existing will not file into a deleted envelope (MONEY-CORE-26)", () => {
    const { db, bank, eatingOut, dining } = setup();
    const tx = createTransaction(db, actor, { accountId: bank, amount: -rupees(450) as Paise,
      date: "2026-09-10" as IsoDate, categoryId: dining, payeeName: "ZZFOOD" }).id;
    execute(db, `UPDATE transactions SET raw_narration = 'UPI/ZZFOOD/ORDER' WHERE id = ?`, tx);
    // A rule loaded before the merge, as a /rules page opened earlier would post it.
    const stale: Rule = loadRules(db)[0]!;
    mergeCategories(db, actor, eatingOut, dining);
    execute(db, `UPDATE transactions SET category_id = ? WHERE id = ?`,
      createCategory(db, actor, { groupId: queryOne<{ group_id: string }>(db,
        `SELECT group_id FROM categories WHERE id = ?`, dining)!.group_id, name: "Other" }).id, tx);
    assert.throws(() => applyRetroactive(db, actor, stale), /has been deleted/);
    assert.notEqual(queryOne<{ category_id: string }>(db,
      `SELECT category_id FROM transactions WHERE id = ?`, tx)!.category_id, eatingOut);
  });
});
