/**
 * D8a · The target line says what was assigned, and "Over-funded" means money
 * is sitting there beyond the target.
 *
 * With ₹1,000 assigned against a ₹700 target the grid read "Over-funded ₹700
 * of ₹700": the figure was worked back from what was still missing, so it
 * could never exceed the target and the line contradicted its own label. And
 * an envelope that had overspent and been covered — ₹700 assigned, ₹900 spent,
 * ₹200 moved in — sat at ₹0 and read "Over-funded", because more had been
 * assigned than the target asked for. Nothing is spare in an envelope at zero.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../db/db.ts";
import { nowIST, todayIST } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { freshHousehold, RAVI } from "../engine/identity.test-data.ts";
import { startTestApp } from "./harness.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

function household() {
  const db = freshHousehold();
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: 5_000_000,
  }).id;
  const group = createGroup(db, actor, "Everyday").id;
  const id = createCategory(db, actor, { groupId: group, name: "Snacks" }).id;
  execute(
    db,
    `INSERT INTO targets (category_id,type,amount,target_date,created_at,updated_at)
     VALUES (?,'monthly',70000,NULL,?,?)`,
    id, nowIST(), nowIST(),
  );
  execute(db, `UPDATE household SET setup_completed_at = ? WHERE id = 1`, nowIST());
  return { db, id, bank, month: todayIST().slice(0, 7) };
}

function rowOf(page: string, name: string): string {
  const at = page.indexOf(`data-category-name="${name}"`);
  assert.ok(at >= 0, `no row for ${name}`);
  return page.slice(at, page.indexOf("category-balance", at));
}

describe("D8a · the target line and the over-funded label", () => {
  test("₹1,000 against a ₹700 target says ₹1,000 of ₹700", async () => {
    const { db, id, month } = household();
    setAssigned(db, actor, month, id, 100_000);
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const row = rowOf(await (await app.get("/")).text(), "Snacks");
      assert.match(row, /Over-funded/);
      assert.match(row, /₹1,000(\.00)? of ₹700/);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("an overspend covered back to ₹0 is not called over-funded", async () => {
    const { db, id, bank, month } = household();
    setAssigned(db, actor, month, id, 70_000);
    createTransaction(db, actor, { accountId: bank, amount: -90_000, date: todayIST(), categoryId: id, payeeName: "Shop" });
    // Covered: ₹200 more assigned, so the balance is back to nothing.
    setAssigned(db, actor, month, id, 90_000);
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const row = rowOf(await (await app.get("/")).text(), "Snacks");
      assert.doesNotMatch(row, /Over-funded/);
      assert.match(row, /<span class="chip">Funded<\/span>/);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
