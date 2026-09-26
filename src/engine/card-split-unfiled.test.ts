/**
 * MONEY-CORE-1 · A split card transaction with a blank line.
 *
 * The blank (no-envelope) line of a split on a card was counted by neither the
 * "unfiled" read (whole rows with no category only) nor the categorised one
 * (which drops a line with no category), so the card's debt moved by the whole
 * amount and its envelopes by the filed part only. A ₹100 refund with ₹60 back
 * to Food and ₹40 left blank — which the Add form allows on money in — put the
 * identity out by ₹40 in every month after, live and through the rollup.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { createAccount, paymentCategoryFor } from "../domain/accounts.ts";
import { createTransaction } from "../domain/transactions.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { startPersonalBudget, createGroup, createCategory } from "../domain/budget.ts";
import { loadEngineInput } from "./repository.ts";
import { computeBudget } from "./engine.ts";
import { freshHousehold, identityProblems, RAVI, PRIYA } from "./identity.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

function household() {
  const db = freshHousehold();
  const priya = ensurePersonalBudget(db, PRIYA, "Priya").id;
  startPersonalBudget(db, actor, priya);
  const card = createAccount(db, actor, {
    name: "Card", kind: "credit", subtype: "credit-card", openingDate: "2025-01-01", openingBalance: 0,
  }).id;
  const food = createCategory(db, actor, {
    groupId: createGroup(db, actor, "Everyday", "normal", "budget-household").id, name: "Food",
  }).id;
  const fun = createCategory(db, actor, {
    groupId: createGroup(db, actor, "Mine", "normal", priya).id, name: "Fun",
  }).id;
  return { db, card, food, fun };
}

describe("MONEY-CORE-1 · a blank line in a split on a card", () => {
  test("a refund split between an envelope and nothing keeps the identity", () => {
    const { db, card, food } = household();
    createTransaction(db, actor, {
      accountId: card, amount: 10_000, date: "2025-03-05",
      splits: [{ categoryId: null, amount: 4_000 }, { categoryId: food, amount: 6_000 }],
    });
    assert.deepEqual(identityProblems(db, "2027-03"), []);
  });

  test("a charge split between a blank line and an envelope keeps the identity, in either budget", () => {
    for (const which of ["food", "fun"] as const) {
      const w = household();
      createTransaction(w.db, actor, {
        accountId: w.card, amount: -10_000, date: "2025-03-05",
        splits: [{ categoryId: null, amount: -4_000 }, { categoryId: w[which], amount: -6_000 }],
      });
      assert.deepEqual(identityProblems(w.db, "2027-03"), [], which);
    }
  });

  test("the blank part is unfiled: the payment envelope moves only by the filed part", () => {
    const { db, card, food } = household();
    createTransaction(db, actor, {
      accountId: card, amount: -10_000, date: "2025-03-05",
      splits: [{ categoryId: null, amount: -4_000 }, { categoryId: food, amount: -6_000 }],
    });
    const envelope = paymentCategoryFor(db, card)!.id;
    const month = computeBudget(loadEngineInput(db, { through: "2025-03", useRollup: false })).get("2025-03")!;
    assert.equal(month.categories.get(envelope)!.balance, 6_000);
  });
});
