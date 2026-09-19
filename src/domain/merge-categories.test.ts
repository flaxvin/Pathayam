/**
 * Merging two categories.
 *
 * The thing that can go wrong here is not a lost name — it is lost money.
 * `assignments` is keyed (month, category_id), so the obvious implementation
 * (UPDATE ... SET category_id) collides whenever both categories were assigned
 * to in the same month, which is the normal case for two envelopes anybody
 * wants to merge. Resolve that collision by keeping one row and the ledger is
 * short by the other, while every account balance stays exactly the same — the
 * identity breaks and nothing else announces it.
 *
 * So the assertions here are mostly arithmetic, and the identity is checked
 * before and after.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, formatPaise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned, mergeCategories, setTarget, getCategory } from "./budget.ts";
import { createTransaction } from "./transactions.ts";
import { computeBudget, identityResidual } from "../engine/engine.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { Refusal } from "../core/refusal.ts";

const actor: Actor = { memberId: "m", source: "ui" };
const AUG = "2026-08";
const SEP = "2026-09";

function household() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(200_000),
  }).id;
  const group = createGroup(db, actor, "Flexible");
  const eatingOut = createCategory(db, actor, { groupId: group.id, name: "Eating out" }).id;
  const restaurants = createCategory(db, actor, { groupId: group.id, name: "Restaurants" }).id;
  return { db, bank, group, eatingOut, restaurants };
}

/** The identity, in every computed month. */
function assertIdentity(db: ReturnType<typeof household>["db"], when: string) {
  const state = computeBudget(loadEngineInput(db, { through: SEP }));
  for (const [month, s] of state) {
    assert.equal(
      identityResidual(s), 0,
      `identity broken in ${month} ${when}: accounts ${formatPaise(s.budgetAccountBalance)}`,
    );
  }
  return state;
}

function balanceOf(db: ReturnType<typeof household>["db"], month: string, id: string) {
  return computeBudget(loadEngineInput(db, { through: SEP })).get(month)!.categories.get(id)?.balance ?? 0;
}

describe("merging keeps the money", () => {
  test("two assignments in the same month are added, not one of them dropped", () => {
    const h = household();
    setAssigned(h.db, actor, AUG, h.eatingOut, rupees(4_000));
    setAssigned(h.db, actor, AUG, h.restaurants, rupees(3_000));
    assertIdentity(h.db, "before the merge");

    mergeCategories(h.db, actor, h.restaurants, h.eatingOut);

    assert.equal(
      balanceOf(h.db, AUG, h.eatingOut), rupees(7_000),
      "the two assignments did not add up — this is the collision on (month, category_id)",
    );
    assertIdentity(h.db, "after the merge");
  });

  test("it adds month by month, not just in the one you looked at", () => {
    const h = household();
    setAssigned(h.db, actor, AUG, h.eatingOut, rupees(4_000));
    setAssigned(h.db, actor, AUG, h.restaurants, rupees(3_000));
    setAssigned(h.db, actor, SEP, h.restaurants, rupees(5_000));

    mergeCategories(h.db, actor, h.restaurants, h.eatingOut);

    // August: 4,000 + 3,000 = 7,000, carried into September, plus 5,000.
    assert.equal(balanceOf(h.db, AUG, h.eatingOut), rupees(7_000));
    assert.equal(balanceOf(h.db, SEP, h.eatingOut), rupees(12_000));
    assertIdentity(h.db, "after a two-month merge");
  });

  test("spending follows the category it was filed under", () => {
    const h = household();
    setAssigned(h.db, actor, AUG, h.eatingOut, rupees(4_000));
    setAssigned(h.db, actor, AUG, h.restaurants, rupees(3_000));
    createTransaction(h.db, actor, {
      accountId: h.bank, amount: -rupees(1_200), date: "2026-08-10", categoryId: h.restaurants,
    });
    assertIdentity(h.db, "before");

    mergeCategories(h.db, actor, h.restaurants, h.eatingOut);

    assert.equal(balanceOf(h.db, AUG, h.eatingOut), rupees(5_800), "7,000 assigned less 1,200 spent");
    assertIdentity(h.db, "after");
  });

  test("an overspent loser carries its negative across", () => {
    const h = household();
    setAssigned(h.db, actor, AUG, h.eatingOut, rupees(4_000));
    setAssigned(h.db, actor, AUG, h.restaurants, rupees(1_000));
    createTransaction(h.db, actor, {
      accountId: h.bank, amount: -rupees(2_500), date: "2026-08-10", categoryId: h.restaurants,
    });

    mergeCategories(h.db, actor, h.restaurants, h.eatingOut);

    assert.equal(balanceOf(h.db, AUG, h.eatingOut), rupees(2_500), "5,000 assigned less 2,500 spent");
    assertIdentity(h.db, "after merging an overspent category");
  });

  test("the loser is gone afterwards", () => {
    const h = household();
    setAssigned(h.db, actor, AUG, h.restaurants, rupees(1_000));
    mergeCategories(h.db, actor, h.restaurants, h.eatingOut);
    assert.ok(getCategory(h.db, h.restaurants)?.deleted_at, "the merged category is still live");
    assert.equal(
      queryOne<{ n: number }>(h.db, `SELECT COUNT(*) AS n FROM assignments WHERE category_id = ?`, h.restaurants)!.n,
      0, "assignments were left pointing at a deleted category",
    );
  });
});

