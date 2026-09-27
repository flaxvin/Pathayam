/**
 * R5 · Moving money between envelopes, and undoing it.
 *
 * BUDGET-4 · The move event named only the destination and the undo guessed
 * the source as "whichever envelope now holds what the source was left with".
 * Moving everything out of A left A with no row, so the undo restored B and not
 * A, and the ₹500 fell back into Ready to Assign under "Reversed the move of
 * ₹500"; when another envelope held the same amount, either one could be put
 * back.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne, type DB } from "../db/db.ts";
import { undoEvent, appendEvent, type Actor } from "../core/events.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned, getAssigned, moveMoney } from "./budget.ts";
import { ensurePersonalBudget } from "./budgets.ts";
import { freshHousehold, identityProblems, rtaOf, RAVI } from "../engine/identity.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };
const M = "2025-05";

function setup() {
  const db = freshHousehold();
  createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: `${M}-01`, openingBalance: 1_000_000,
  });
  const g = createGroup(db, actor, "G");
  const [a, b, c] = ["A", "B", "C"].map((name) => createCategory(db, actor, { groupId: g.id, name }).id) as
    [string, string, string];
  return { db, a, b, c };
}

const lastMove = (db: DB) =>
  queryOne<{ id: string }>(
    db, `SELECT id FROM events WHERE entity = 'assignment' AND action = 'move' ORDER BY seq DESC LIMIT 1`,
  )!.id;

describe("BUDGET-4 · undoing a move puts both envelopes back", () => {
  test("moving everything out of A and undoing it restores A", () => {
    const { db, a, b } = setup();
    setAssigned(db, actor, M, a, 50_000);
    const rta = rtaOf(db, M);
    moveMoney(db, actor, { month: M, fromCategoryId: a, toCategoryId: b, amount: 50_000 });
    assert.equal(undoEvent(db, lastMove(db), actor).ok, true);
    assert.equal(getAssigned(db, M, a), 50_000);
    assert.equal(getAssigned(db, M, b), 0);
    assert.equal(rtaOf(db, M), rta);
    assert.deepEqual(identityProblems(db, M), []);
  });

  test("an envelope holding the same amount as the source is never the one restored", () => {
    for (let i = 0; i < 10; i++) {
      const { db, a, b, c } = setup();
      setAssigned(db, actor, M, c, 20_000);
      setAssigned(db, actor, M, a, 30_000);
      moveMoney(db, actor, { month: M, fromCategoryId: a, toCategoryId: b, amount: 10_000 }); // A is now C's ₹200
      undoEvent(db, lastMove(db), actor);
      assert.deepEqual(
        [getAssigned(db, M, a), getAssigned(db, M, b), getAssigned(db, M, c)],
        [30_000, 0, 20_000],
      );
    }
  });

  test("an older event that names no source is refused when the source cannot be told apart", () => {
    const { db, a, b, c } = setup();
    setAssigned(db, actor, M, a, 20_000);
    setAssigned(db, actor, M, b, 10_000);
    setAssigned(db, actor, M, c, 20_000);
    const old = appendEvent(db, actor, {
      entity: "assignment", entityId: `${M}:${b}`, action: "move",
      before: { from: 30_000, to: 0 }, after: { from: 20_000, to: 10_000 },
      summary: "Moved ₹100 from A to B",
    });
    assert.throws(() => undoEvent(db, old.id, actor), Refusal);
    assert.deepEqual(
      [getAssigned(db, M, a), getAssigned(db, M, b), getAssigned(db, M, c)],
      [20_000, 10_000, 20_000],
    );
  });
});

describe("BUDGET-5 · money moves between envelopes of one budget only", () => {
  test("a move from the household's Groceries to Ravi's own Fun is refused", () => {
    const { db, a } = setup();
    const mine = ensurePersonalBudget(db, RAVI, "Ravi").id;
    createAccount(db, actor, {
      name: "Ravi's", kind: "budget", subtype: "savings", openingDate: `${M}-01`,
      openingBalance: 100_000, budgetId: mine, holderMemberId: RAVI,
    });
    const fun = createCategory(db, actor, { groupId: createGroup(db, actor, "Mine", "normal", mine).id, name: "Fun" });
    setAssigned(db, actor, M, a, 100_000);
    setAssigned(db, actor, M, fun.id, 100_000);
    const before = [rtaOf(db, M, "budget-household"), rtaOf(db, M, mine)];
    assert.throws(
      () => moveMoney(db, actor, { month: M, fromCategoryId: a, toCategoryId: fun.id, amount: 40_000 }),
      Refusal,
    );
    assert.deepEqual([rtaOf(db, M, "budget-household"), rtaOf(db, M, mine)], before);
    assert.equal(getAssigned(db, M, a), 100_000);
  });
});
