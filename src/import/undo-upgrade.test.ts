/**
 * D9b · Undoing a statement's import reverses the alert upgrades it made.
 *
 * A statement row that matches an earlier alert-sourced transaction by bank
 * reference upgrades it in place (D4): marks it cleared and fills its memo and
 * raw fields. That created nothing, so `undoBatch` — which removed what the
 * batch created and reversed what it merged (IMPORTS-6) — did not see it: the
 * undone statement went on vouching for the transaction, cleared, with the
 * statement's reference in its memo.
 *
 * Fictional accounts and references throughout.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import "../domain/transactions.ts";
import { nowIST } from "../core/dates.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { updateTransaction } from "../domain/transactions.ts";
import { parseStatement } from "./csv.ts";
import { ingest, listStaged, approveStaged, undoBatch } from "./pipeline.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

const ALERT = {
  rowNumber: 0, date: "2026-08-03", amount: -45000,
  narration: "UPI txn to ZZ CAFE ref 400111222333", reference: "400111222333",
  raw: { date: "03-08-26", amount: "INR 450.00", narration: "UPI txn to ZZ CAFE ref 400111222333" },
};

const STATEMENT = `Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.
05-08-2026,UPI-ZZ CAFE-400111222333,400111222333,450.00,`;

function setup(): { db: DB; accountId: string; txId: string } {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m-ravi", "ravi@example.com", "Ravi", nowIST());
  const accountId = createAccount(db, actor, {
    name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01",
  }).id;
  const group = createGroup(db, actor, "Flexible");
  const categoryId = createCategory(db, actor, { groupId: group.id, name: "Eating Out" }).id;

  ingest(db, actor, { accountId, source: "email", adapter: "email:zz", records: [ALERT] });
  const [row] = listStaged(db);
  const txId = approveStaged(db, actor, row!.id, { categoryId });
  return { db, accountId, txId };
}

function importStatement(db: DB, accountId: string) {
  const { result } = parseStatement(STATEMENT);
  return ingest(db, actor, {
    accountId, source: "csv", adapter: "csv", fileName: "zz-aug.csv",
    records: result.records, errors: result.errors, rowsRead: result.rowsRead,
  });
}

type Row = { cleared: number; memo: string | null; raw_narration: string | null; deleted_at: string | null };
const row = (db: DB, id: string) =>
  queryOne<Row>(db, `SELECT cleared, memo, raw_narration, deleted_at FROM transactions WHERE id = ?`, id)!;

describe("D9b · batch undo and the statement-after-alert upgrade", () => {
  test("undoing the statement puts the alert's transaction back as the alert left it", () => {
    const { db, accountId, txId } = setup();
    // Not yet on a statement, so the household left it uncleared.
    updateTransaction(db, actor, txId, { cleared: false });
    const before = row(db, txId);
    assert.equal(before.cleared, 0);
    assert.equal(before.memo, null);

    const statement = importStatement(db, accountId);
    assert.equal(statement.staged, 0);
    assert.equal(statement.duplicates, 1);
    const upgraded = row(db, txId);
    assert.equal(upgraded.cleared, 1, "the statement row upgraded it");
    assert.match(upgraded.memo ?? "", /400111222333/);

    const result = undoBatch(db, actor, statement.batch.id);
    assert.deepEqual(result.keptBecauseEdited, []);
    assert.deepEqual(row(db, txId), before, "cleared, memo and raw fields as the alert left them");
    db.close();
  });

  test("a transaction edited since the upgrade is left and listed, as an edited merge is", () => {
    const { db, accountId, txId } = setup();
    const statement = importStatement(db, accountId);
    updateTransaction(db, actor, txId, { memo: "Team lunch" });

    const result = undoBatch(db, actor, statement.batch.id);
    assert.deepEqual(result.keptBecauseEdited, [txId]);
    const now = row(db, txId);
    assert.equal(now.cleared, 1, "left as it is");
    assert.equal(now.memo, "Team lunch");
    db.close();
  });

  test("after the undo, importing the statement again upgrades it again", () => {
    const { db, accountId, txId } = setup();
    const statement = importStatement(db, accountId);
    undoBatch(db, actor, statement.batch.id);
    // The statement can be imported again and upgrades again.
    const again = importStatement(db, accountId);
    assert.equal(again.duplicates, 1);
    assert.equal(row(db, txId).cleared, 1);
    db.close();
  });
});
