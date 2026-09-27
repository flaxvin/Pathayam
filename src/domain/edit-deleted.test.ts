/**
 * EXTRA-3 · A deleted transaction is not edited.
 *
 * updateTransaction and the routes over it took a deleted row: a new amount,
 * memo or envelope was written and answered 303 "Saved.", on a row every
 * balance skips — so nothing visible moved until the delete was undone and the
 * row came back as something it never was.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createTransaction, deleteTransaction, updateTransaction } from "./transactions.ts";
import { Refusal } from "../core/refusal.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const account = createAccount(db, actor, {
    name: "ZZ Bank", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 10_00_000,
  }).id;
  const g = createGroup(db, actor, "ZZ Group");
  const food = createCategory(db, actor, { groupId: g.id, name: "ZZ Food" }).id;
  const t = createTransaction(db, actor, {
    accountId: account, amount: -50_000, date: "2026-09-01", categoryId: food, memo: "ZZ lunch",
  });
  deleteTransaction(db, actor, t.id);
  return { db, food, id: t.id };
}

const row = (db: ReturnType<typeof freshDb>, id: string) =>
  queryOne<{ memo: string | null; amount: number; reimbursable: number }>(
    db, `SELECT memo, amount, reimbursable FROM transactions WHERE id = ?`, id)!;

describe("EXTRA-3 · editing a deleted transaction", () => {
  test("the domain refuses it and writes nothing", () => {
    const { db, id } = setup();
    assert.throws(() => updateTransaction(db, actor, id, { memo: "ZZ edited", amount: -90_000 }), Refusal);
    assert.deepEqual({ ...row(db, id) }, { memo: "ZZ lunch", amount: -50_000, reimbursable: 0 });
  });

  test("every route that changes one answers 422, and the row is as it was", async () => {
    const { db, food, id } = setup();
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const posts: [string, Record<string, string>][] = [
        [`/transaction/${id}`, { date: "2026-09-01", amount: "700", direction: "out", memo: "ZZ edited", category_id: food }],
        [`/transaction/${id}/categorise`, { category_id: food }],
        [`/transaction/${id}/settled`, {}],
        [`/transaction/${id}/convert-to-emi`, { tenure_months: "6", annual_rate: "15" }],
      ];
      for (const [path, body] of posts) {
        const res = await app.post(path, body);
        assert.equal(res.status, 422, path);
        assert.match(await res.text(), /has been deleted/);
      }
      assert.deepEqual({ ...row(db, id) }, { memo: "ZZ lunch", amount: -50_000, reimbursable: 0 });
      // Viewing it stays open: Activity links to it.
      assert.equal((await app.get(`/transaction/${id}`)).status, 200);
    } finally {
      await app.close();
    }
  });
});
