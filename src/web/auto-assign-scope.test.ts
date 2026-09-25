/**
 * D14 · Auto-assign pooled every budget's Ready to Assign.
 *
 * Household: Bank ₹1,000, all of it assigned to Groceries (RTA ₹0), Groceries'
 * monthly target ₹1,500. Priya's budget: ₹50,000 and her own "Priya private"
 * envelope with a ₹700 target. Ravi pressed Auto-assign on the household page:
 * the plan was built from the combined view of every budget, so it saw a pool
 * of ₹50,000 and assigned ₹1,200 across two envelopes — the household went to
 * −₹500 (₹1,500 assigned against ₹1,000), and ₹700 of Priya's money went into
 * her private envelope on Ravi's click.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, queryOne } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf } from "../core/dates.ts";
import { createAccount } from "../domain/accounts.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import {
  createGroup, createCategory, setAssigned, setTarget, startPersonalBudget,
} from "../domain/budget.ts";
import { rtaOf, freshHousehold, identityProblems, RAVI, PRIYA } from "../engine/identity.test-data.ts";
import { startTestApp } from "./harness.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };
const HH = "budget-household";

function setup() {
  const db = freshHousehold();
  execute(db, `UPDATE household SET setup_completed_at = ? WHERE id = 1`, nowIST());
  const month = monthOf(todayIST());
  createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: `${month}-01`, openingBalance: 100_000,
  });
  const groceries = createCategory(db, actor, {
    groupId: createGroup(db, actor, "Everyday").id, name: "Groceries",
  }).id;
  setAssigned(db, actor, month, groceries, 100_000);
  setTarget(db, actor, groceries, { type: "monthly", amount: 150_000 });

  const priya = ensurePersonalBudget(db, PRIYA, "Priya").id;
  startPersonalBudget(db, actor, priya);
  createAccount(db, actor, {
    name: "QBank", kind: "budget", subtype: "savings", openingDate: `${month}-01`,
    openingBalance: 5_000_000, budgetId: priya, holderMemberId: PRIYA,
  });
  const priyaPrivate = createCategory(db, actor, {
    groupId: createGroup(db, actor, "Hers", "normal", priya).id, name: "Priya private",
  }).id;
  setTarget(db, actor, priyaPrivate, { type: "monthly", amount: 70_000 });
  return { db, month, groceries, priya, priyaPrivate };
}

describe("D14 · auto-assign spends only the budget being viewed", () => {
  test("Ravi on the household page: nothing to assign, nobody else's money moves", async () => {
    const s = setup();
    const priyaBefore = rtaOf(s.db, s.month, s.priya);
    const app = await startTestApp(s.db, { memberId: RAVI });
    try {
      const preview = await (await app.get(`/auto-assign?month=${s.month}&budget=${HH}`)).text();
      assert.ok(preview.includes("Nothing to assign"), "the household has no Ready to Assign");
      const res = await app.post(`/auto-assign?month=${s.month}&budget=${HH}`, { month: s.month });
      assert.equal(res.status, 303);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
    assert.equal(rtaOf(s.db, s.month, HH), 0, "the household does not go negative");
    assert.equal(rtaOf(s.db, s.month, s.priya), priyaBefore, "Priya's money is untouched");
    assert.equal(
      queryOne(s.db, `SELECT 1 FROM assignments WHERE category_id = ?`, s.priyaPrivate), null,
    );
    assert.deepEqual(identityProblems(s.db, "2027-12"), []);
  });

  test("Priya on her own page funds her own envelope from her own money", async () => {
    const s = setup();
    const app = await startTestApp(s.db, { memberId: PRIYA });
    try {
      const preview = await (await app.get(`/auto-assign?month=${s.month}&budget=${s.priya}`)).text();
      assert.ok(preview.includes(`action="/auto-assign?budget=${s.priya}"`));
      await app.post(`/auto-assign?month=${s.month}&budget=${s.priya}`, { month: s.month });
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
    assert.equal(rtaOf(s.db, s.month, s.priya), 5_000_000 - 70_000);
    assert.equal(rtaOf(s.db, s.month, HH), 0);
    assert.deepEqual(identityProblems(s.db, "2027-12"), []);
  });
});
