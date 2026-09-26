/**
 * WEBUX-7 · One day is a day.
 *
 * A card due tomorrow read "Due in 1 days", and a statement a day late "1 days
 * overdue" — on the screen whose whole job is saying which card is due next.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderCards, type CardDue } from "./cards.ts";
import { rupees, type Paise } from "../../core/money.ts";

function card(daysToDue: number): CardDue {
  return {
    accountId: "a1", name: "Swiggy HDFC", last4: "4471",
    owed: rupees(5_000) as Paise, funded: rupees(5_000) as Paise, unfunded: 0 as Paise,
    statement: {
      amount: rupees(5_000) as Paise, date: "2026-09-20", due: "2026-10-05", minimum: null,
    },
    daysToDue,
    paidSinceStatement: 0 as Paise,
    paymentCategoryId: null,
  };
}

const say = (days: number) =>
  renderCards({ cards: [card(days)], month: "2026-10" }).toString().replace(/\s+/g, " ");

describe("WEBUX-7 · the cards screen counts days in words", () => {
  test("tomorrow, and one day late, are singular", () => {
    assert.match(say(1), /Due tomorrow/);
    assert.doesNotMatch(say(1), /1 days/);
    assert.match(say(-1), /1 day overdue/);
    assert.doesNotMatch(say(-1), /1 days/);
  });

  test("everything else is as it was", () => {
    assert.match(say(0), /Due today/);
    assert.match(say(2), /Due in 2 days/);
    assert.match(say(9), /Due in 9 days/);
    assert.match(say(-4), /4 days overdue/);
  });
});
