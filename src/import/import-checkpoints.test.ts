/**
 * IMPORTS-SCHEDULES-8 · An import that changes reconciled history says so.
 *
 * Undoing an import deleted its transactions with a raw UPDATE, and approving
 * an imported row posted straight into the ledger. Behind a checkpoint, the
 * cleared balance at 31 Aug went from ₹8,800 to ₹10,000 while the checkpoint
 * still asserted ₹8,800, unbroken — so Review never flagged it. Deleting one
 * transaction has always asked first and broken the checkpoint (R7.b, R7.c).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { reconcile } from "../domain/reconciliation.ts";
import { parseStatement } from "./csv.ts";
import { ingest, listStaged, approveStaged, undoBatch } from "./pipeline.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const account = createAccount(db, actor, {
    name: "ZZ Savings", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(10_000),
  }).id;
  const g = createGroup(db, actor, "G");
  const cat = createCategory(db, actor, { groupId: g.id, name: "E" }).id;
  return { db, account, cat };
}

function importRow(db: DB, account: string, line: string) {
  const { result } = parseStatement(`Date,Narration,Amount\n${line}`);
  return ingest(db, actor, {
    accountId: account, source: "csv", adapter: "csv", fileName: "f.csv",
    records: result.records, errors: result.errors, rowsRead: result.rowsRead,
  });
}

const broken = (db: DB) =>
  queryOne<{ broken_at: string | null }>(db, `SELECT broken_at FROM reconciliations`)!.broken_at;

describe("an import that changes reconciled history breaks the checkpoint", () => {
  test("undoing the import", () => {
    const { db, account, cat } = setup();
    const b = importRow(db, account, "05-08-2026,UPI/ZZ SHOP A,-1200.00");
    for (const r of listStaged(db)) approveStaged(db, actor, r.id, { categoryId: cat });
    reconcile(db, actor, { accountId: account, bankBalance: rupees(8_800), asOf: "2026-08-31" });
    assert.equal(broken(db), null);

    undoBatch(db, actor, b.batch.id);
    assert.notEqual(broken(db), null);
  });

  test("approving a row dated before it", () => {
    const { db, account, cat } = setup();
    reconcile(db, actor, { accountId: account, bankBalance: rupees(10_000), asOf: "2026-08-31" });
    importRow(db, account, "10-08-2026,UPI/ZZ SHOP C,-500.00");
    approveStaged(db, actor, listStaged(db)[0]!.id, { categoryId: cat });
    assert.notEqual(broken(db), null);
  });

  test("but not a row dated after it", () => {
    const { db, account, cat } = setup();
    reconcile(db, actor, { accountId: account, bankBalance: rupees(10_000), asOf: "2026-08-31" });
    importRow(db, account, "10-09-2026,UPI/ZZ SHOP C,-500.00");
    approveStaged(db, actor, listStaged(db)[0]!.id, { categoryId: cat });
    assert.equal(broken(db), null);
  });

  test("the routes ask first, naming the checkpoint", async () => {
    const { db, account, cat } = setup();
    const b = importRow(db, account, "05-08-2026,UPI/ZZ SHOP A,-1200.00");
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const staged = listStaged(db)[0]!.id;
      reconcile(db, actor, { accountId: account, bankBalance: rupees(10_000), asOf: "2026-08-31" });

      const ask = await app.post("/review/approve", { staged_id: staged, category_id: cat });
      assert.equal(ask.status, 200);
      assert.match(await ask.text(), /Already reconciled|reconciled on/);
      assert.equal(listStaged(db).length, 1, "nothing was approved before the yes");
      assert.equal(broken(db), null);

      const yes = await app.post("/review/approve", { staged_id: staged, category_id: cat, confirm_checkpoint: "1" });
      assert.equal(yes.status, 303);
      assert.notEqual(broken(db), null);

      reconcile(db, actor, { accountId: account, bankBalance: rupees(8_800), asOf: "2026-08-31" });
      const askUndo = await app.post("/import/undo", { batch_id: b.batch.id });
      assert.equal(askUndo.status, 200);
      assert.equal(queryOne(db, `SELECT undone_at FROM import_batches WHERE id = ?`, b.batch.id)!.undone_at, null);
      const undo = await app.post("/import/undo", { batch_id: b.batch.id, confirm_checkpoint: "1" });
      assert.equal(undo.status, 303);
      assert.equal(app.failures.length, 0);
    } finally {
      await app.close();
    }
  });
});
