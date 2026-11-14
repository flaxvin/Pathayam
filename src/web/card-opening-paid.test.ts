/**
 * Decision 9 (UI-7) · Payments clear a card's opening balance first.
 *
 * Card added owing ₹18,450; ₹5,999 charged from an empty Eating out; ₹18,450
 * paid by transfer; ₹3,000 moved Rent → Eating out. The Cards and Budget
 * screens said "₹5,999 … isn't funded yet. ₹2,880 of it came with the card when
 * you added it" — but the opening balance was paid in full. startingDebt was
 * min(owed, opening) and never looked at payments. Now payments made since the
 * card was added come off the opening balance first, and once it is all paid
 * the sentence is gone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { buildBudgetView } from "./viewmodel.ts";
import { cameWithTheCard } from "../domain/card-shortfall.ts";
import { createAccount } from "../domain/accounts.ts";
import { setAssigned, createGroup, createCategory, moveMoney } from "../domain/budget.ts";
import { createTransaction, createTransfer } from "../domain/transactions.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, monthOf } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";

const RAVI = "m-ravi";
const ravi: Actor = { memberId: RAVI, source: "ui" };

function cardOwing(opening: number) {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  const bank = createAccount(db, ravi, {
    name: "Joint current", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(1_00_000),
  });
  const card = createAccount(db, ravi, {
    name: "Swiggy HDFC", kind: "credit", subtype: "credit-card",
    openingDate: "2026-01-01", openingBalance: -rupees(opening) as Paise,
    creditLimit: rupees(1_00_000), dueDay: 5, statementDay: 20,
  });
  return { db, bank, card };
}

test("UI-7 · opening balance paid in full: the shortfall is not blamed on it, on any screen", async () => {
  const { db, bank, card } = cardOwing(18_450);
  const month = monthOf(todayIST());
  const today = todayIST();
  const g = createGroup(db, ravi, "Flexible");
  const eating = createCategory(db, ravi, { groupId: g.id, name: "Eating out" }).id;
  const rent = createCategory(db, ravi, { groupId: g.id, name: "Rent" }).id;
  setAssigned(db, ravi, month, rent, rupees(3_000) as Paise);
  createTransaction(db, ravi, {
    accountId: card.id, amount: -rupees(5_999) as Paise, date: today, categoryId: eating,
  });
  createTransfer(db, ravi, {
    fromAccountId: bank.id, toAccountId: card.id, amount: rupees(18_450) as Paise, date: today,
  });
  moveMoney(db, ravi, { month, fromCategoryId: rent, toCategoryId: eating, amount: rupees(3_000) as Paise });

  const funding = buildBudgetView(db, month).cards.find((c) => c.accountId === card.id)!;
  assert.ok(funding.unfunded > 0, "there is still a shortfall to warn about");
  assert.equal(funding.startingDebt, 0, "the opening balance is all paid");
  assert.equal(cameWithTheCard(funding), null);

  const app = await startTestApp(db, { memberId: RAVI });
  try {
    for (const path of ["/", "/cards", `/accounts/${card.id}`]) {
      const body = (await (await app.get(path)).text()).replace(/\s+/g, " ");
      assert.match(body, /isn(?:'|&#39;|’)t funded yet|no envelope behind it|has nothing behind it/, `${path} still warns`);
      assert.doesNotMatch(body, /came with the card when you added it/, path);
    }
    assert.deepEqual(app.failures, []);
  } finally {
    await app.close();
  }
});

test("UI-7 · part paid: only what is left of the opening balance came with the card", () => {
  const { db, bank, card } = cardOwing(6_200);
  const month = monthOf(todayIST());
  createTransfer(db, ravi, {
    fromAccountId: bank.id, toAccountId: card.id, amount: rupees(2_000) as Paise, date: todayIST(),
  });
  // A later ₹1,000 charge, so the card owes ₹5,200: more than is left of the opening.
  const g = createGroup(db, ravi, "Flexible");
  const shop = createCategory(db, ravi, { groupId: g.id, name: "Shopping" }).id;
  setAssigned(db, ravi, month, shop, rupees(1_000) as Paise);
  createTransaction(db, ravi, {
    accountId: card.id, amount: -rupees(1_000) as Paise, date: todayIST(), categoryId: shop,
  });
  const funding = buildBudgetView(db, month).cards.find((c) => c.accountId === card.id)!;
  assert.equal(funding.outstanding, -rupees(5_200));
  assert.equal(funding.startingDebt, rupees(4_200), "₹6,200 less the ₹2,000 paid");
  assert.match(cameWithTheCard(funding)!, /came with the card/);
});

test("UI-7 · spending refunded to the card is not a payment, and does not clear the opening balance", () => {
  const { db, card } = cardOwing(6_200);
  const month = monthOf(todayIST());
  const g = createGroup(db, ravi, "Flexible");
  const shop = createCategory(db, ravi, { groupId: g.id, name: "Shopping" }).id;
  createTransaction(db, ravi, {
    accountId: card.id, amount: rupees(1_000) as Paise, date: todayIST(), categoryId: shop,
  });
  const funding = buildBudgetView(db, month).cards.find((c) => c.accountId === card.id)!;
  assert.equal(funding.startingDebt, rupees(5_200), "bounded by what is owed, not reduced by the refund");
});