describe("the target that survives", () => {
  test("the winner's target stands", () => {
    const h = household();
    setTarget(h.db, actor, h.eatingOut, { type: "monthly", amount: rupees(6_000) });
    setTarget(h.db, actor, h.restaurants, { type: "monthly", amount: rupees(2_000) });
    mergeCategories(h.db, actor, h.restaurants, h.eatingOut);
    const t = queryOne<{ amount: number }>(h.db, `SELECT amount FROM targets WHERE category_id = ?`, h.eatingOut);
    assert.equal(t?.amount, rupees(6_000), "the merged-away target overwrote the one being kept");
  });

  test("the loser's is taken when the winner has none", () => {
    const h = household();
    setTarget(h.db, actor, h.restaurants, { type: "monthly", amount: rupees(2_000) });
    mergeCategories(h.db, actor, h.restaurants, h.eatingOut);
    const t = queryOne<{ amount: number }>(h.db, `SELECT amount FROM targets WHERE category_id = ?`, h.eatingOut);
    assert.equal(t?.amount, rupees(2_000), "a target was thrown away rather than inherited");
  });
});

describe("what it refuses", () => {
  test("merging a category into itself", () => {
    const h = household();
    assert.throws(() => mergeCategories(h.db, actor, h.eatingOut, h.eatingOut), Refusal);
  });

  test("a card's payment category, on either side", () => {
    const h = household();
    const card = createAccount(h.db, actor, {
      name: "Atlas", kind: "credit", subtype: "credit-card",
      openingDate: "2026-08-01", openingBalance: 0,
    }).id;
    const payment = queryOne<{ id: string }>(
      h.db, `SELECT id FROM categories WHERE payment_account_id = ?`, card,
    )!.id;

    assert.throws(() => mergeCategories(h.db, actor, payment, h.eatingOut), Refusal,
      "a payment category was merged away, which unlinks it from its card");
    assert.throws(() => mergeCategories(h.db, actor, h.eatingOut, payment), Refusal,
      "a payment category absorbed an ordinary one");
  });

  test("a category that does not exist", () => {
    const h = household();
    assert.throws(() => mergeCategories(h.db, actor, "nope", h.eatingOut), Refusal);
    assert.throws(() => mergeCategories(h.db, actor, h.eatingOut, "nope"), Refusal);
  });

  test("and nothing is half-done when it refuses", () => {
    const h = household();
    setAssigned(h.db, actor, AUG, h.restaurants, rupees(3_000));
    assert.throws(() => mergeCategories(h.db, actor, h.restaurants, "nope"), Refusal);
    assert.equal(balanceOf(h.db, AUG, h.restaurants), rupees(3_000), "the transaction did not roll back");
    assert.ok(!getCategory(h.db, h.restaurants)?.deleted_at);
  });
});
