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
import { migrate } from "../db/db.ts";
import { MIGRATIONS } from "../db/schema.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };
const HH = "budget-household";

function setup() {
  const db = freshHousehold();
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

describe("D4 · held money is the budget's own", () => {
  test("the household's ₹500 leaves the household's Ready to Assign", () => {
    const { db } = setup();
    const before = held(db, "2025-02", HH).rta;
    setHeld(db, actor, "2025-02", 50_000);
    assert.deepEqual(held(db, "2025-02", HH), { held: 50_000, rta: before - 50_000 });
    assert.equal(getHeld(db, "2025-02"), 50_000);
    assert.deepEqual(identityProblems(db, "2027-03"), []);
  });

  test("undo puts the budget's own amount back", () => {
    const { db, ravi } = setup();
    setHeld(db, actor, "2025-03", 30_000, ravi);
    const event = queryOne<{ id: string }>(
      db, `SELECT id FROM events WHERE entity = 'held' ORDER BY seq DESC LIMIT 1`,
    )!.id;
    undoEvent(db, event, actor);
    assert.equal(getHeld(db, "2025-03", ravi), 0);
    assert.deepEqual(identityProblems(db, "2027-03"), []);
  });
});

describe("D4 · two budgets hold in the same month", () => {
  test("each keeps its own, and the combined view adds them", () => {
    const { db, ravi } = setup();
    setHeld(db, actor, "2025-02", 50_000);
    setHeld(db, actor, "2025-02", 12_345, ravi);
    assert.equal(held(db, "2025-02", HH).held, 50_000);
    assert.equal(held(db, "2025-02", ravi).held, 12_345);
    assert.equal(held(db, "2025-02").held, 62_345);
    assert.deepEqual(identityProblems(db, "2027-03"), []);
  });
});

describe("D4 · migration 0050 keeps what the old table held", () => {
  /*
   * The old table was keyed by month alone and the old code wrote rows with no
   * budget. Rebuild that shape, put a row in it, replay 0050 alone.
   */
  test("a row with no budget becomes the household's, and reads as held", () => {
    const { db } = setup();
    db.exec(`DROP TABLE held_for_next_month;
      CREATE TABLE held_for_next_month (
        month TEXT PRIMARY KEY, amount INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
        budget_id TEXT REFERENCES budgets(id));`);
    execute(db, `INSERT INTO held_for_next_month (month, amount, updated_at) VALUES (?,?,?)`,
      "2025-02", 50_000, nowIST());
    db.exec("PRAGMA user_version = 49");
    migrate(db, false, 50);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);

    assert.equal(held(db, "2025-02", HH).held, 50_000, "the household's held money was lost in the rebuild");
    setHeld(db, actor, "2025-02", 20_000);
    assert.equal(held(db, "2025-02").held, 20_000, "replaced, not added to");
    assert.deepEqual(identityProblems(db, "2027-03"), []);
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
      assert.ok(form.includes(`name="budget" value="${ravi}"`));
      const res = await app.post(`/hold`, { month, amount: "500", budget: ravi });
      assert.equal(res.status, 303);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
    assert.deepEqual(held(db, month, ravi), { held: 50_000, rta: before - 50_000 });
    assert.equal(held(db, month, HH).held, 0);
  });
});
