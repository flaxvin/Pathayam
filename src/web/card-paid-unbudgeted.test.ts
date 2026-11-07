/**
 * UI-11 · A card paid with money nobody set aside for it.
 *
 * Paying a card's balance in full when its payment envelope held nothing takes
 * the envelope below zero — the accounting is right: the money went out with
 * no envelope behind it. But Cards said "Payment envelope overspent ₹25,100"
 * and the budget row "Settles this card's balance · Cover ₹25,100" on a card
 * that owes nothing, which reads as ₹25,100 still owed on it. Found in the
 * fresh-eyes browser pass (row 6). The figures stay; the words say what
 * happened.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember } from "./harness.test-data.ts";
import { buildBudgetView } from "./viewmodel.ts";
import { renderBudget } from "./pages/budget.ts";
import { renderCards, type CardDue } from "./pages/cards.ts";
import { createAccount, paymentCategoryFor } from "../domain/accounts.ts";
import { createTransfer } from "../domain/transactions.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, monthOf } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";

const RAVI = "m-ravi";
const ravi: Actor = { memberId: RAVI, source: "ui" };
const flat = (s: unknown) => String(s).replace(/\s+/g, " ");

test("the budget row says the card was paid with money not set aside for it", () => {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  const month = monthOf(todayIST());
  const bank = createAccount(db, ravi, {
    name: "Joint current", kind: "budget", subtype: "savings",
    openingDate: `${month}-01`, openingBalance: rupees(1_00_000),
  });
  const card = createAccount(db, ravi, {
    name: "Test card", kind: "credit", subtype: "credit-card",
    openingDate: `${month}-01`, openingBalance: -rupees(25_100) as Paise,
  });
  createTransfer(db, ravi, { fromAccountId: bank.id, toAccountId: card.id, amount: rupees(25_100), date: todayIST() });

  const view = buildBudgetView(db, month, undefined, RAVI);
  const envelope = paymentCategoryFor(db, card.id)!.id;
  assert.equal(view.categories.get(envelope)!.state.balance, -rupees(25_100), "the figure is unchanged");

  const page = flat(renderBudget(view));
  assert.match(page, /Paid ₹25,100 more than was set aside for this card — cover it from another envelope/);
  assert.doesNotMatch(page, /Settles this card's balance/, "it settles nothing: the card owes nothing");
});

const card = (over: Partial<CardDue>): CardDue => ({
  accountId: "a", name: "Test card", last4: "0000", owed: 0 as Paise, funded: -2_510_000 as Paise,
  unfunded: 0 as Paise, statement: null, daysToDue: null, paidSinceStatement: 2_510_000 as Paise,
  paymentCategoryId: "c-pay", credit: 0 as Paise, ...over,
} as CardDue);

test("Cards says the payment was not budgeted for, not that the envelope is overspent", () => {
  const page = flat(renderCards({ cards: [card({})], month: "2026-11" }));
  assert.doesNotMatch(page, /Payment envelope overspent/);
  assert.match(page, /Paid ₹25,100 more than was set aside for this card — cover it from another envelope/);
  assert.match(page, /href="\/move\?to=c-pay&(amp;)?amount=25100.00&(amp;)?month=2026-11"/, "with the way to cover it");
  assert.match(page, /The card itself owes nothing/);
});

test("on a card that still owes, the same words, without saying it owes nothing", () => {
  const page = flat(renderCards({
    cards: [card({ owed: 921_000 as Paise, funded: -678_000 as Paise, unfunded: 921_000 as Paise })],
    month: "2026-11",
  }));
  assert.match(page, /Paid ₹6,780 more than was set aside for this card/);
  assert.doesNotMatch(page, /owes nothing/);
});
