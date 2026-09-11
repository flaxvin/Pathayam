/**
 * B65 · Undoing the creation of a transaction.
 *
 * `undoEvent` and a handler per entity have existed since early on, but until
 * the Activity screen there was no route that called either, so this path had
 * never actually run against real data. The first time it did, it hit a foreign
 * key: an imported row that had been approved into the transaction still
 * pointed at it, and five other tables can too.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne, queryAll, type DB } from "../db/db.ts";
import { undoEvent, queryEvents, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createTransaction, UndoRefused } from "./transactions.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  const account = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(100000),
  });
  const group = createGroup(db, actor, "Flexible");
  const category = createCategory(db, actor, { groupId: group.id, name: "Groceries" }).id;
  return { db, account: account.id, category };
}

function spend(db: DB, account: string, category: string) {
  return createTransaction(db, actor, {
    accountId: account, amount: -rupees(2500), date: "2026-09-05",
    categoryId: category, payeeName: "Kirana",
  });
}

function createEventFor(db: DB, id: string): string {
  return queryEvents(db, { entity: "transaction", entityId: id })
    .filter((e) => e.action === "create")[0]!.id;
}

describe("B65 · undoing a created transaction", () => {
  test("removes the transaction, its splits and its tags", () => {
    const { db, account, category } = setup();
    const txn = createTransaction(db, actor, {
      accountId: account, amount: -rupees(2500), date: "2026-09-05",
      categoryId: category, payeeName: "Kirana", tags: ["september"],
    });

    const result = undoEvent(db, createEventFor(db, txn.id), actor);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);

    assert.equal(queryOne(db, `SELECT id FROM transactions WHERE id = ?`, txn.id), null);
    assert.equal(
      queryAll(db, `SELECT 1 FROM transaction_tags WHERE transaction_id = ?`, txn.id).length, 0,
    );
    db.close();
  });

  test("an approved import goes back to waiting, not to pointing at nothing", () => {
    const { db, account, category } = setup();
    const txn = spend(db, account, category);

    // What approving a staged row leaves behind.
    execute(db, `INSERT INTO import_batches (id,account_id,source,adapter,file_name,rows_read,created_at)
                 VALUES ('b1',?,'csv','x','x.csv',1,?)`, account, nowIST());
    execute(
      db,
      `INSERT INTO staged_transactions
         (id,batch_id,account_id,date,amount,raw_narration,status,transaction_id,resolved_at,resolved_by,created_at)
       VALUES ('s1','b1',?,?,?,?,'approved',?,?,?,?)`,
      account, "2026-09-05", -rupees(2500), "UPI-KIRANA", txn.id, nowIST(), "m", nowIST(),
    );

    const result = undoEvent(db, createEventFor(db, txn.id), actor);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);

    const staged = queryOne<{ status: string; transaction_id: string | null }>(
      db, `SELECT status, transaction_id FROM staged_transactions WHERE id = 's1'`,
    )!;
    assert.equal(staged.status, "pending", "the import is unresolved again");
    assert.equal(staged.transaction_id, null);
    db.close();
  });

  test("a later row flagged as a duplicate of it is unflagged", () => {
    const { db, account, category } = setup();
    const txn = spend(db, account, category);
    execute(db, `INSERT INTO import_batches (id,account_id,source,adapter,file_name,rows_read,created_at)
                 VALUES ('b1',?,'csv','x','x.csv',1,?)`, account, nowIST());
    execute(
      db,
      `INSERT INTO staged_transactions
         (id,batch_id,account_id,date,amount,raw_narration,status,duplicate_of_id,duplicate_tier,created_at)
       VALUES ('s2','b1',?,?,?,?,'pending',?, 'strong', ?)`,
      account, "2026-09-05", -rupees(2500), "UPI-KIRANA", txn.id, nowIST(),
    );

    assert.equal(undoEvent(db, createEventFor(db, txn.id), actor).ok, true);
    assert.equal(
      queryOne<{ duplicate_of_id: string | null }>(
        db, `SELECT duplicate_of_id FROM staged_transactions WHERE id = 's2'`,
      )!.duplicate_of_id,
      null,
    );
    db.close();
  });

  test("refuses, with the reason, when the transaction is a loan instalment", () => {
    const { db, account, category } = setup();
    const txn = spend(db, account, category);

    execute(db, `INSERT INTO loans (id,account_id,lender,loan_type,sanctioned,sanction_date,tenure_months,created_at)
                 VALUES ('l1',?,'HDFC','personal',?,'2026-01-01',36,?)`,
      account, rupees(500000), nowIST());
    execute(db, `INSERT INTO loan_payments (id,loan_id,date,amount,principal,interest,transaction_id,created_at)
                 VALUES ('p1','l1','2026-09-05',?,?,?,?,?)`,
      rupees(2500), rupees(2000), rupees(500), txn.id, nowIST());

    const eventId = createEventFor(db, txn.id);
    assert.throws(() => undoEvent(db, eventId, actor), UndoRefused);

    // The refusal rolled back cleanly — the transaction is still there.
    assert.ok(queryOne(db, `SELECT id FROM transactions WHERE id = ?`, txn.id));
    db.close();
  });
});
