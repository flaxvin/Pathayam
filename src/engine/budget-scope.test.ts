/**
 * 15 · The engine, scoped to one budget.
 *
 * The arithmetic does not change: `computeBudget` is handed a smaller set of
 * facts and does the same thing to it. What changes is `loadEngineInput`, which
 * now filters every fact by the budget its account or category belongs to.
 *
 * The failure this pins is one I actually made: the filter added a `?` to the
 * SQL without passing the parameter, so `budget_id = NULL` matched nothing and
 * every categorised fact silently vanished. The identity caught it; a test that
 * only checked "the scoped total is smaller" would not have.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { formatPaise } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { loadEngineInput } from "./repository.ts";
import { computeBudget, identityResidual } from "./engine.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };
const HOUSEHOLD = "budget-household";

function setup(): { db: DB; month: string } {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  return { db, month: monthOf(todayIST()) };
}

function residuals(db: DB, budgetId: string | undefined, useRollup: boolean): string[] {
  const out = computeBudget(loadEngineInput(db, { through: monthOf(todayIST()), useRollup, budgetId }));
  assert.ok(out.size > 0, "no months were computed");
  return [...out]
    .filter(([, st]) => identityResidual(st) !== 0)
    .map(([m, st]) => `${m} out by ${formatPaise(identityResidual(st))}`);
}

describe("15 · the identity holds for each budget on its own", () => {
  test("the migration puts everything in one household budget", () => {
    const { db } = setup();
    const row = queryOne<{ id: string; kind: string }>(db, `SELECT id, kind FROM budgets`);
    assert.equal(row?.id, HOUSEHOLD);
    assert.equal(row?.kind, "household");
    db.close();
  });

  test("scoped and unscoped agree while there is only one budget", () => {
    const { db, month } = setup();
    const bank = createAccount(db, actor, {
      name: "HDFC", kind: "budget", subtype: "savings",
      openingBalance: rupees(1_00_000), openingDate: `${month}-01`,
    });
    const card = createAccount(db, actor, {
      name: "Card", kind: "credit", subtype: "credit-card", openingDate: `${month}-01`,
    });
    const group = createGroup(db, actor, "Flexible");
    const food = createCategory(db, actor, { groupId: group.id, name: "Food" });
    setAssigned(db, actor, month, food.id, rupees(20_000));
    createTransaction(db, actor, {
      accountId: bank.id, amount: rupees(-8_000), date: `${month}-05`, categoryId: food.id,
    });
    createTransaction(db, actor, {
      accountId: card.id, amount: rupees(-3_000), date: `${month}-06`, categoryId: food.id,
    });

    for (const useRollup of [true, false]) {
      assert.deepEqual(residuals(db, undefined, useRollup), [], `unscoped, rollup ${useRollup}`);
      assert.deepEqual(residuals(db, HOUSEHOLD, useRollup), [], `household, rollup ${useRollup}`);
    }
    db.close();
  });

  test("a second budget partitions the facts rather than hiding them", () => {
    // The regression that motivated this file: a filter whose parameter is
    // never bound returns nothing, and "nothing" looks like a working scope
    // until the identity is checked.
    const { db, month } = setup();
    execute(db, `INSERT INTO budgets (id,kind,member_id,name,created_at) VALUES (?,?,?,?,?)`,
      "budget-ravi", "personal", RAVI, "Ravi", nowIST());

    const joint = createAccount(db, actor, {
      name: "Joint", kind: "budget", subtype: "savings",
      openingBalance: rupees(1_00_000), openingDate: `${month}-01`,
    });
    const mine = createAccount(db, actor, {
      name: "Mine", kind: "budget", subtype: "savings",
      openingBalance: rupees(40_000), openingDate: `${month}-01`,
    });
    execute(db, `UPDATE accounts SET budget_id = ? WHERE id = ?`, "budget-ravi", mine.id);

    const group = createGroup(db, actor, "Flexible");
    const shared = createCategory(db, actor, { groupId: group.id, name: "Groceries" });
    const personal = createCategory(db, actor, { groupId: group.id, name: "Personal" });
    execute(db, `UPDATE categories SET budget_id = ? WHERE id = ?`, "budget-ravi", personal.id);

    setAssigned(db, actor, month, shared.id, rupees(30_000));
    createTransaction(db, actor, {
      accountId: joint.id, amount: rupees(-12_000), date: `${month}-04`, categoryId: shared.id,
    });
    createTransaction(db, actor, {
      accountId: mine.id, amount: rupees(-5_000), date: `${month}-07`, categoryId: personal.id,
    });

    for (const useRollup of [true, false]) {
      assert.deepEqual(residuals(db, HOUSEHOLD, useRollup), [], `household, rollup ${useRollup}`);
      assert.deepEqual(residuals(db, "budget-ravi", useRollup), [], `personal, rollup ${useRollup}`);
    }

    // And the split is real: each budget sees only its own money.
    const house = computeBudget(loadEngineInput(db, { through: month, budgetId: HOUSEHOLD }));
    const ravi = computeBudget(loadEngineInput(db, { through: month, budgetId: "budget-ravi" }));
    assert.equal(house.get(month)!.readyToAssign, rupees(70_000), "1,00,000 in, 30,000 assigned");
    assert.equal(ravi.get(month)!.readyToAssign, rupees(40_000), "his own money, none assigned yet");
    db.close();
  });
});
