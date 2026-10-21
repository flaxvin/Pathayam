/**
 * "Due within a week" on the Cards screen counted every card whose due date was
 * seven days off or less — including one whose statement had been paid eleven
 * days ago. The demo showed "Due within a week: 1" above Axis Atlas marked
 * "Paid" and two cards due in 12 and 15 days. Found driving /cards as Ravi.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCards, type CardDue } from "./pages/cards.ts";
import type { Paise } from "../core/money.ts";

const card = (daysToDue: number, paid: number): CardDue => ({
  accountId: "a" + daysToDue, name: "Card", last4: "0000", owed: 100_000 as Paise, funded: 0 as Paise,
  unfunded: 100_000 as Paise,
  statement: { amount: 150_000 as Paise, date: "2026-09-22", due: "2026-10-10", minimum: null },
  daysToDue, paidSinceStatement: paid as Paise, paymentCategoryId: null,
});

const dueSoon = (cards: CardDue[]): string =>
  /Due within a week ?<\/div> <strong[^>]*>(\d+)<\/strong>/.exec(
    String(renderCards({ cards, month: "2026-10" })).replace(/\s+/g, " "),
  )?.[1] ?? "missing";

test("a paid statement is not due within a week, however recently it fell due", () => {
  assert.equal(dueSoon([card(-11, 150_000), card(12, 0), card(15, 0)]), "0");
});

test("an unpaid one due in a few days, or overdue, still counts", () => {
  assert.equal(dueSoon([card(3, 0), card(-2, 0), card(12, 0)]), "2");
});
