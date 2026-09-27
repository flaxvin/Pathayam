/**
 * BUDGET-17 · The starting template gives "Medical" a refill-to-₹20,000
 * target. With ₹20,000 already in it the grid said "Funded", but the Categories
 * page showed it as "Monthly target 20000.00", and pressing "Set target"
 * without changing anything wrote it back as monthly: the grid flipped to "Not
 * funded ₹0 of ₹20,000", ₹20,000 more demanded every month.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, queryOne } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned } from "../domain/budget.ts";
import { freshHousehold, RAVI } from "../engine/identity.test-data.ts";
import { startTestApp } from "./harness.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

function medical() {
  const db = freshHousehold();
  createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: 5_000_000,
  });
  const id = createCategory(db, actor, { groupId: createGroup(db, actor, "Irregular").id, name: "Medical" }).id;
  // As the starting template writes it.
  execute(
    db,
    `INSERT INTO targets (category_id,type,amount,target_date,created_at,updated_at)
     VALUES (?,'refill',2000000,NULL,?,?)`,
    id, nowIST(), nowIST(),
  );
  setAssigned(db, actor, "2025-01", id, 2_000_000);
  execute(db, `UPDATE household SET setup_completed_at = ? WHERE id = 1`, nowIST());
  return { db, id };
}

const stored = (db: ReturnType<typeof freshHousehold>, id: string) =>
  queryOne<{ type: string; amount: number }>(db, `SELECT type, amount FROM targets WHERE category_id = ?`, id);

describe("BUDGET-17 · a refill target stays a refill", () => {
  test("the Categories page says which kind it is", async () => {
    const { db, id } = medical();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const page = await (await app.get("/categories")).text();
      const select = page.match(new RegExp(`<select id="tgtk-${id}"[\\s\\S]*?</select>`))?.[0] ?? "";
      assert.match(select, /<option value="refill" selected>Refill up to<\/option>/);
      assert.doesNotMatch(select, /value="monthly" selected/);
    } finally {
      await app.close();
    }
  });

  test("saved unchanged — with the form's kind, or none at all — it is still a refill", async () => {
    const { db, id } = medical();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      assert.equal((await app.post(`/categories/${id}/target`, { amount: "20000.00", kind: "refill" })).status, 303);
      assert.deepEqual({ ...stored(db, id) }, { type: "refill", amount: 2_000_000 });
      assert.equal((await app.post(`/categories/${id}/target`, { amount: "20000.00" })).status, 303);
      assert.deepEqual({ ...stored(db, id) }, { type: "refill", amount: 2_000_000 });

      // And it can still be made a monthly one, or refused a kind that is not one.
      assert.equal((await app.post(`/categories/${id}/target`, { amount: "20000.00", kind: "monthly" })).status, 303);
      assert.equal(stored(db, id)?.type, "monthly");
      assert.equal((await app.post(`/categories/${id}/target`, { amount: "20000.00", kind: "weekly" })).status, 422);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
