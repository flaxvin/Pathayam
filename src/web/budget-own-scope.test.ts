/**
 * Budget screens show one budget: the one being looked at.
 *
 * The rule from `15` is that a member never sees or affects another member's
 * private budget, and a household screen shows only the household's budget plus
 * the viewer's own. Each block below is a screen or action that read, or wrote,
 * every budget at once while the page around it showed one.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf } from "../core/dates.ts";
import { createAccount } from "../domain/accounts.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { createGroup, createCategory, startPersonalBudget } from "../domain/budget.ts";
import { freshHousehold, RAVI, PRIYA } from "../engine/identity.test-data.ts";
import { startTestApp } from "./harness.test-data.ts";

const ravi: Actor = { memberId: RAVI, source: "ui" };
const priya: Actor = { memberId: PRIYA, source: "ui" };
const HH = "budget-household";
const NOW = monthOf(todayIST());

/** ₹1,000 in the household; ₹77,777 in Priya's private account, in her own budget. */
function household(): { db: DB; priyaBudget: string } {
  const db = freshHousehold();
  createAccount(db, ravi, {
    name: "Joint", kind: "budget", subtype: "savings", openingDate: `${NOW}-01`, openingBalance: 100_000,
  });
  const priyaBudget = ensurePersonalBudget(db, PRIYA, "Priya").id;
  startPersonalBudget(db, priya, priyaBudget);
  createAccount(db, priya, {
    name: "Priya private", kind: "budget", subtype: "savings", openingDate: `${NOW}-01`,
    openingBalance: 7_777_700, budgetId: priyaBudget, holderMemberId: PRIYA, visibility: "private",
  });
  execute(db, `UPDATE household SET setup_completed_at = ? WHERE id = 1`, nowIST());
  return { db, priyaBudget };
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("BUDGET-2 · the explain popover and Move money use the budget on screen", () => {
  test("Ravi on the household budget is told ₹1,000, never Priya's ₹77,777", async () => {
    const { db } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const explain = text(await (await app.get(`/explain/ready-to-assign?month=${NOW}&budget=${HH}`)).text());
      assert.match(explain, /Ready to Assign ₹1,000 /);
      assert.doesNotMatch(explain, /77,777|78,777/);

      const move = text(await (await app.get(`/move?month=${NOW}&budget=${HH}`)).text());
      assert.match(move, /Ready to Assign — ₹1,000/);
      assert.doesNotMatch(move, /77,777|78,777/);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("an envelope explains itself in its own budget, and another member's is not found", async () => {
    const { db, priyaBudget } = household();
    const g = createGroup(db, ravi, "Shared", "normal", HH);
    const food = createCategory(db, ravi, { groupId: g.id, name: "Food" });
    const pg = createGroup(db, priya, "Hers", "normal", priyaBudget);
    const hers = createCategory(db, priya, { groupId: pg.id, name: "Private thing" });
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      assert.equal((await app.get(`/explain/category/${food.id}?month=${NOW}`)).status, 200);
      assert.equal((await app.get(`/explain/category/${hers.id}?month=${NOW}`)).status, 404);
    } finally {
      await app.close();
    }
  });

  test("the budget page's links name the budget they are about", async () => {
    const { db } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const page = await (await app.get(`/?month=${NOW}&budget=${HH}`)).text();
      assert.match(page, new RegExp(`/explain/ready-to-assign\\?month=${NOW}&budget=${HH}`));
      assert.match(page, new RegExp(`/move\\?month=${NOW}&budget=${HH}`));
    } finally {
      await app.close();
    }
  });
});
