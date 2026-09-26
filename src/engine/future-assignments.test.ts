/**
 * BUDGET-1 · Money assigned to a future month was never subtracted from today.
 *
 * R2 says Ready to Assign is income less assignments in *every* month, and the
 * popover has a line for "Less assigned in future months". The loader read
 * assignments only up to the month being viewed, so that line was always ₹0:
 * ₹1,000 of income given to next month still read ₹1,000 ready this month, and
 * the same rupees could be assigned twice with "Every rupee has a job".
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned } from "../domain/budget.ts";
import { loadEngineInput } from "./repository.ts";
import { computeBudget } from "./engine.ts";
import { freshHousehold, identityProblems, RAVI } from "./identity.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };
const HH = "budget-household";

function stateOf(db: ReturnType<typeof freshHousehold>, month: string, budgetId?: string, useRollup = false) {
  return computeBudget(loadEngineInput(db, { through: month as never, budgetId, useRollup }))
    .get(month as never)!;
}

describe("BUDGET-1 · a future assignment reduces today's Ready to Assign", () => {
  function setup() {
    const db = freshHousehold();
    createAccount(db, actor, {
      name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-03-01", openingBalance: 100_000,
    });
    const g = createGroup(db, actor, "Bills");
    const rent = createCategory(db, actor, { groupId: g.id, name: "Rent" });
    const food = createCategory(db, actor, { groupId: g.id, name: "Food" });
    return { db, rent, food };
  }

  test("₹1,000 given to next month leaves ₹0 ready this month, and the popover says why", () => {
    const { db, rent } = setup();
    setAssigned(db, actor, "2025-04", rent.id, 100_000);
    for (const scope of [undefined, HH]) {
      for (const useRollup of [false, true]) {
        const s = stateOf(db, "2025-03", scope, useRollup);
        assert.equal(s.readyToAssign, 0);
        assert.equal(s.rtaBreakdown.assignedInFutureMonths, 100_000);
      }
    }
    assert.deepEqual(identityProblems(db, "2025-04"), []);
  });

  test("assigning the same rupees again this month goes negative in both months", () => {
    const { db, rent, food } = setup();
    setAssigned(db, actor, "2025-04", rent.id, 100_000);
    setAssigned(db, actor, "2025-03", food.id, 100_000);
    assert.equal(stateOf(db, "2025-03", HH).readyToAssign, -100_000);
    assert.equal(stateOf(db, "2025-04", HH).readyToAssign, -100_000);
    assert.deepEqual(identityProblems(db, "2025-04"), []);
  });
});
