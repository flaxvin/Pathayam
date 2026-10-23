/**
 * The digest sits on one budget's page, so every figure in it is that budget's.
 *
 * Two of its items still read the household as a whole: "September is over,
 * close it" asked whether the *household's* September was closed whatever
 * budget was on screen, and "₹X is unassigned — about N months of typical
 * spending" divided one budget's Ready to Assign by every budget's spending.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { todayIST, monthOf, addMonths, addDays, firstDayOfMonth } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, startPersonalBudget, listCategories } from "./budget.ts";
import { createTransaction } from "./transactions.ts";
import { householdBudgetId, ensurePersonalBudget } from "./budgets.ts";
import { closeMonth } from "./month-close.ts";
import { digestFor } from "./digest.ts";
import { freshHousehold, PRIYA } from "../engine/identity.test-data.ts";

const priya: Actor = { memberId: PRIYA, source: "ui" };
const TODAY = todayIST();
const LAST = addMonths(monthOf(TODAY), -1);

function world() {
  const db = freshHousehold();
  const household = householdBudgetId(db);
  const hers = ensurePersonalBudget(db, PRIYA, "Priya").id;
  startPersonalBudget(db, priya, hers);
  const shared = createGroup(db, priya, "Shared", "normal", household);
  const groceries = createCategory(db, priya, { groupId: shared.id, name: "Groceries" });
  const joint = createAccount(db, priya, {
    name: "Joint", kind: "budget", subtype: "savings", budgetId: household,
    openingBalance: rupees(10_00_000), openingDate: addDays(TODAY, -120),
  });
  const own = createAccount(db, priya, {
    name: "Hers", kind: "budget", subtype: "savings", budgetId: hers,
    holderMemberId: PRIYA, visibility: "private",
    openingBalance: rupees(1_00_000), openingDate: addDays(TODAY, -120),
  });
  const personal = listCategories(db, { budgetId: hers }).find((c) => c.name === "Personal")!;
  return { db, household, hers, groceries, joint, own, personal };
}

describe("the digest's month-close nudge is the budget on screen", () => {
  test("Priya closed her own last month: her page stops asking, whatever the household did", () => {
    const w = world();
    createTransaction(w.db, priya, {
      accountId: w.own.id, amount: -rupees(500), date: firstDayOfMonth(LAST), categoryId: w.personal.id,
    });
    closeMonth(w.db, priya, LAST, null, w.hers);
    const hers = digestFor(w.db, PRIYA, TODAY, PRIYA, w.hers);
    assert.equal(hers.some((i) => i.kind === "month-close"), false, JSON.stringify(hers));
    w.db.close();
  });

  test("the household closed last month: Priya's own, still open, is still asked about", () => {
    const w = world();
    createTransaction(w.db, priya, {
      accountId: w.own.id, amount: -rupees(500), date: firstDayOfMonth(LAST), categoryId: w.personal.id,
    });
    closeMonth(w.db, priya, LAST, null, w.household);
    const hers = digestFor(w.db, PRIYA, TODAY, PRIYA, w.hers);
    assert.equal(hers.some((i) => i.kind === "month-close"), true, JSON.stringify(hers));
    w.db.close();
  });
});

describe("the digest's hold suggestion measures the budget on screen", () => {
  test("Priya's ₹1,00,000 against her own ₹100 a day, not the household's ₹10,000 a day", () => {
    const w = world();
    for (let d = 1; d <= 80; d += 1) {
      createTransaction(w.db, priya, {
        accountId: w.joint.id, amount: -rupees(10_000), date: addDays(TODAY, -d), categoryId: w.groceries.id,
      });
      createTransaction(w.db, priya, {
        accountId: w.own.id, amount: -rupees(100), date: addDays(TODAY, -d), categoryId: w.personal.id,
      });
    }
    const hers = digestFor(w.db, PRIYA, TODAY, PRIYA, w.hers);
    const hold = hers.find((i) => i.kind === "hold-surplus");
    assert.ok(hold, `her ₹92,000 unassigned is many months of her spending: ${JSON.stringify(hers)}`);
    // About ₹2,700 a month: 80 × ₹100 over the 90-day window, times 30.
    assert.match(hold.text, /Hold ₹2,700 for next month/);
    w.db.close();
  });
});
