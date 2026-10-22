/**
 * DEBUG-ENGINE-3 · Money is not given a job in an envelope that has been deleted.
 *
 * The engine reads assignments for every envelope, deleted or not, but walks
 * only the live ones. So ₹500 assigned to a deleted envelope (a stale budget
 * tab, an API call, a "move" from a form opened before the delete) came off
 * Ready to Assign and appeared in no envelope: the accounts and the envelopes
 * disagreed by ₹500 in every month after.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, deleteCategory, setAssigned, moveMoney } from "./budget.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget, identityResidual } from "../engine/engine.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "ravi@example.com", "Ravi", nowIST());
  createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: todayIST(), openingBalance: rupees(10_000),
  });
  const group = createGroup(db, actor, "Everyday");
  const food = createCategory(db, actor, { groupId: group.id, name: "Food" }).id;
  const old = createCategory(db, actor, { groupId: group.id, name: "Old" }).id;
  deleteCategory(db, actor, old, { currentBalance: 0 });
  return { db, food, old };
}

function residual(db: DB): number {
  const month = monthOf(todayIST());
  return identityResidual(computeBudget(loadEngineInput(db, { through: month })).get(month)!);
}

test("assigning to a deleted envelope is refused, and the books still close", () => {
  const { db, old } = setup();
  const month = monthOf(todayIST());
  assert.throws(() => setAssigned(db, actor, month, old, rupees(500)), Refusal);
  assert.equal(residual(db), 0);
  db.close();
});

test("moving money into or out of a deleted envelope is refused", () => {
  const { db, food, old } = setup();
  const month = monthOf(todayIST());
  setAssigned(db, actor, month, food, rupees(1_000));
  assert.throws(() => moveMoney(db, actor, {
    month, fromCategoryId: food, toCategoryId: old, amount: rupees(300),
  }), Refusal);
  assert.throws(() => moveMoney(db, actor, {
    month, fromCategoryId: old, toCategoryId: food, amount: rupees(300),
  }), Refusal);
  assert.equal(residual(db), 0);
  db.close();
});
