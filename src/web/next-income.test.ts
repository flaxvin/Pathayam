/**
 * N5 · A fully-assigned month is not an emergency.
 *
 * The demo opens on **Ready to Assign ₹0 — "every rupee has a job"**, which is
 * the app's own definition of success, and on the same screen eleven envelopes
 * say "Not funded" against their targets, because the money for them arrives on
 * the 26th. Both are true and together they read as a contradiction: everything
 * is assigned, and nothing is funded.
 *
 * The difference between an alarm and a schedule is a date, and the app already
 * knows the date. These hold that it says it — and that it only ever says it
 * about money the person looking could actually receive.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { buildBudgetView } from "./viewmodel.ts";
import { nextIncome } from "../domain/schedules.ts";
import { createSchedule } from "../domain/schedules.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory, setTarget } from "../domain/budget.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, monthOf, addDays } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi: Actor = { memberId: RAVI, source: "ui" };

/** A household with a target it cannot yet fund, and a salary on its way. */
function household(opts: { salaryIntoPrivate?: boolean } = {}) {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, PRIYA, "Priya");

  const joint = createAccount(db, ravi, {
    name: "Joint current", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(1_000),
  });
  const group = createGroup(db, ravi, "Everyday");
  const groceries = createCategory(db, ravi, { groupId: group.id, name: "Groceries" });
  setTarget(db, ravi, groceries.id, { type: "monthly", amount: rupees(20_000) as Paise });

  let into = joint.id;
  if (opts.salaryIntoPrivate) {
    const his = ensurePersonalBudget(db, RAVI, "Ravi");
    into = createAccount(db, ravi, {
      name: "Ravi's own", kind: "budget", subtype: "savings",
      openingDate: "2026-01-01", openingBalance: rupees(1_000),
      holderMemberId: RAVI, visibility: "private", budgetId: his.id,
    }).id;
  }

  const payday = addDays(todayIST(), 5);
  createSchedule(db, ravi, {
    name: "Salary — Ravi", accountId: into, amount: rupees(1_20_000) as Paise,
    recurrence: "monthly", nextDue: payday,
  });
  return { db, payday, groceries };
}

describe("N5 · the underfunded line says when the money arrives", () => {
  test("the view carries the next income", () => {
    const { db, payday } = household();
    const view = buildBudgetView(db, monthOf(todayIST()), undefined, RAVI);
    assert.ok(view.underfunded.categoryCount > 0, "nothing was underfunded to explain");
    assert.equal(view.nextIncome?.date, payday);
    assert.equal(view.nextIncome?.label, "Salary — Ravi");
  });

  test("and the budget screen says it in words", async () => {
    const { db } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const body = (await (await app.get("/")).text()).replace(/\s+/g, " ");
      assert.match(body, /underfunded across/);
      assert.match(body, /your next income, Salary — Ravi, is on the \d+(st|nd|rd|th)/);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("a payday nobody ticked off still rolls forward", () => {
    const { db, payday } = household();
    /*
     * `next_due` moves when somebody marks the occurrence, and a household that
     * never marks anything would otherwise be told nothing at all — the line
     * would go quiet exactly when the month is tightest.
     */
    const after = nextIncome(db, { today: addDays(payday, 1) });
    assert.ok(after, "the line went quiet the day after a payday nobody ticked off");
    assert.ok(after!.date > payday, "it announced a date that has already passed");
  });

  test("15 · and never somebody else's salary", () => {
    const { db } = household({ salaryIntoPrivate: true });
    assert.ok(nextIncome(db, { viewerMemberId: RAVI }), "Ravi cannot see his own");
    assert.equal(
      nextIncome(db, { viewerMemberId: PRIYA }), null,
      "Priya was told when Ravi's private account is paid, and how much",
    );
  });
});
