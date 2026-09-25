/**
 * Transfers that touch a credit card, checked against the identity in every
 * scope, live and through the rollup.
 *
 * D3 · ₹300 moved between a card and a TRACKING account (a wallet top-up, an
 * EMI on a loan tracked outside the budget) put the identity out by −₹300 in
 * every month after (+₹300 the other way). The card leg was excluded from the
 * "unfiled" charges because it carried a transfer_pair_id, so the payment
 * envelope moved by ₹300 with no category giving it up — and the tracking side
 * is outside every budget, so nothing met it.
 *
 * D13 (engine half) · A card leg whose partner is gone was still treated as
 * half of a card payment: undoing the bank leg of a ₹123.45 payment left the
 * card's payment envelope moved by ₹123.45 with nothing behind it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { createAccount, paymentCategoryFor } from "../domain/accounts.ts";
import { createTransfer } from "../domain/transactions.ts";
import { loadEngineInput } from "./repository.ts";
import { computeBudget } from "./engine.ts";
import { freshHousehold, identityProblems, RAVI } from "./identity.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

function household() {
  const db = freshHousehold();
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: 10_000_000,
  }).id;
  const card = createAccount(db, actor, {
    name: "Card", kind: "credit", subtype: "credit-card", openingDate: "2025-01-01",
  }).id;
  const wallet = createAccount(db, actor, {
    name: "Wallet", kind: "tracking", subtype: "savings", openingDate: "2025-01-01",
  }).id;
  return { db, bank, card, wallet };
}

function paymentEnvelope(db: ReturnType<typeof freshHousehold>, card: string, month: string) {
  const envelope = paymentCategoryFor(db, card)!.id;
  return computeBudget(loadEngineInput(db, { through: month, useRollup: false }))
    .get(month)!.categories.get(envelope)!.balance;
}

describe("D3 · a card and a tracking account", () => {
  test("card → tracking is an unfiled charge: the debt grows, the envelope does not", () => {
    const { db, card, wallet } = household();
    createTransfer(db, actor, { fromAccountId: card, toAccountId: wallet, amount: 30_000, date: "2025-03-05" });

    assert.deepEqual(identityProblems(db, "2027-03"), []);
    // Nothing was set aside for it, so the envelope holds nothing.
    assert.equal(paymentEnvelope(db, card, "2025-03"), 0);
  });

  test("tracking → card is an unfiled refund: the debt falls, the envelope does not", () => {
    const { db, card, wallet } = household();
    createTransfer(db, actor, { fromAccountId: wallet, toAccountId: card, amount: 30_000, date: "2025-03-05" });

    assert.deepEqual(identityProblems(db, "2027-03"), []);
    assert.equal(paymentEnvelope(db, card, "2025-03"), 0);
  });

  test("a real card payment still spends the envelope", () => {
    const { db, bank, card } = household();
    createTransfer(db, actor, { fromAccountId: bank, toAccountId: card, amount: 30_000, date: "2025-03-05" });
    assert.deepEqual(identityProblems(db, "2027-03"), []);
    assert.equal(paymentEnvelope(db, card, "2025-03"), -30_000);
  });
});

describe("D13 · a card leg whose partner is gone", () => {
  for (const [label, direction] of [["bank → card", "in"], ["card → bank", "out"]] as const) {
    test(`${label}: the lone card leg is an unfiled card movement`, () => {
      const { db, bank, card } = household();
      const [out, back] = createTransfer(db, actor, {
        fromAccountId: direction === "in" ? bank : card,
        toAccountId: direction === "in" ? card : bank,
        amount: 12_345, date: "2026-03-28",
      });
      const bankLeg = direction === "in" ? out : back;
      // The state an old one-leg undo left behind.
      execute(db, `DELETE FROM transactions WHERE id = ?`, bankLeg.id);

      assert.deepEqual(identityProblems(db, "2027-03"), []);
    });
  }
});
