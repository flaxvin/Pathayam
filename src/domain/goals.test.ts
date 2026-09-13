import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { historyFor, undoEvent } from "../core/events.ts";
import { createGroup, createCategory } from "./budget.ts";
import {
  createGoal, updateGoal, deleteGoal, getGoal, listGoals, goalCategoryIds,
} from "./goals.ts";
import { queryOne } from "../db/db.ts";
import { householdBudgetId, ensurePersonalBudget } from "./budgets.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`, "m", "f@e.com", "F", nowIST());
  const g = createGroup(db, actor, "Savings goals");
  const cat = createCategory(db, actor, { groupId: g.id, name: "Kerala trip" }).id;
  return { db, cat };
}

describe("F11 · goals are editable and deletable", () => {
  test("a goal's name, target and date can be edited, and it undoes", () => {
    const { db, cat } = setup();
    const goal = createGoal(db, actor, { name: "Kerala trip", targetAmount: rupees(60000), categoryIds: [cat] });

    updateGoal(db, actor, goal.id, { name: "Kerala trip 2027", targetAmount: rupees(75000), targetDate: "2027-01-01" });
    let after = getGoal(db, goal.id)!;
    assert.equal(after.name, "Kerala trip 2027");
    assert.equal(after.target_amount, rupees(75000));
    assert.equal(after.target_date, "2027-01-01");

    // Undo restores every field, not just some.
    const ev = historyFor(db, "goal", goal.id).find((e) => e.action === "update")!;
    undoEvent(db, ev.id, actor);
    after = getGoal(db, goal.id)!;
    assert.equal(after.name, "Kerala trip");
    assert.equal(after.target_amount, rupees(60000));
    assert.equal(after.target_date, null);
    db.close();
  });

  test("a goal can be deleted; the money in its category is untouched", () => {
    const { db, cat } = setup();
    const goal = createGoal(db, actor, { name: "Kerala trip", targetAmount: rupees(60000), categoryIds: [cat] });
    deleteGoal(db, actor, goal.id);
    assert.equal(getGoal(db, goal.id), null);
    assert.equal(listGoals(db).length, 0);
    // The category still exists.
    const catRow = db.prepare(`SELECT deleted_at FROM categories WHERE id = ?`).get(cat) as { deleted_at: string | null };
    assert.equal(catRow.deleted_at, null, "the category is left intact");
    db.close();
  });

  test("a target above zero is required", () => {
    const { db, cat } = setup();
    const goal = createGoal(db, actor, { name: "X", targetAmount: rupees(1000), categoryIds: [cat] });
    assert.throws(() => updateGoal(db, actor, goal.id, { name: "X", targetAmount: 0 }), /above zero/);
    db.close();
  });
});

/** The new tests want the database on its own; the old ones want the category too. */
function freshDb() {
  return setup().db;
}

describe("B58 · a goal owns its own envelope, whoever makes it", () => {
  /**
   * The rule lived in the route that handles the form, so it was only true of
   * goals created through that form. The demo seed pointed its goals at ordinary
   * envelopes — a trip fund measured by the household's general "Travel home",
   * with the app's rename and delete controls still on it — and nothing stopped
   * it, because the invariant was in the wrong layer.
   */
  test("createGoal makes an app-managed envelope when none is given", () => {
    const db = freshDb();
    const goal = createGoal(db, actor, {
      name: "Kerala trip", targetAmount: rupees(90_000),
    });

    const linked = goalCategoryIds(db, goal.id);
    assert.equal(linked.length, 1, "exactly one envelope");

    const category = queryOne<{ name: string; group_id: string; budget_id: string }>(
      db, `SELECT name, group_id, budget_id FROM categories WHERE id = ?`, linked[0]!,
    )!;
    assert.equal(category.name, "Kerala trip", "named for the goal");
    assert.equal(category.budget_id, householdBudgetId(db));

    const group = queryOne<{ name: string; kind: string }>(
      db, `SELECT name, kind FROM category_groups WHERE id = ?`, category.group_id,
    )!;
    assert.equal(group.kind, "internal", "managed by the app, so it carries no manual controls");
    assert.equal(group.name, "Goals");
  });

  test("two goals get two envelopes, not one shared one", () => {
    const db = freshDb();
    const a = createGoal(db, actor, { name: "Kerala trip", targetAmount: rupees(90_000) });
    const b = createGoal(db, actor, { name: "New laptop", targetAmount: rupees(1_20_000) });
    assert.notEqual(goalCategoryIds(db, a.id)[0], goalCategoryIds(db, b.id)[0]);
  });

  test("a goal's envelope is in the goal's own budget (15 §6B)", () => {
    const db = freshDb();
    const mine = ensurePersonalBudget(db, "m", "Ravi");
    const goal = createGoal(db, actor, {
      name: "New camera", targetAmount: rupees(60_000), budgetId: mine.id,
    });
    const category = queryOne<{ budget_id: string }>(
      db, `SELECT budget_id FROM categories WHERE id = ?`, goalCategoryIds(db, goal.id)[0]!,
    )!;
    assert.equal(category.budget_id, mine.id);
  });

  test("an envelope from another budget is refused", () => {
    const db = freshDb();
    const mine = ensurePersonalBudget(db, "m", "Ravi");
    const household = createGoal(db, actor, { name: "Roof", targetAmount: rupees(50_000) });
    const householdEnvelope = goalCategoryIds(db, household.id)[0]!;

    assert.throws(
      () => createGoal(db, actor, {
        name: "Mine", targetAmount: rupees(10_000),
        budgetId: mine.id, categoryIds: [householdEnvelope],
      }),
      /only be measured by envelopes in its own/,
    );
  });
});
