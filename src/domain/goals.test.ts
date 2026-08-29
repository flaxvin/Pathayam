import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { historyFor, undoEvent } from "../core/events.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createGoal, updateGoal, deleteGoal, getGoal, listGoals } from "./goals.ts";

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
