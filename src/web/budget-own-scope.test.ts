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
import { nowIST, todayIST, monthOf, addMonths } from "../core/dates.ts";
import { createAccount, listAccounts } from "../domain/accounts.ts";
import { createTransaction } from "../domain/transactions.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import {
  createGroup, createCategory, startPersonalBudget, setAssigned, getAssigned, setTarget,
} from "../domain/budget.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget } from "../engine/engine.ts";
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

const rta = (db: DB, budgetId: string, month = NOW) =>
  computeBudget(loadEngineInput(db, { through: month, budgetId, useRollup: false })).get(month)!.readyToAssign;

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

describe("BUDGET-3 · Fill from last month fills the budget on screen", () => {
  test("Ravi's click on the household page leaves Priya's private envelope alone", async () => {
    const { db, priyaBudget } = household();
    const prev = addMonths(NOW, -1);
    const pg = createGroup(db, priya, "Mine", "normal", priyaBudget);
    const therapy = createCategory(db, priya, { groupId: pg.id, name: "Therapy" });
    setAssigned(db, priya, prev, therapy.id, 300_000);
    const g = createGroup(db, ravi, "Bills", "normal", HH);
    const rent = createCategory(db, ravi, { groupId: g.id, name: "Rent" });
    setAssigned(db, ravi, prev, rent.id, 50_000);
    setTarget(db, ravi, rent.id, { type: "monthly", amount: 60_000 });
    const before = rta(db, priyaBudget);

    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const page = await (await app.get(`/?month=${NOW}&budget=${HH}`)).text();
      assert.match(page, new RegExp(`name="budget" value="${HH}"`));
      const r = await app.post("/copy-last-month", { month: NOW, budget: HH });
      assert.equal(r.status, 303);
      assert.match(decodeURIComponent(r.headers.get("location") ?? ""), /Filled 1 category with ₹500/);
    } finally {
      await app.close();
    }
    assert.equal(getAssigned(db, NOW, rent.id), 50_000);
    assert.equal(getAssigned(db, NOW, therapy.id), 0);
    assert.equal(rta(db, priyaBudget), before);
  });
});

/**
 * Priya pays ₹200 of the household's groceries from her private account with
 * nothing committed, so her commitment is underfunded and her budget is the one
 * that would give it up.
 */
function priyaShort() {
  const { db, priyaBudget } = household();
  const pg = createGroup(db, priya, "Mine", "normal", priyaBudget);
  const secret = createCategory(db, priya, { groupId: pg.id, name: "Divorce lawyer fund" });
  const hg = createGroup(db, ravi, "Home", "normal", HH);
  const groceries = createCategory(db, ravi, { groupId: hg.id, name: "Groceries" });
  setAssigned(db, ravi, NOW, groceries.id, 50_000);
  const hers = listAccounts(db).find((a) => a.name === "Priya private")!;
  createTransaction(db, priya, {
    accountId: hers.id, amount: -20_000, date: `${NOW}-01`, categoryId: groceries.id,
  });
  return { db, priyaBudget, secret };
}

describe("BUDGET-10 · the household page never lists another member's envelopes", () => {
  test("Ravi's Spent-from picker has none of Priya's; Priya's has hers", async () => {
    const { db } = priyaShort();
    for (const [who, sees] of [[RAVI, false], [PRIYA, true]] as const) {
      const app = await startTestApp(db, { memberId: who });
      try {
        const page = await (await app.get(`/household?month=${NOW}`)).text();
        assert.equal(page.includes("Divorce lawyer fund"), sees, who);
      } finally {
        await app.close();
      }
    }
  });
});
