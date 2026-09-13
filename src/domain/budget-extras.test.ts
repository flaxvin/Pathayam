import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryAll, type DB } from "../db/db.ts";
import { undoEvent, historyFor, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import {
  createGroup, createCategory, setAssigned, getAssigned, copyAssignmentsFromMonth,
  setTarget, clearTarget, getTarget, reorderCategory, reorderGroup, getCategory,
  renameGroup, deleteGroup, listGroups,
} from "./budget.ts";
import { createTransaction } from "./transactions.ts";
import { spendByTag } from "./reports.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`, "m", "f@e.com", "F", nowIST());
  const bank = createAccount(db, actor, { name: "HDFC", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: rupees(500000) });
  const g = createGroup(db, actor, "Flexible");
  const rent = createCategory(db, actor, { groupId: g.id, name: "Rent" }).id;
  const food = createCategory(db, actor, { groupId: g.id, name: "Food" }).id;
  return { db, bank: bank.id, rent, food };
}

describe("F3.9 · fill from last month", () => {
  test("empty categories take last month's amount; existing work is left alone", () => {
    const { db, rent, food } = setup();
    setAssigned(db, actor, "2026-07", rent, rupees(41000));
    setAssigned(db, actor, "2026-07", food, rupees(15000));
    // This month, Food is already assigned; Rent is empty.
    setAssigned(db, actor, "2026-08", food, rupees(20000));

    const { filled, total } = copyAssignmentsFromMonth(db, actor, "2026-08", "2026-07");
    assert.equal(filled, 1, "only Rent was empty");
    assert.equal(total, rupees(41000));
    assert.equal(getAssigned(db, "2026-08", rent), rupees(41000), "Rent filled from July");
    assert.equal(getAssigned(db, "2026-08", food), rupees(20000), "Food left as this month's value");
  });

  test("nothing to fill when last month was empty", () => {
    const { db } = setup();
    const { filled } = copyAssignmentsFromMonth(db, actor, "2026-08", "2026-07");
    assert.equal(filled, 0);
  });
});

describe("F3.4 · category targets are editable", () => {
  test("a monthly target can be set, changed and cleared", () => {
    const { db, rent } = setup();
    setTarget(db, actor, rent, { type: "monthly", amount: rupees(41000) });
    assert.deepEqual(
      { type: getTarget(db, rent)!.type, amount: getTarget(db, rent)!.amount },
      { type: "monthly", amount: rupees(41000) },
    );
    // change it
    setTarget(db, actor, rent, { type: "monthly", amount: rupees(45000) });
    assert.equal(getTarget(db, rent)!.amount, rupees(45000));
    // clear it
    clearTarget(db, actor, rent);
    assert.equal(getTarget(db, rent), null);
  });

  test("a by-date target needs a date", () => {
    const { db, rent } = setup();
    assert.throws(() => setTarget(db, actor, rent, { type: "by-date", amount: rupees(60000) }), /needs a date/);
    setTarget(db, actor, rent, { type: "by-date", amount: rupees(60000), targetDate: "2027-01-01" });
    assert.equal(getTarget(db, rent)!.target_date, "2027-01-01");
  });
});

describe("F12 · spend by tag", () => {
  test("sums tagged spending and reports the budget where one is set", () => {
    const { db, bank, food } = setup();
    // createTransaction creates the tag by name; set its budget afterwards.
    createTransaction(db, actor, { accountId: bank, amount: -rupees(12000), date: "2026-08-05", categoryId: food, payeeName: "x", tags: ["kerala-oct"] });
    createTransaction(db, actor, { accountId: bank, amount: -rupees(8000), date: "2026-08-10", categoryId: food, payeeName: "y", tags: ["kerala-oct"] });
    execute(db, `UPDATE tags SET budget_amount = ? WHERE name = ?`, rupees(30000), "kerala-oct");

    const rows = spendByTag(db, "2026-08-01", "2026-08-31");
    const kerala = rows.find((r) => r.tag === "kerala-oct");
    assert.ok(kerala);
    assert.equal(kerala!.spent, rupees(20000));
    assert.equal(kerala!.budget, rupees(30000));
    db.close();
  });
});

