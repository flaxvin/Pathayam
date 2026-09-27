/**
 * F4.8 · Deleted transactions are hard-deleted after 30 days.
 *
 * The purge was one DELETE over every expired row, and an imported line that
 * had been approved and then deleted is still named by its staged row. That
 * failed the whole statement on a foreign key, every six hours, for ever: no
 * deleted transaction was ever purged again, and the housekeeping steps after
 * it (pruning request failures) never ran.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createTransaction, deleteTransaction, purgeDeleted } from "./transactions.ts";
import { parseStatement } from "../import/csv.ts";
import { ingest, listStaged, approveStaged } from "../import/pipeline.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  const account = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
  }).id;
  const category = createCategory(db, actor, { groupId: createGroup(db, actor, "G").id, name: "Groceries" }).id;
  const importRow = (csv: string) => {
    const { result } = parseStatement(csv);
    ingest(db, actor, {
      accountId: account, source: "csv", adapter: "csv",
      records: result.records, errors: result.errors, rowsRead: result.rowsRead,
    });
  };
  return { db, account, category, importRow };
}

describe("F4.8 · purging deleted transactions", () => {
  test("an approved-then-deleted import is purged, and the staged row keeps its decision", () => {
    const { db, account, category, importRow } = setup();
    importRow("Date,Narration,Amount\n05-02-2026,UPI/SHOP A,-120.00");
    const stagedId = listStaged(db)[0]!.id;
    const imported = approveStaged(db, actor, stagedId, { categoryId: category });
    const typed = createTransaction(db, actor, {
      accountId: account, amount: -rupees(50), date: "2026-02-06", categoryId: category,
    });
    deleteTransaction(db, actor, imported);
    deleteTransaction(db, actor, typed.id);

    assert.equal(purgeDeleted(db, 30, "2099-01-01"), 2);
    assert.equal(queryOne(db, `SELECT 1 FROM transactions WHERE id IN (?, ?)`, imported, typed.id), null);
    const staged = queryOne<{ status: string; transaction_id: string | null }>(
      db, `SELECT status, transaction_id FROM staged_transactions WHERE id = ?`, stagedId,
    )!;
    // Not back in Review: it was approved, and then the result was deleted.
    assert.deepEqual({ ...staged }, { status: "approved", transaction_id: null });
  });

  test("a row an import flagged as its duplicate is purged too", () => {
    const { db, account, category, importRow } = setup();
    const typed = createTransaction(db, actor, {
      accountId: account, amount: -rupees(120), date: "2026-02-05", categoryId: category,
    });
    importRow("Date,Narration,Amount\n05-02-2026,UPI/SHOP A,-120.00");
    assert.equal(listStaged(db)[0]!.duplicate_of_id, typed.id);
    deleteTransaction(db, actor, typed.id);

    assert.equal(purgeDeleted(db, 30, "2099-01-01"), 1);
    assert.equal(listStaged(db)[0]!.duplicate_of_id, null);
  });

  test("nothing is purged inside the 30 days", () => {
    const { db, account, category } = setup();
    const typed = createTransaction(db, actor, {
      accountId: account, amount: -rupees(50), date: "2026-02-06", categoryId: category,
    });
    deleteTransaction(db, actor, typed.id);
    assert.equal(purgeDeleted(db), 0);
  });
});
