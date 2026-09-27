/**
 * BUDGET-13 · The engine walks at most MONTH_SPAN months from the first month
 * with data. With an account opened in 2000-01, /?month=2150-06 was headed
 * "June 2150" over December 2099's figures, and POST /assign ₹600 to Rent for
 * 2150-06 said "Assigned ₹600 to Rent." while the page still showed ₹1,000 to
 * assign and an empty Rent box — the row written, and never read.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, queryOne, type DB } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned, getAssigned } from "../domain/budget.ts";
import { monthInReach } from "../engine/repository.ts";
import { freshHousehold, RAVI } from "../engine/identity.test-data.ts";
import { startTestApp } from "./harness.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

function since2000(): { db: DB; rent: string } {
  const db = freshHousehold();
  createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2000-01-01", openingBalance: 100_000,
  });
  const rent = createCategory(db, actor, { groupId: createGroup(db, actor, "G").id, name: "Rent" }).id;
  execute(db, `UPDATE household SET setup_completed_at = ? WHERE id = 1`, nowIST());
  return { db, rent };
}

describe("BUDGET-13 · a month beyond the engine's reach is refused, not shown as another", () => {
  test("the reach is a hundred years from the first month with data", () => {
    const { db } = since2000();
    assert.equal(monthInReach(db, "2099-12"), true);
    assert.equal(monthInReach(db, "2100-01"), false);
    assert.equal(monthInReach(db, "1990-01"), true, "a month before the data starts is walked from itself");
  });

  test("assigning out of reach is refused and writes nothing; clearing is always allowed", () => {
    const { db, rent } = since2000();
    assert.throws(
      () => setAssigned(db, actor, "2150-06", rent, 60_000),
      (e: unknown) => e instanceof Refusal && /June 2150 is too far/.test((e as Error).message),
    );
    assert.equal(queryOne(db, `SELECT 1 FROM assignments WHERE month = '2150-06'`), null);

    // A row written before the refusal existed can still be cleared away.
    execute(
      db, `INSERT INTO assignments (month, category_id, amount, updated_at) VALUES ('2150-06', ?, 60000, ?)`,
      rent, nowIST(),
    );
    // Nor does it refuse every other assignment for being out of reach itself.
    setAssigned(db, actor, "2030-01", rent, 10_000);
    setAssigned(db, actor, "2150-06", rent, 0);
    assert.equal(getAssigned(db, "2150-06", rent), 0);
  });

  test("an assignment that would stretch the walk past a hundred years is refused too", () => {
    const { db, rent } = since2000();
    setAssigned(db, actor, "2099-12", rent, 10_000);
    assert.throws(() => setAssigned(db, actor, "1999-06", rent, 10_000), Refusal);
  });

  test("through the pages: the far month is a 422, and a month within reach still renders", async () => {
    const { db, rent } = since2000();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const page = await app.get("/?month=2150-06");
      assert.equal(page.status, 422);
      assert.match(await page.text(), /June 2150 is too far/);
      const assign = await app.post("/assign", { month: "2150-06", category_id: rent, amount: "600" });
      assert.equal(assign.status, 422);
      assert.equal(queryOne(db, `SELECT 1 FROM assignments WHERE month = '2150-06'`), null);
      assert.equal((await app.get("/?month=2099-12")).status, 200);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
