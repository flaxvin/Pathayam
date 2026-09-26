/**
 * WEBUX-3 · One assignment in January 1900 must not move the present.
 *
 * The budget page's ‹ link walked back without end, `/assign` took any month,
 * and the engine's century cap was counted from the earliest row — so ₹1,000
 * assigned to Groceries in 1900-01 made the walk run 1900-01..1999-12 and every
 * real month fell off the end. Today's budget read Ready to Assign -₹1,000 and
 * every envelope "Not funded, spent ₹0", for everyone, until the row was undone.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { execute } from "../db/db.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { monthRange } from "../engine/repository.ts";
import { identityProblems, rtaOf } from "../engine/identity.test-data.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, monthOf, nowIST, type MonthKey } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";

const RAVI = "m-ravi";
const ravi: Actor = { memberId: RAVI, source: "ui" };

function household() {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  const account = createAccount(db, ravi, {
    name: "Joint savings", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(50_000),
  });
  const group = createGroup(db, ravi, "Everyday");
  const groceries = createCategory(db, ravi, { groupId: group.id, name: "Groceries" });
  const rent = createCategory(db, ravi, { groupId: group.id, name: "Rent" });
  const now = monthOf(todayIST());
  setAssigned(db, ravi, now, groceries.id, rupees(8_000) as Paise);
  createTransaction(db, ravi, {
    accountId: account.id, amount: -rupees(3_000), date: todayIST(), categoryId: groceries.id,
  });
  return { db, now, groceries, rent };
}

/** The row the old code let through, written as it would have been. */
function strayAssignment(db: ReturnType<typeof freshDb>, categoryId: string, month: MonthKey) {
  execute(
    db,
    `INSERT INTO assignments (month, category_id, amount, updated_at) VALUES (?,?,?,?)`,
    month, categoryId, rupees(1_000), nowIST(),
  );
}

describe("WEBUX-3 · a stray ancient assignment", () => {
  test("cannot push the present out of the engine's walk", () => {
    const { db, now, groceries } = household();
    const before = rtaOf(db, now);
    strayAssignment(db, groceries.id, "1900-01");

    const months = monthRange(db, now);
    assert.equal(months.at(-1), now, "the month being asked about fell off the end of the walk");
    assert.ok(months.length <= 1200);
    assert.equal(rtaOf(db, now), before, "today's Ready to Assign moved");
    assert.deepEqual(identityProblems(db, now), []);
    db.close();
  });

  test("is refused, and a stray one can still be set back to zero", () => {
    const { db, groceries } = household();
    assert.throws(
      () => setAssigned(db, ravi, "1900-01", groceries.id, rupees(1_000) as Paise),
      /too far back/,
    );
    strayAssignment(db, groceries.id, "1900-01");
    setAssigned(db, ravi, "1900-01", groceries.id, 0 as Paise);
    db.close();
  });

  test("the budget screen answers 422 and today's figures stand", async () => {
    const { db, now, groceries, rent } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const figure = async () =>
        (await (await app.get(`/?month=${now}`)).text()).match(/class="rta-figure">\s*<span aria-hidden="true">([^<]+)</)?.[1];
      const before = { rta: rtaOf(db, now), shown: await figure() };
      assert.ok(before.shown);
      const res = await app.post("/assign", { month: "1900-01", category_id: groceries.id, amount: "1000" });
      assert.equal(res.status, 422);
      const moved = await app.post("/move", {
        month: "1900-01", from_category_id: groceries.id, to_category_id: rent.id, amount: "1000",
      });
      assert.equal(moved.status, 422);
      assert.deepEqual({ rta: rtaOf(db, now), shown: await figure() }, before);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("‹ stops at the first month the budget has anything in", async () => {
    const { db } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const first = (await (await app.get("/?month=2025-01")).text());
      assert.doesNotMatch(first, /rel="prev"/, "‹ offered December 2024, before the budget began");
      const second = (await (await app.get("/?month=2025-02")).text());
      assert.match(second, /href="\?month=2025-01" rel="prev"/);
    } finally {
      await app.close();
    }
  });
});
