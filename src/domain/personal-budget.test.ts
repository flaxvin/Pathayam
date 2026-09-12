/**
 * 15 / P2 · Personal budgets.
 *
 * The property that matters most is the negative one: a household that never
 * creates a personal budget must see precisely the app it had. Every default
 * here points at the household budget for that reason.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned } from "./budget.ts";
import { buildBudgetView } from "../web/viewmodel.ts";
import {
  householdBudgetId, ensurePersonalBudget, personalBudgetFor, budgetsFor,
  listBudgets, lastBudget, rememberBudget,
} from "./budgets.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup(): DB {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  for (const [id, name] of [[RAVI, "Ravi"], [PRIYA, "Priya"]] as const) {
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
      id, `${name.toLowerCase()}@example.com`, name, nowIST());
  }
  return db;
}

describe("P2 · a personal budget is created on request, never by default", () => {
  test("a fresh household has exactly one budget", () => {
    const db = setup();
    assert.deepEqual(listBudgets(db).map((b) => b.kind), ["household"]);
    assert.equal(personalBudgetFor(db, RAVI), null);
    db.close();
  });

  test("creating one is idempotent, and each member gets at most one", () => {
    const db = setup();
    const first = ensurePersonalBudget(db, RAVI, "Ravi");
    assert.equal(ensurePersonalBudget(db, RAVI, "Ravi").id, first.id);
    const hers = ensurePersonalBudget(db, PRIYA, "Priya");
    assert.notEqual(hers.id, first.id);
    assert.equal(listBudgets(db).length, 3);
    db.close();
  });

  test("a member sees the household's budget and their own, never anybody else's", () => {
    const db = setup();
    ensurePersonalBudget(db, RAVI, "Ravi");
    ensurePersonalBudget(db, PRIYA, "Priya");
    assert.deepEqual(budgetsFor(db, RAVI).map((b) => b.name).sort(), ["Household", "Ravi"]);
    assert.deepEqual(budgetsFor(db, PRIYA).map((b) => b.name).sort(), ["Household", "Priya"]);
    // Signed out, or an export: the household's only.
    assert.deepEqual(budgetsFor(db, null).map((b) => b.name), ["Household"]);
    db.close();
  });
});

describe("P2 · the grid shows one budget's money", () => {
  test("a new personal budget is empty while the household's is untouched", () => {
    const db = setup();
    const month = monthOf(todayIST());
    createAccount(db, actor, {
      name: "Joint", kind: "budget", subtype: "savings",
      openingBalance: rupees(1_00_000), openingDate: `${month}-01`,
    });
    const group = createGroup(db, actor, "Flexible");
    createCategory(db, actor, { groupId: group.id, name: "Groceries" });

    const mine = ensurePersonalBudget(db, RAVI, "Ravi");
    assert.equal(buildBudgetView(db, month, householdBudgetId(db)).monthState.readyToAssign,
      rupees(1_00_000));
    assert.equal(buildBudgetView(db, month, mine.id).monthState.readyToAssign, 0,
      "a personal budget starts with nothing until an account moves into it");
    db.close();
  });

  test("moving an account moves its money to the other grid", () => {
    const db = setup();
    const month = monthOf(todayIST());
    const acct = createAccount(db, actor, {
      name: "HDFC", kind: "budget", subtype: "savings",
      openingBalance: rupees(60_000), openingDate: `${month}-01`,
    });
    const mine = ensurePersonalBudget(db, RAVI, "Ravi");
    execute(db, `UPDATE accounts SET budget_id = ? WHERE id = ?`, mine.id, acct.id);

    assert.equal(buildBudgetView(db, month, householdBudgetId(db)).monthState.readyToAssign, 0);
    assert.equal(buildBudgetView(db, month, mine.id).monthState.readyToAssign, rupees(60_000));
    db.close();
  });

  test("with no budget named, every budget is counted — as it always was", () => {
    // The month-close ritual and the digest still call it this way.
    const db = setup();
    const month = monthOf(todayIST());
    const acct = createAccount(db, actor, {
      name: "HDFC", kind: "budget", subtype: "savings",
      openingBalance: rupees(60_000), openingDate: `${month}-01`,
    });
    const mine = ensurePersonalBudget(db, RAVI, "Ravi");
    execute(db, `UPDATE accounts SET budget_id = ? WHERE id = ?`, mine.id, acct.id);
    assert.equal(buildBudgetView(db, month).monthState.readyToAssign, rupees(60_000));
    db.close();
  });
});

describe("P2 · which budget you were last looking at", () => {
  test("it is remembered, and a stale pointer falls back rather than breaking", () => {
    const db = setup();
    const mine = ensurePersonalBudget(db, RAVI, "Ravi");
    assert.equal(lastBudget(db, RAVI), null);
    rememberBudget(db, RAVI, mine.id);
    assert.equal(lastBudget(db, RAVI), mine.id);

    execute(db, `DELETE FROM budgets WHERE id = ?`, mine.id);
    assert.equal(lastBudget(db, RAVI), null, "a budget that no longer exists must not stick");
    db.close();
  });
});
