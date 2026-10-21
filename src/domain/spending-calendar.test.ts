/**
 * S15 · The daily spending heatmap counts spending, not every rupee that moved.
 *
 * It summed every negative row: paying the card bill showed as a second
 * ₹20,000 of spending on the day it was paid (the charges had already counted
 * on their own days), and moving ₹1,00,000 from savings into a deposit lit up
 * the hottest square on the calendar.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { todayIST, addDays } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createTransaction, createTransfer } from "./transactions.ts";
import { householdBudgetId } from "./budgets.ts";
import { spendingCalendar } from "./reports.ts";
import { freshHousehold, PRIYA } from "../engine/identity.test-data.ts";

const priya: Actor = { memberId: PRIYA, source: "ui" };

test("a card charge counts once, on its own day; paying the card and saving do not count", () => {
  const db = freshHousehold();
  const today = todayIST();
  const household = householdBudgetId(db);
  const bank = createAccount(db, priya, {
    name: "Bank", kind: "budget", subtype: "savings", budgetId: household,
    openingBalance: rupees(5_00_000), openingDate: addDays(today, -30),
  });
  const card = createAccount(db, priya, {
    name: "Card", kind: "credit", subtype: "credit-card", budgetId: household,
    openingBalance: 0, openingDate: addDays(today, -30),
  });
  const deposit = createAccount(db, priya, {
    name: "FD", kind: "tracking", subtype: "fixed-deposit",
    openingBalance: 0, openingDate: addDays(today, -30),
  });
  const group = createGroup(db, priya, "Living", "normal", household);
  const food = createCategory(db, priya, { groupId: group.id, name: "Food" });

  createTransaction(db, priya, {
    accountId: card.id, amount: -rupees(20_000), date: addDays(today, -10), categoryId: food.id,
  });
  createTransfer(db, priya, { fromAccountId: bank.id, toAccountId: card.id, amount: rupees(20_000), date: addDays(today, -2) });
  createTransfer(db, priya, { fromAccountId: bank.id, toAccountId: deposit.id, amount: rupees(1_00_000), date: addDays(today, -1) });

  const days = spendingCalendar(db, addDays(today, -30), today);
  assert.deepEqual(days, [{ date: addDays(today, -10), value: rupees(20_000) }]);
  db.close();
});
