import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned, getAssigned, copyAssignmentsFromMonth, setTarget, clearTarget, getTarget } from "./budget.ts";
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
