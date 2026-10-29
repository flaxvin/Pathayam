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

/*
 * UI-2 · An overpaid card showed "₹0" in red: nothing owed, drawn as debt, and
 * the ₹2,710 the bank now owes back shown nowhere. Found paying the demo's
 * Swiggy HDFC card a little more than it owed.
 */
test("an overpaid card says what is in credit, not a red ₹0", () => {
  const overpaid = { ...card(0), owed: 0 as Paise, credit: 271_000 as Paise, unfunded: 0 as Paise };
  const page = String(renderCards({ cards: [overpaid], month: "2026-09" })).replace(/\s+/g, " ");
  assert.match(page, /<div class="amount amount-positive" style="font-size:1.15rem">₹2,710 in credit<\/div>/);
  assert.doesNotMatch(page, /amount-negative" style="font-size:1.15rem">₹0</);
});

test("a card that owes nothing and holds nothing is a plain ₹0", () => {
  const settled = { ...card(0), owed: 0 as Paise, credit: 0 as Paise, unfunded: 0 as Paise };
  const page = String(renderCards({ cards: [settled], month: "2026-09" })).replace(/\s+/g, " ");
  assert.match(page, /<div class="amount" style="font-size:1.15rem">₹0<\/div>/);
});
