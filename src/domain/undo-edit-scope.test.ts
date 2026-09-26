/**
 * MONEY-CORE-2 / 3 / 19 · Undoing an edit puts back what the edit changed.
 *
 * The update-undo wrote every column of the snapshot onto the row. Two of
 * those the edit had never touched, and the world since had: `deleted_at`
 * (edit a transfer leg's memo, delete the transfer, undo the memo edit — one
 * leg came back alone and ₹1,000 vanished) and `category_id` (merge the
 * envelope away, undo an earlier memo edit — the spend went back to the dead
 * envelope, out of every budget figure). And an envelope that the edit did
 * move out of, removed since, was a FOREIGN KEY failure — a 500.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { undoEvent } from "../core/events.ts";
import { queryAll, queryOne } from "../db/db.ts";
import { createAccount } from "./accounts.ts";
import {
  createTransaction, createTransfer, deleteTransaction, updateTransaction, mergePayees,
} from "./transactions.ts";
import { createGroup, createCategory, mergeCategories } from "./budget.ts";
import { freshHousehold, identityProblems, RAVI } from "../engine/identity.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

function household() {
  const db = freshHousehold();
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: 1_000_000,
  }).id;
  const group = createGroup(db, actor, "Everyday").id;
  const food = createCategory(db, actor, { groupId: group, name: "Food" }).id;
  const snacks = createCategory(db, actor, { groupId: group, name: "Snacks" }).id;
  return { db, bank, food, snacks };
}

const lastEvent = (db: ReturnType<typeof household>["db"], entity: string, action: string) =>
  queryOne<{ id: string }>(
    db, `SELECT id FROM events WHERE entity = ? AND action = ? ORDER BY seq DESC LIMIT 1`, entity, action,
  )!.id;

describe("MONEY-CORE-2 · undoing an edit of a transfer leg after the transfer was deleted", () => {
  test("neither leg comes back: the edit never changed deleted_at", () => {
    const { db, bank } = household();
    const other = createAccount(db, actor, {
      name: "Bank B", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: 0,
    }).id;
    const [out] = createTransfer(db, actor, { fromAccountId: bank, toAccountId: other, amount: 100_000, date: "2025-03-10" });
    updateTransaction(db, actor, out.id, { memo: "rent share" });
    const edit = lastEvent(db, "transaction", "update");
    deleteTransaction(db, actor, out.id);

    assert.equal(undoEvent(db, edit, actor, { force: true }).ok, true);
    const legs = queryAll<{ deleted: number; memo: string | null }>(
      db, `SELECT deleted_at IS NOT NULL AS deleted, memo FROM transactions WHERE transfer_pair_id = ?`, out.transfer_pair_id,
    );
    assert.deepEqual(legs.map((l) => l.deleted), [1, 1]);
    assert.equal(legs.some((l) => l.memo === "rent share"), false);
    assert.deepEqual(identityProblems(db, "2025-12"), []);
  });
});

describe("MONEY-CORE-19 · undoing an edit after its envelope was merged away", () => {
  test("a memo edit undone leaves the spend in the envelope it was merged into", () => {
    const { db, bank, food, snacks } = household();
    const t = createTransaction(db, actor, { accountId: bank, amount: -50_000, date: "2025-03-10", categoryId: snacks });
    updateTransaction(db, actor, t.id, { memo: "tea" });
    const edit = lastEvent(db, "transaction", "update");
    mergeCategories(db, actor, snacks, food);

    assert.equal(undoEvent(db, edit, actor, { force: true }).ok, true);
    const row = queryOne<{ category_id: string; memo: string | null }>(
      db, `SELECT category_id, memo FROM transactions WHERE id = ?`, t.id,
    )!;
    assert.equal(row.category_id, food);
    assert.equal(row.memo, null);
    assert.deepEqual(identityProblems(db, "2025-12"), []);
  });

  test("an edit that moved it out of the merged-away envelope is refused, not filed back", () => {
    const { db, bank, food, snacks } = household();
    const t = createTransaction(db, actor, { accountId: bank, amount: -50_000, date: "2025-03-10", categoryId: snacks });
    updateTransaction(db, actor, t.id, { categoryId: food });
    const edit = lastEvent(db, "transaction", "update");
    const other = createCategory(db, actor, { groupId: createGroup(db, actor, "More").id, name: "Treats" }).id;
    mergeCategories(db, actor, snacks, other);

    assert.throws(() => undoEvent(db, edit, actor, { force: true }), /merged away or deleted/);
    assert.equal(queryOne<{ c: string }>(db, `SELECT category_id c FROM transactions WHERE id = ?`, t.id)!.c, food);
    assert.deepEqual(identityProblems(db, "2025-12"), []);
  });

  test("a payee merged since goes back as the payee it was merged into", () => {
    const { db, bank, food } = household();
    const t = createTransaction(db, actor, { accountId: bank, amount: -5_000, date: "2025-03-10", categoryId: food, payeeName: "D-Mart Ltd" });
    const loser = t.payee_id!;
    const kiosk = createTransaction(db, actor, { accountId: bank, amount: -1_000, date: "2025-03-09", categoryId: food, payeeName: "Kiosk" }).payee_id!;
    updateTransaction(db, actor, t.id, { payeeId: kiosk });
    const edit = lastEvent(db, "transaction", "update");
    const winner = createTransaction(db, actor, { accountId: bank, amount: -1_000, date: "2025-03-11", categoryId: food, payeeName: "DMart" }).payee_id!;
    mergePayees(db, actor, loser, winner);

    assert.equal(undoEvent(db, edit, actor, { force: true }).ok, true);
    assert.equal(queryOne<{ p: string }>(db, `SELECT payee_id p FROM transactions WHERE id = ?`, t.id)!.p, winner);
  });
});

describe("MONEY-CORE-3 · undoing an edit whose earlier envelope was removed since", () => {
  test("is refused naming the envelope, not a FOREIGN KEY failure", () => {
    const { db, bank, food, snacks } = household();
    const snacksCreated = queryOne<{ id: string }>(
      db, `SELECT id FROM events WHERE entity = 'category' AND action = 'create' AND entity_id = ?`, snacks,
    )!.id;
    const t = createTransaction(db, actor, { accountId: bank, amount: -5_000, date: "2025-03-10", categoryId: snacks });
    updateTransaction(db, actor, t.id, { categoryId: food });
    const edit = lastEvent(db, "transaction", "update");
    assert.equal(undoEvent(db, snacksCreated, actor, { force: true }).ok, true);

    assert.throws(() => undoEvent(db, edit, actor, { force: true }), /no longer counts/);
    assert.equal(queryOne<{ c: string }>(db, `SELECT category_id c FROM transactions WHERE id = ?`, t.id)!.c, food);
  });

  test("the same for a split line naming the removed envelope", () => {
    const { db, bank, food, snacks } = household();
    const snacksCreated = queryOne<{ id: string }>(
      db, `SELECT id FROM events WHERE entity = 'category' AND action = 'create' AND entity_id = ?`, snacks,
    )!.id;
    const t = createTransaction(db, actor, {
      accountId: bank, amount: -5_000, date: "2025-03-10",
      splits: [{ categoryId: snacks, amount: -2_000 }, { categoryId: food, amount: -3_000 }],
    });
    updateTransaction(db, actor, t.id, { categoryId: food, splits: null });
    const edit = lastEvent(db, "transaction", "update");
    assert.equal(undoEvent(db, snacksCreated, actor, { force: true }).ok, true);

    assert.throws(() => undoEvent(db, edit, actor, { force: true }), /no longer counts/);
  });
});
