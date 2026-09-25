/**
 * D16 · moveCategoryToGroup accepted another budget's group.
 *
 * The household's A (₹400 assigned, ₹300 spent in 2025-03) moved into a group
 * in Ravi's budget kept categories.budget_id = the household: the household's
 * grid stopped listing A while its Ready to Assign still netted A's ₹100, and
 * Ravi's grid listed an envelope with a balance of ₹0 that was not his.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { Missing, Refusal } from "../core/refusal.ts";
import { createAccount } from "./accounts.ts";
import { createTransaction } from "./transactions.ts";
import { ensurePersonalBudget } from "./budgets.ts";
import { createGroup, createCategory, moveCategoryToGroup, setAssigned, getCategory } from "./budget.ts";
import { freshHousehold, identityProblems, RAVI } from "../engine/identity.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

function setup() {
  const db = freshHousehold();
  const everyday = createGroup(db, actor, "Everyday").id;
  const bills = createGroup(db, actor, "Bills").id;
  const a = createCategory(db, actor, { groupId: everyday, name: "A" }).id;
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: 1_000_000,
  }).id;
  setAssigned(db, actor, "2025-03", a, 40_000);
  createTransaction(db, actor, { accountId: bank, amount: -30_000, date: "2025-03-05", categoryId: a });
  const ravi = ensurePersonalBudget(db, RAVI, "Ravi").id;
  const his = createGroup(db, actor, "Mine", "normal", ravi).id;
  return { db, a, everyday, bills, his };
}

describe("D16 · an envelope is regrouped only within its own budget", () => {
  test("into another budget's group is refused", () => {
    const s = setup();
    assert.throws(() => moveCategoryToGroup(s.db, actor, s.a, s.his), Refusal);
    assert.equal(getCategory(s.db, s.a)?.group_id, s.everyday);
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });

  test("into a group that does not exist is a 404, not a foreign key", () => {
    const s = setup();
    assert.throws(() => moveCategoryToGroup(s.db, actor, s.a, "no-such-group"), Missing);
  });

  test("within the same budget it moves", () => {
    const s = setup();
    moveCategoryToGroup(s.db, actor, s.a, s.bills);
    assert.equal(getCategory(s.db, s.a)?.group_id, s.bills);
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });
});
