/**
 * The account edit form, posted with what a browser would never send.
 *
 * Two holes, both reached by a hand-made post. An empty `budget_id` was read
 * as "clear it" and wrote NULL onto a budget account — which then belonged to
 * no budget at all, so its whole balance left the household's Ready to Assign
 * with no transaction to show for it. And a statement or due day of 45, −3 or
 * 2.5 was stored as given, for the register's cycle labels and the cashflow
 * calendar to make what they could of.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import type { Actor } from "../core/events.ts";
import { rupees } from "../core/money.ts";
import { monthOf, todayIST } from "../core/dates.ts";
import { createAccount, getAccount } from "../domain/accounts.ts";
import { householdBudgetId } from "../domain/budgets.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget } from "../engine/engine.ts";

const RAVI = "m-ravi";
const ravi: Actor = { memberId: RAVI, source: "ui" };

describe("editing an account", () => {
  test("an empty budget leaves the account where it was, and its money with it", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    const account = createAccount(db, ravi, {
      name: "Joint savings", kind: "budget", subtype: "savings", openingBalance: rupees(1_000),
    });
    const month = monthOf(todayIST());
    const rta = () => computeBudget(
      loadEngineInput(db, { through: month, budgetId: householdBudgetId(db) }),
    ).get(month)!.readyToAssign;
    const before = rta();

    const app = await startTestApp(db, { memberId: RAVI });
    try {
      await app.post(`/accounts/${account.id}/edit`, { name: "Joint savings", budget_id: "" });
      assert.equal(getAccount(db, account.id)!.budget_id, householdBudgetId(db));
      assert.equal(rta(), before);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("a statement or due day outside the month is refused, and nothing is saved", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    const card = createAccount(db, ravi, {
      name: "Card", kind: "credit", subtype: "credit-card", statementDay: 5, dueDay: 25,
    });
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      for (const [statement_day, due_day] of [["45", "25"], ["5", "-3"], ["5", "2.5"], ["0", "25"]]) {
        const res = await app.post(`/accounts/${card.id}/edit`, { name: "Card", statement_day, due_day });
        assert.equal(res.status, 422, `${statement_day}/${due_day}`);
      }
      const after = getAccount(db, card.id)!;
      assert.equal(after.statement_day, 5);
      assert.equal(after.due_day, 25);

      const res = await app.post("/accounts/new", {
        name: "Other card", subtype: "credit:credit-card", statement_day: "99",
      });
      assert.equal(res.status, 422);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
