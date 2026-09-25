/**
 * D4 · "Hold for next month" did nothing on any budget page.
 *
 * POST /hold answered 303 "Held ₹500 for next month." and wrote the row with
 * budget_id NULL, while the engine reads held money one budget at a time
 * (`budget_id = ?`): the household's Ready to Assign stayed ₹1,00,000 and only
 * the combined view saw the ₹500. The table was keyed by month alone, too, so
 * two budgets could never each hold money in the same month.
 *
 * The rebuild keyed by (month, budget) is a migration the lead adds; the SQL
 * below is exactly what the report hands over, applied here so both shapes of
 * the table are covered.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, queryOne, type DB } from "../db/db.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount } from "../domain/accounts.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { setHeld, getHeld, startPersonalBudget } from "../domain/budget.ts";
import { loadEngineInput } from "./repository.ts";
import { computeBudget } from "./engine.ts";
import { freshHousehold, identityProblems, RAVI } from "./identity.test-data.ts";
import { startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };
const HH = "budget-household";

const HELD_BY_BUDGET_MIGRATION = `
CREATE TABLE held_for_next_month_new (
  month      TEXT NOT NULL,
  budget_id  TEXT NOT NULL REFERENCES budgets(id),
  amount     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (month, budget_id)
);
INSERT INTO held_for_next_month_new (month, budget_id, amount, updated_at)
  SELECT month, COALESCE(budget_id, (SELECT id FROM budgets WHERE kind = 'household')),
         amount, updated_at
    FROM held_for_next_month;
DROP TABLE held_for_next_month;
ALTER TABLE held_for_next_month_new RENAME TO held_for_next_month;
`;

function setup(migrated: boolean) {
  const db = freshHousehold();
  if (migrated) db.exec(HELD_BY_BUDGET_MIGRATION);
  const ravi = ensurePersonalBudget(db, RAVI, "Ravi").id;
  startPersonalBudget(db, actor, ravi);
  createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: 10_000_000,
  });
  createAccount(db, actor, {
    name: "RBank", kind: "budget", subtype: "savings", openingDate: "2025-01-01",
    openingBalance: 5_000_000, budgetId: ravi, holderMemberId: RAVI,
  });
  return { db, ravi };
}

function held(db: DB, month: string, budgetId?: string) {
  const state = computeBudget(loadEngineInput(db, { through: month as never, budgetId, useRollup: false }))
    .get(month as never)!;
  return { held: state.heldForNextMonth, rta: state.readyToAssign };
}

for (const migrated of [false, true]) {
  describe(`D4 · held money is the budget's own (${migrated ? "after" : "before"} the rebuild)`, () => {
    test("the household's ₹500 leaves the household's Ready to Assign", () => {
      const { db } = setup(migrated);
      const before = held(db, "2025-02", HH).rta;
      setHeld(db, actor, "2025-02", 50_000);
      assert.deepEqual(held(db, "2025-02", HH), { held: 50_000, rta: before - 50_000 });
      assert.equal(getHeld(db, "2025-02"), 50_000);
      assert.deepEqual(identityProblems(db, "2027-03"), []);
    });

    test("a row the old code left without a budget reads as the household's", () => {
      const { db } = setup(false);
      execute(db, `INSERT INTO held_for_next_month (month, amount, updated_at) VALUES (?,?,?)`,
        "2025-02", 50_000, nowIST());
      if (migrated) db.exec(HELD_BY_BUDGET_MIGRATION);
      assert.equal(held(db, "2025-02", HH).held, 50_000);
      setHeld(db, actor, "2025-02", 20_000);
      assert.equal(held(db, "2025-02").held, 20_000, "replaced, not added to");
      assert.deepEqual(identityProblems(db, "2027-03"), []);
    });

    test("undo puts the budget's own amount back", () => {
      const { db, ravi } = setup(migrated);
      setHeld(db, actor, "2025-03", 30_000, ravi);
      const event = queryOne<{ id: string }>(
        db, `SELECT id FROM events WHERE entity = 'held' ORDER BY seq DESC LIMIT 1`,
      )!.id;
      undoEvent(db, event, actor);
      assert.equal(getHeld(db, "2025-03", ravi), 0);
      assert.deepEqual(identityProblems(db, "2027-03"), []);
    });
  });
}

describe("D4 · two budgets hold in the same month", () => {
  test("after the rebuild each keeps its own, and the combined view adds them", () => {
    const { db, ravi } = setup(true);
    setHeld(db, actor, "2025-02", 50_000);
    setHeld(db, actor, "2025-02", 12_345, ravi);
    assert.equal(held(db, "2025-02", HH).held, 50_000);
    assert.equal(held(db, "2025-02", ravi).held, 12_345);
    assert.equal(held(db, "2025-02").held, 62_345);
    assert.deepEqual(identityProblems(db, "2027-03"), []);
  });

  test("before it, the second is refused with a sentence rather than a key error", () => {
    const { db, ravi } = setup(false);
    setHeld(db, actor, "2025-02", 50_000);
    assert.throws(() => setHeld(db, actor, "2025-02", 12_345, ravi), Refusal);
    assert.equal(getHeld(db, "2025-02"), 50_000);
  });
});

describe("D4 · through the page", () => {
  test("POST /hold on Ravi's budget moves Ravi's Ready to Assign", async () => {
    const { db, ravi } = setup(true);
    execute(db, `UPDATE household SET setup_completed_at = ? WHERE id = 1`, nowIST());
    const month = nowIST().slice(0, 7);
    const before = held(db, month, ravi).rta;
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const form = await (await app.get(`/hold?month=${month}&budget=${ravi}`)).text();
      assert.ok(form.includes(`action="/hold?budget=${ravi}"`));
      const res = await app.post(`/hold?budget=${ravi}`, { month, amount: "500" });
      assert.equal(res.status, 303);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
    assert.deepEqual(held(db, month, ravi), { held: 50_000, rta: before - 50_000 });
    assert.equal(held(db, month, HH).held, 0);
  });
});
