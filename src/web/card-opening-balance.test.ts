/**
 * N7 · A warning a household cannot act on becomes wallpaper.
 *
 * A card added with an opening balance of −₹6,200 says *"₹6,200 of your Swiggy
 * HDFC balance has no envelope behind it"*, and a household that goes looking
 * for the spending behind it finds none: an opening balance is a fact about the
 * account, not a transaction. So the warning is honest and looks broken, which
 * is the worst thing a warning can be — the next real one is read the same way.
 *
 * It was always clearable. These hold that it says so, and that it clears.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { buildBudgetView } from "./viewmodel.ts";
import { cameWithTheCard } from "../domain/card-shortfall.ts";
import { createAccount } from "../domain/accounts.ts";
import { setAssigned } from "../domain/budget.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, monthOf } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";

const RAVI = "m-ravi";
const ravi: Actor = { memberId: RAVI, source: "ui" };

function householdWithACardThatCameWithDebt() {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  createAccount(db, ravi, {
    name: "Joint current", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(1_00_000),
  });
  const card = createAccount(db, ravi, {
    name: "Swiggy HDFC", kind: "credit", subtype: "credit-card",
    openingDate: "2026-01-01", openingBalance: -rupees(6_200) as Paise,
    creditLimit: rupees(1_00_000), dueDay: 5, statementDay: 20,
  });
  return { db, card };
}

describe("N7 · the shortfall that came with the card", () => {
  test("there is nothing in the register to explain it", () => {
    const { db, card } = householdWithACardThatCameWithDebt();
    const view = buildBudgetView(db, monthOf(todayIST()));
    const funding = view.cards.find((c) => c.accountId === card.id)!;
    assert.equal(funding.unfunded, rupees(6_200));
    assert.equal(funding.startingDebt, rupees(6_200));
    assert.match(cameWithTheCard(funding)!, /came with the card/);
  });

  test("and the screens say so rather than leaving it to be worked out", async () => {
    const { db, card } = householdWithACardThatCameWithDebt();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      // The budget screen, the cards screen and the card's own page: the three
      // places the figure appears in words rather than as a column.
      for (const path of ["/", "/cards", `/accounts/${card.id}`]) {
        const body = (await (await app.get(path)).text()).replace(/\s+/g, " ");
        assert.match(
          body, /came with the card when you added it/,
          `${path} states the shortfall without saying there is nothing to file`,
        );
      }
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("it clears by funding the envelope, like anything else", () => {
    const { db, card } = householdWithACardThatCameWithDebt();
    const month = monthOf(todayIST());
    const envelope = [...buildBudgetView(db, month).categories.values()]
      .find((c) => c.paymentAccountId === card.id)!;

    setAssigned(db, ravi, month, envelope.id, rupees(6_200) as Paise);

    const after = buildBudgetView(db, month).cards.find((c) => c.accountId === card.id)!;
    assert.equal(after.unfunded, 0, "a permanent warning is wallpaper, and this one is not permanent");
    assert.equal(cameWithTheCard(after), null, "it still explains a shortfall that is gone");
  });

  test("a card whose debt is spending says nothing about opening balances", () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    createAccount(db, ravi, {
      name: "Joint current", kind: "budget", subtype: "savings",
      openingDate: "2026-01-01", openingBalance: rupees(1_00_000),
    });
    const card = createAccount(db, ravi, {
      name: "Clean HDFC", kind: "credit", subtype: "credit-card",
      openingDate: "2026-01-01", openingBalance: 0 as Paise,
      creditLimit: rupees(1_00_000), dueDay: 5, statementDay: 20,
    });
    const funding = buildBudgetView(db, monthOf(todayIST()))
      .cards.find((c) => c.accountId === card.id)!;
    assert.equal(funding.startingDebt, 0);
    assert.equal(cameWithTheCard(funding), null);
  });
});