describe("F3.6 · reordering categories and groups", () => {
  test("a category moves down and back up within its group", () => {
    const { db, rent, food } = setup();
    const order = () =>
      queryAll<{ id: string }>(db, `SELECT id FROM categories ORDER BY sort, name`).map((r) => r.id);
    // createCategory assigns sort in creation order: Rent then Food.
    assert.deepEqual(order(), [rent, food], "starts in creation order, not alphabetical");

    reorderCategory(db, actor, rent, "down");
    assert.deepEqual(order(), [food, rent]);

    reorderCategory(db, actor, rent, "up");
    assert.deepEqual(order(), [rent, food], "a repeated nudge keeps working");
    db.close();
  });

  test("nudging past an edge is a no-op, not an error", () => {
    const { db, rent, food } = setup();
    reorderCategory(db, actor, rent, "up");
    reorderCategory(db, actor, food, "down");
    assert.deepEqual(
      queryAll<{ id: string }>(db, `SELECT id FROM categories ORDER BY sort, name`).map((r) => r.id),
      [rent, food],
    );
    db.close();
  });

  test("a category only moves among its own group's siblings", () => {
    const { db, rent } = setup();
    const other = createGroup(db, actor, "Fixed");
    const bills = createCategory(db, actor, { groupId: other.id, name: "Bills" }).id;
    reorderCategory(db, actor, bills, "up"); // alone in its group
    const inOther = queryAll<{ id: string }>(
      db, `SELECT id FROM categories WHERE group_id = ?`, other.id,
    ).map((r) => r.id);
    assert.deepEqual(inOther, [bills]);
    assert.equal(getCategory(db, rent)!.group_id !== other.id, true, "Rent did not move groups");
    db.close();
  });

  test("groups reorder and the move can be undone", () => {
    const { db } = setup();
    const second = createGroup(db, actor, "Fixed");
    const order = () =>
      queryAll<{ id: string }>(db, `SELECT id FROM category_groups ORDER BY sort, name`).map((r) => r.id);
    const before = order();
    assert.equal(before[before.length - 1], second.id, "newest group lands last");

    reorderGroup(db, actor, second.id, "up");
    assert.notDeepEqual(order(), before, "the group moved");

    const ev = queryAll<{ id: string }>(
      db, `SELECT id FROM events WHERE entity = 'group-order' ORDER BY seq DESC LIMIT 1`,
    )[0]!;
    const res = undoEvent(db, ev.id, actor);
    assert.equal(res.ok, true, res.ok ? "" : res.reason);
    assert.deepEqual(order(), before, "undo restored the original order");
    db.close();
  });

  test("a category reorder can be undone", () => {
    const { db, rent, food } = setup();
    reorderCategory(db, actor, rent, "down");
    const ev = queryAll<{ id: string }>(
      db, `SELECT id FROM events WHERE entity = 'category-order' ORDER BY seq DESC LIMIT 1`,
    )[0]!;
    assert.equal(undoEvent(db, ev.id, actor).ok, true);
    assert.deepEqual(
      queryAll<{ id: string }>(db, `SELECT id FROM categories ORDER BY sort, name`).map((r) => r.id),
      [rent, food],
    );
    db.close();
  });
});

describe("B61 · the app-managed goal group does not collide with the template's", () => {
  test("a group can be renamed, and the rename is undoable", () => {
    const { db } = setup();
    const g = createGroup(db, actor, "Savings goals", "internal");
    renameGroup(db, actor, g.id, "Goals");
    const name = () =>
      queryAll<{ name: string }>(db, `SELECT name FROM category_groups WHERE id = ?`, g.id)[0]!.name;
    assert.equal(name(), "Goals");

    const ev = queryAll<{ id: string }>(
      db, `SELECT id FROM events WHERE entity='category-group' AND action='rename' ORDER BY seq DESC LIMIT 1`,
    )[0]!;
    assert.equal(undoEvent(db, ev.id, actor).ok, true);
    assert.equal(name(), "Savings goals", "undo put the old name back");
    db.close();
  });

  test("the starting template's savings group and the managed one are told apart by kind", () => {
    const { db } = setup();
    // What a real household has: the template's ordinary group…
    const fromTemplate = createGroup(db, actor, "Savings goals", "normal");
    // …and the legacy managed group, before the rename.
    const managed = createGroup(db, actor, "Savings goals", "internal");

    const pick = (kind: string) =>
      queryAll<{ id: string; name: string; kind: string }>(
        db, `SELECT id, name, kind FROM category_groups WHERE name = 'Savings goals'`,
      ).filter((g) => g.kind === kind);

    assert.equal(pick("normal").length, 1);
    assert.equal(pick("internal").length, 1);

    // The fix renames only the managed one, so the two stop sharing a heading.
    renameGroup(db, actor, managed.id, "Goals");
    assert.equal(pick("internal").length, 0, "no managed group answers to the old name");
    assert.equal(pick("normal")[0]!.id, fromTemplate.id, "the template's group is untouched");
    db.close();
  });
});

/** These want the database alone; the others want the fixtures too. */
function freshDb() {
  return setup().db;
}

describe("Groups can be renamed, and deleted when empty", () => {
  /**
   * A group could be created and reordered and never renamed or removed, so a
   * typo was permanent and an empty leftover sat on the grid for good.
   * `renameGroup` had been in the domain the whole time with nothing calling it.
   */
  test("an empty group deletes, and the deletion undoes", () => {
    const db = freshDb();
    const group = createGroup(db, actor, "Temporary");
    deleteGroup(db, actor, group.id);
    assert.equal(listGroups(db).some((g) => g.id === group.id), false);

    const event = historyFor(db, "category-group", group.id).at(-1)!;
    undoEvent(db, event.id, actor);
    const back = listGroups(db).find((g) => g.id === group.id);
    assert.equal(back?.name, "Temporary", "put back, not merely un-deleted");
  });

  test("a group holding envelopes refuses, and says which", () => {
    const db = freshDb();
    const group = createGroup(db, actor, "Spending");
    createCategory(db, actor, { groupId: group.id, name: "Groceries" });

    assert.throws(() => deleteGroup(db, actor, group.id), /Groceries/);
    assert.throws(() => deleteGroup(db, actor, group.id), /Move or delete/);
    assert.equal(listGroups(db).some((g) => g.id === group.id), true);
  });

  test("an app-managed group is not the household's to delete", () => {
    const db = freshDb();
    const managed = createGroup(db, actor, "Credit Card Payments", "credit-payments");
    assert.throws(() => deleteGroup(db, actor, managed.id), /kept by the app/);
  });

  test("renaming works and undoes", () => {
    const db = freshDb();
    const group = createGroup(db, actor, "Everyay");
    renameGroup(db, actor, group.id, "Everyday");
    assert.equal(listGroups(db).find((g) => g.id === group.id)?.name, "Everyday");

    const event = historyFor(db, "category-group", group.id).at(-1)!;
    undoEvent(db, event.id, actor);
    assert.equal(listGroups(db).find((g) => g.id === group.id)?.name, "Everyay");
  });
});
