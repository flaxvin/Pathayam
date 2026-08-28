import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createTransaction } from "./transactions.ts";
import { spendingInsights } from "./insights.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup(): { db: DB; accountId: string; dining: string; rent: string; flight: string } {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  const acc = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(10_00_000),
  });
  const g = createGroup(db, actor, "Everyday");
  const dining = createCategory(db, actor, { groupId: g.id, name: "Dining" }).id;
  const rent = createCategory(db, actor, { groupId: g.id, name: "Rent" }).id;
  const flight = createCategory(db, actor, { groupId: g.id, name: "Flights" }).id;
  return { db, accountId: acc.id, dining, rent, flight };
}

function spend(db: DB, accountId: string, categoryId: string, amount: number, date: string) {
  createTransaction(db, actor, {
    accountId, amount: -rupees(amount), date, categoryId, payeeName: "x",
  });
}

describe("F10.5 · spending insights", () => {
  // "Today" is mid-August; the trailing three complete months are May, Jun, Jul.
  const today = "2026-08-15";

  test("a category well above its three-month average is flagged, with the numbers", () => {
    const { db, accountId, dining } = setup();
    spend(db, accountId, dining, 5000, "2026-05-10");
    spend(db, accountId, dining, 5000, "2026-06-10");
    spend(db, accountId, dining, 5000, "2026-07-10");
    spend(db, accountId, dining, 9000, "2026-08-10"); // 80% above the 5,000 mean

    const found = spendingInsights(db, today).find((i) => i.categoryName === "Dining");
    assert.ok(found, "Dining should surface");
    assert.equal(found!.kind, "up");
    assert.equal(found!.delta > 0.7 && found!.delta < 0.9, true, "≈80% above");
  });

  test("a steady category is not flagged", () => {
    const { db, accountId, rent } = setup();
    for (const m of ["05", "06", "07", "08"]) spend(db, accountId, rent, 41000, `2026-${m}-01`);
    assert.equal(spendingInsights(db, today).some((i) => i.categoryName === "Rent"), false);
  });

  test("brand-new spending is called out as new, not as a percentage", () => {
    const { db, accountId, flight } = setup();
    spend(db, accountId, flight, 30000, "2026-08-05"); // nothing in May–Jul
    const found = spendingInsights(db, today).find((i) => i.categoryName === "Flights");
    assert.ok(found);
    assert.equal(found!.kind, "new");
    assert.match(found!.text, /new this month/);
  });

  test("a tiny wobble under the absolute floor is ignored even at a big percentage", () => {
    const { db, accountId, dining } = setup();
    // ₹100 → ₹400 is +300% but only ₹300 of movement, under the ₹1,000 floor.
    spend(db, accountId, dining, 100, "2026-05-10");
    spend(db, accountId, dining, 100, "2026-06-10");
    spend(db, accountId, dining, 100, "2026-07-10");
    spend(db, accountId, dining, 400, "2026-08-10");
    assert.equal(spendingInsights(db, today).length, 0);
  });

  test("results are ranked by rupees moved, not by percentage", () => {
    const { db, accountId, dining, rent } = setup();
    // Dining: +₹4,000 (80%). Rent: +₹20,000 (~49%). Rent moved more money.
    for (const m of ["05", "06", "07"]) spend(db, accountId, dining, 5000, `2026-${m}-10`);
    spend(db, accountId, dining, 9000, "2026-08-10");
    for (const m of ["05", "06", "07"]) spend(db, accountId, rent, 41000, `2026-${m}-01`);
    spend(db, accountId, rent, 61000, "2026-08-01");
    const names = spendingInsights(db, today).map((i) => i.categoryName);
    assert.equal(names[0], "Rent", "the bigger rupee move ranks first");
  });
});
