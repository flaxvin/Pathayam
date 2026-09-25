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
 *
 * D2 · The remap target was not checked. The same ₹1,000 remapped onto a
 * card's payment envelope vanished — that envelope's activity is derived from
 * the card, so spending filed to it is read by nothing — and the identity was
 * out by −₹1,000 from 2025-02. A commitment envelope, a deleted one, another
 * budget's, or the envelope itself were all accepted too.
 *
 * D11 · Undoing a delete reset the category's columns and said "Restored",
 * but its assignments stayed purged and its remapped history stayed where the
 * delete put it: ₹50 assigned and ₹50 spent in A, deleted with a remap to B,
 * came back as A ₹0 and B overspent by ₹50 in 2025-03.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, queryOne } from "../db/db.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount, paymentCategoryFor } from "./accounts.ts";
import { ensurePersonalBudget } from "./budgets.ts";
import { ensureCommitmentEnvelope } from "./commitments.ts";
import { createTransaction } from "./transactions.ts";
import {
  createGroup, createCategory, deleteCategory, mergeCategories, setAssigned, getCategory,
  startPersonalBudget, setTarget, getTarget, getAssigned, moveMoney,
} from "./budget.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget } from "../engine/engine.ts";
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

describe("D2 · history is only remapped somewhere that counts it", () => {
  const cases: [string, (s: ReturnType<typeof spentDown>) => string][] = [
    ["a card's payment envelope", (s) => {
      const card = createAccount(s.db, actor, {
        name: "Card", kind: "credit", subtype: "credit-card", openingDate: "2025-01-01",
      }).id;
      return paymentCategoryFor(s.db, card)!.id;
    }],
    ["a commitment envelope", (s) => {
      const ravi = ensurePersonalBudget(s.db, RAVI, "Ravi").id;
      startPersonalBudget(s.db, actor, ravi);
      return ensureCommitmentEnvelope(s.db, actor, ravi).id;
    }],
    ["a deleted envelope", (s) => {
      const gone = createCategory(s.db, actor, { groupId: s.group, name: "Gone" }).id;
      deleteCategory(s.db, actor, gone, { currentBalance: 0 });
      return gone;
    }],
    ["another budget's envelope", (s) => {
      const ravi = ensurePersonalBudget(s.db, RAVI, "Ravi").id;
      return createCategory(s.db, actor, {
        groupId: createGroup(s.db, actor, "Mine", "normal", ravi).id, name: "Ravi's",
      }).id;
    }],
    ["the envelope itself", (s) => s.a],
    ["an id that is not an envelope", () => "no-such-category"],
  ];
  for (const [label, target] of cases) {
    test(`remapping to ${label} is refused`, () => {
      const s = spentDown();
      const to = target(s);
      assert.throws(() => deleteCategory(s.db, actor, s.a, { currentBalance: 0, remapTo: to }), Refusal);
      assert.equal(getCategory(s.db, s.a)?.deleted_at, null);
      assert.deepEqual(identityProblems(s.db, "2027-03"), []);
    });
  }

  test("remapping to an ordinary envelope in the same budget works", () => {
    const s = spentDown();
    deleteCategory(s.db, actor, s.a, { currentBalance: 0, remapTo: s.b });
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });

  test("merging into a commitment envelope is refused", () => {
    const s = spentDown();
    const ravi = ensurePersonalBudget(s.db, RAVI, "Ravi").id;
    const mine = createCategory(s.db, actor, {
      groupId: createGroup(s.db, actor, "Mine", "normal", ravi).id, name: "Ravi's",
    }).id;
    const envelope = ensureCommitmentEnvelope(s.db, actor, ravi).id;
    assert.throws(() => mergeCategories(s.db, actor, mine, envelope), Refusal);
  });
});

describe("D11 · undoing a delete gives back what it took", () => {
  const balances = (db: Parameters<typeof loadEngineInput>[0], month: string) => {
    const state = computeBudget(loadEngineInput(db, { through: month as never, useRollup: false }))
      .get(month as never)!;
    return (id: string) => state.categories.get(id)?.balance ?? null;
  };
  const undoDelete = (db: Parameters<typeof loadEngineInput>[0], id: string) => {
    const event = queryOne<{ id: string }>(
      db, `SELECT id FROM events WHERE entity = 'category' AND entity_id = ? AND action = 'delete'`, id,
    )!.id;
    assert.equal(undoEvent(db, event, actor, { force: true }).ok, true);
  };

  test("with a remap: the assignment, the target and the moved transaction come back", () => {
    const db = freshHousehold();
    const group = createGroup(db, actor, "Everyday").id;
    const a = createCategory(db, actor, { groupId: group, name: "A" }).id;
    const b = createCategory(db, actor, { groupId: group, name: "B" }).id;
    const bank = createAccount(db, actor, {
      name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: 1_000_000,
    }).id;
    setAssigned(db, actor, "2025-03", a, 5_000);
    setTarget(db, actor, a, { type: "monthly", amount: 5_000 });
    const tx = createTransaction(db, actor, { accountId: bank, amount: -5_000, date: "2025-03-12", categoryId: a });

    deleteCategory(db, actor, a, { currentBalance: 0, remapTo: b });
    assert.equal(balances(db, "2025-03")(b), -5_000, "B took the spending");
    undoDelete(db, a);

    const balance = balances(db, "2025-03");
    assert.equal(balance(a), 0);
    assert.equal(balance(b), 0, "B is not left overspent");
    assert.equal(getAssigned(db, "2025-03", a), 5_000);
    assert.equal(getTarget(db, a)?.amount, 5_000);
    assert.equal(queryOne<{ category_id: string }>(
      db, `SELECT category_id FROM transactions WHERE id = ?`, tx.id,
    )?.category_id, a);
    assert.deepEqual(identityProblems(db, "2027-03"), []);
  });

  test("without a remap: assignments that netted to zero come back", () => {
    const db = freshHousehold();
    const group = createGroup(db, actor, "Everyday").id;
    const a = createCategory(db, actor, { groupId: group, name: "A" }).id;
    const b = createCategory(db, actor, { groupId: group, name: "B" }).id;
    createAccount(db, actor, {
      name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: 1_000_000,
    });
    setAssigned(db, actor, "2025-03", a, 7_000);
    moveMoney(db, actor, { month: "2025-04", fromCategoryId: a, toCategoryId: b, amount: 7_000 });
    deleteCategory(db, actor, a, { currentBalance: 0 });
    undoDelete(db, a);
    assert.equal(getAssigned(db, "2025-03", a), 7_000);
    assert.equal(getAssigned(db, "2025-04", a), -7_000);
    assert.equal(balances(db, "2025-04")(b), 7_000);
    assert.deepEqual(identityProblems(db, "2027-03"), []);
  });

  test("a transaction re-filed since the delete stays where it was put", () => {
    const s = spentDown();
    const c = createCategory(s.db, actor, { groupId: s.group, name: "C" }).id;
    const tx = queryOne<{ id: string }>(s.db, `SELECT id FROM transactions WHERE category_id = ?`, s.a)!.id;
    deleteCategory(s.db, actor, s.a, { currentBalance: 0, remapTo: s.b });
    execute(s.db, `UPDATE transactions SET category_id = ? WHERE id = ?`, c, tx);
    undoDelete(s.db, s.a);
    assert.equal(queryOne<{ category_id: string }>(
      s.db, `SELECT category_id FROM transactions WHERE id = ?`, tx,
    )?.category_id, c);
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });
});
