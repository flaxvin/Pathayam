/**
 * Deleting an envelope, checked against the identity in every scope, live and
 * through the rollup.
 *
 * D1 · Bank ₹1,00,000; ₹1,000 assigned to A in 2025-02 and ₹1,000 spent from
 * it, so A's balance is ₹0 and the delete was allowed. It purged A's
 * assignments while the spending stayed filed to A, and the engine stops
 * reading a deleted envelope: Ready to Assign stayed ₹1,00,000 while the bank
 * held ₹99,000 — the identity out by −₹1,000 in every month from 2025-02. Via
 * the Categories page too (303 "Category deleted.").
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount } from "./accounts.ts";
import { createTransaction } from "./transactions.ts";
import {
  createGroup, createCategory, deleteCategory, mergeCategories, setAssigned, getCategory,
} from "./budget.ts";
import { freshHousehold, identityProblems, RAVI } from "../engine/identity.test-data.ts";
import { startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

function spentDown() {
  const db = freshHousehold();
  const group = createGroup(db, actor, "Everyday").id;
  const a = createCategory(db, actor, { groupId: group, name: "A" }).id;
  const b = createCategory(db, actor, { groupId: group, name: "B" }).id;
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: 10_000_000,
  }).id;
  setAssigned(db, actor, "2025-02", a, 100_000);
  createTransaction(db, actor, { accountId: bank, amount: -100_000, date: "2025-02-10", categoryId: a });
  return { db, group, a, b, bank };
}

describe("D1 · an envelope with history is not deleted outright", () => {
  test("refused without a remap, and nothing changes", () => {
    const s = spentDown();
    assert.throws(
      () => deleteCategory(s.db, actor, s.a, { currentBalance: 0 }),
      (e: unknown) => e instanceof Refusal && /Merge it into another envelope/.test((e as Error).message),
    );
    assert.equal(getCategory(s.db, s.a)?.deleted_at, null);
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });

  test("a trashed transaction still counts as history", () => {
    const s = spentDown();
    execute(s.db, `UPDATE transactions SET deleted_at = ? WHERE category_id = ?`, nowIST(), s.a);
    assert.throws(() => deleteCategory(s.db, actor, s.a, { currentBalance: 0 }), Refusal);
  });

  test("merging carries the history, and the identity holds", () => {
    const s = spentDown();
    mergeCategories(s.db, actor, s.a, s.b);
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });

  test("an envelope that was never used still deletes", () => {
    const s = spentDown();
    const unused = createCategory(s.db, actor, { groupId: s.group, name: "Unused" }).id;
    deleteCategory(s.db, actor, unused, { currentBalance: 0 });
    assert.ok(getCategory(s.db, unused)?.deleted_at);
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });

  test("nothing new can be filed to a deleted envelope", () => {
    const s = spentDown();
    const unused = createCategory(s.db, actor, { groupId: s.group, name: "Unused" }).id;
    deleteCategory(s.db, actor, unused, { currentBalance: 0 });
    assert.throws(
      () => createTransaction(s.db, actor, { accountId: s.bank, amount: -500, date: "2025-03-01", categoryId: unused }),
      (e: unknown) => e instanceof Refusal && /has been deleted/.test((e as Error).message),
    );
  });

  test("the Categories page answers 422, not 'Category deleted.'", async () => {
    const s = spentDown();
    execute(s.db, `UPDATE household SET setup_completed_at = ? WHERE id = 1`, nowIST());
    const app = await startTestApp(s.db, { memberId: RAVI });
    try {
      const res = await app.post(`/categories/${s.a}/delete`, {});
      assert.equal(res.status, 422);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });
});
