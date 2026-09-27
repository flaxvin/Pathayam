/**
 * The Cards screen showed a payment envelope below zero as "Set aside -₹6,780",
 * which reads as money put by. Found in the round-2 browser pass on the demo's
 * Swiggy HDFC card.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCards, type CardDue } from "./pages/cards.ts";
import type { Paise } from "../core/money.ts";

const card = (funded: number): CardDue => ({
  accountId: "a", name: "Test card", last4: "0000", owed: 921_000 as Paise, funded: funded as Paise,
  unfunded: 921_000 as Paise, statement: null, daysToDue: 8, paidSinceStatement: 0 as Paise,
  paymentCategoryId: null,
});

test("a payment envelope below zero is called overspent, not set aside", () => {
  const page = String(renderCards({ cards: [card(-678_000)], month: "2026-09" })).replace(/\s+/g, " ");
  assert.doesNotMatch(page, /Set aside/);
  assert.match(page, /Owed across 1 card</);
  assert.match(page, /Payment envelope overspent ?<\/div> <span class="amount amount-negative">₹6,780<\/span>/);
});

test("one at or above zero is still what is set aside", () => {
  const page = String(renderCards({ cards: [card(462_000)], month: "2026-09" })).replace(/\s+/g, " ");
  assert.match(page, /Set aside ?<\/div> <span class="amount">₹4,620<\/span>/);
});
