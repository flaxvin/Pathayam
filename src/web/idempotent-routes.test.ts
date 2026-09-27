/**
 * MONEY-CORE-14 · A retry with the same Idempotency-Key replays; it does not
 * do the work twice (R36).
 *
 * client.ts re-sends every POST with the same key after a timeout or a 5xx.
 * /add, /transfer and undo went through `mutate` and replayed; the routes that
 * ask a question first or render a page did not. Reconcile repeated recorded a
 * second checkpoint and a second Activity entry; a repeated delete logged a
 * second "Deleted" and moved deleted_at, and so the restore window.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { queryOne } from "../db/db.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransaction, deleteTransaction } from "../domain/transactions.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { Refusal } from "../core/refusal.ts";
import { freshHousehold, RAVI } from "../engine/identity.test-data.ts";
import { startTestApp } from "./harness.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

function household() {
  const db = freshHousehold();
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 1_000_000,
  }).id;
  const food = createCategory(db, actor, { groupId: createGroup(db, actor, "H").id, name: "Food" }).id;
  const t = createTransaction(db, actor, {
    accountId: bank, amount: -5_000, date: "2026-09-06", payeeName: "Shop", categoryId: food,
  });
  return { db, bank, food, t };
}

const n = (db: ReturnType<typeof household>["db"], sql: string, ...p: string[]) =>
  queryOne<{ n: number }>(db, sql, ...p)!.n;

describe("MONEY-CORE-14 · retried writes that bypassed mutate", () => {
  test("reconcile twice with one key records one checkpoint", async () => {
    const { db, bank } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    const form = { as_of: "10-09-2026", bank_balance: "9900", allow_adjustment: "1" };
    const init = { headers: { "Idempotency-Key": "k-reconcile" } };
    try {
      const first = await app.post(`/accounts/${bank}/reconcile`, form, init);
      const again = await app.post(`/accounts/${bank}/reconcile`, form, init);
      assert.equal(first.status, 200);
      assert.equal(again.status, 200);
      assert.match(await again.text(), /Reconciled/);
      assert.equal(n(db, `SELECT COUNT(*) AS n FROM reconciliations`), 1);
      assert.equal(n(db, `SELECT COUNT(*) AS n FROM events WHERE entity = 'reconciliation'`), 1);
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });

  test("delete twice with one key deletes once", async () => {
    const { db, t } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    const init = { headers: { "Idempotency-Key": "k-delete" } };
    try {
      assert.equal((await app.post(`/transaction/${t.id}/delete`, {}, init)).status, 303);
      const stamped = queryOne<{ deleted_at: string }>(db, `SELECT deleted_at FROM transactions WHERE id = ?`, t.id)!;
      assert.equal((await app.post(`/transaction/${t.id}/delete`, {}, init)).status, 303);
      assert.deepEqual(
        queryOne<{ deleted_at: string }>(db, `SELECT deleted_at FROM transactions WHERE id = ?`, t.id), stamped,
      );
      assert.equal(n(db, `SELECT COUNT(*) AS n FROM events WHERE entity = 'transaction' AND action = 'delete'`), 1);
    } finally { await app.close(); }
  });

  test("an edit retried with one key saves once", async () => {
    const { db, bank, food, t } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    const form = {
      account_id: bank, date: "06-09-2026", amount: "60", direction: "out", payee: "Shop",
      split_category_0: food, memo: "retried",
    };
    const init = { headers: { "Idempotency-Key": "k-edit" } };
    try {
      assert.equal((await app.post(`/transaction/${t.id}`, form, init)).status, 303);
      assert.equal((await app.post(`/transaction/${t.id}`, form, init)).status, 303);
      assert.equal(n(db, `SELECT COUNT(*) AS n FROM events WHERE entity = 'transaction' AND action = 'update'`), 1);
    } finally { await app.close(); }
  });

  test("deleting an already-deleted transaction is refused, not logged again", () => {
    const { db, t } = household();
    deleteTransaction(db, actor, t.id);
    assert.throws(() => deleteTransaction(db, actor, t.id), Refusal);
    assert.equal(n(db, `SELECT COUNT(*) AS n FROM events WHERE entity = 'transaction' AND action = 'delete'`), 1);
  });
});
