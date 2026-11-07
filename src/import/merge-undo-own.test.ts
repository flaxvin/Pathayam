/**
 * IMP-12 · Undoing an import reverses its own merge, not a later one.
 *
 * `undoBatch` reversed a merged row by the transaction's last event when that
 * was any merge. Two imports' rows merged into one transaction, then the
 * first undone: the *second* import's merge was reversed (from its before,
 * which already carried the first's), and the first's row marked rejected.
 * The merge event now names its staged row, and only that row's merge is
 * reversed; a transaction merged into again since is left and listed, as an
 * edited one is.
 *
 * Fictional rows throughout.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne, queryAll, type DB } from "../db/db.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import "../domain/transactions.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { parseStatement } from "./csv.ts";
import { ingest, listStaged, mergeStaged, undoBatch } from "./pipeline.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

function importCsv(db: DB, accountId: string, text: string, fileName: string) {
  const { result } = parseStatement(text);
  return ingest(db, actor, {
    accountId, source: "csv", adapter: "csv", fileName,
    records: result.records, errors: result.errors, rowsRead: result.rowsRead,
  });
}

test("undoing the first of two merged imports leaves the second's merge standing", () => {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m-ravi", "ravi@example.com", "Ravi", nowIST());
  const account = createAccount(db, actor, {
    name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01",
  }).id;
  const cat = createCategory(db, actor, { groupId: createGroup(db, actor, "ZZ").id, name: "ZZ Food" }).id;
  const manual = createTransaction(db, actor, {
    accountId: account, amount: rupees(-450), date: "2026-08-03", categoryId: cat,
  });

  const first = importCsv(db, account,
    "Date,Narration,Amount\n03-08-2026,ZZ CAFE FIRST,-450.00", "first.csv");
  const firstRow = listStaged(db).find((r) => r.duplicate_of_id === manual.id)!;
  assert.ok(firstRow, "the first import's row is offered as the same transaction");
  mergeStaged(db, actor, firstRow.id);

  importCsv(db, account, "Date,Narration,Amount\n03-08-2026,ZZ CAFE SECOND,-450.00", "second.csv");
  const secondRow = listStaged(db).find((r) => r.duplicate_of_id === manual.id)!;
  assert.ok(secondRow, "the second import's row is offered too");
  // Make the second merge's change visible: the first filled the narration
  // already, so put it back to nothing before the second merges.
  execute(db, `UPDATE transactions SET raw_narration = NULL WHERE id = ?`, manual.id);
  mergeStaged(db, actor, secondRow.id);
  assert.equal(queryOne<{ raw_narration: string }>(db,
    `SELECT raw_narration FROM transactions WHERE id = ?`, manual.id)!.raw_narration, "ZZ CAFE SECOND");

  const result = undoBatch(db, actor, first.batch.id);
  assert.deepEqual(result.keptBecauseEdited, [manual.id]);
  const tx = queryOne<{ cleared: number; raw_narration: string | null }>(db,
    `SELECT cleared, raw_narration FROM transactions WHERE id = ?`, manual.id)!;
  assert.equal(tx.cleared, 1, "the second import still vouches for it");
  assert.equal(tx.raw_narration, "ZZ CAFE SECOND");
  assert.equal(queryOne<{ status: string }>(db,
    `SELECT status FROM staged_transactions WHERE id = ?`, secondRow.id)!.status, "merged");
  db.close();
});

test("REV-4 · undoing a merge from Activity sends back the row that merge named", () => {
  /*
   * The undo reopened whichever row merged into the transaction most
   * recently, not the one its event names (IMP-12): two rows merged into one
   * transaction, and undoing the first merge put the second row back in
   * Review while the first stayed merged.
   */
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m-ravi", "ravi@example.com", "Ravi", nowIST());
  const account = createAccount(db, actor, {
    name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01",
  }).id;
  const cat = createCategory(db, actor, { groupId: createGroup(db, actor, "ZZ").id, name: "ZZ Food" }).id;
  const manual = createTransaction(db, actor, {
    accountId: account, amount: rupees(-450), date: "2026-08-03", categoryId: cat,
  });

  importCsv(db, account, "Date,Narration,Amount\n03-08-2026,ZZ CAFE FIRST,-450.00", "first.csv");
  const firstRow = listStaged(db).find((r) => r.duplicate_of_id === manual.id)!;
  mergeStaged(db, actor, firstRow.id);
  importCsv(db, account, "Date,Narration,Amount\n03-08-2026,ZZ CAFE SECOND,-450.00", "second.csv");
  const secondRow = listStaged(db).find((r) => r.duplicate_of_id === manual.id)!;
  mergeStaged(db, actor, secondRow.id);

  const merges = queryAll<{ id: string }>(db,
    `SELECT id FROM events WHERE entity = 'transaction' AND entity_id = ? AND action = 'merge' ORDER BY seq`, manual.id);
  assert.equal(merges.length, 2);
  undoEvent(db, merges[0]!.id, actor, { force: true });

  const status = (id: string) =>
    queryOne<{ status: string }>(db, `SELECT status FROM staged_transactions WHERE id = ?`, id)!.status;
  assert.equal(status(firstRow.id), "pending", "the first merge's row is back in Review");
  assert.equal(status(secondRow.id), "merged", "the second merge stands");
  db.close();
});
