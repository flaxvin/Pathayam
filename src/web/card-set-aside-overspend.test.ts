/**
 * UI-14 · What a card has set aside, beside what it has not.
 *
 * Weekly UI pass 11-11-2026, first-run household: a card owing ₹10,450, all of
 * it funded, then ₹30,000 at Croma on the card from an empty Personal
 * envelope. The card panel read "Outstanding −₹40,450 · Funded ₹40,450 ·
 * Unfunded −₹30,000", and Cards "Set aside ₹40,450 · Not funded ₹30,000":
 * ₹70,450 to account for a ₹40,450 debt. "Funded" was the payment envelope's
 * balance, which R6 fills with the overspent ₹30,000 too — money nobody set
 * aside, as the unfunded figure beside it says. Set aside is now that balance
 * less the overspending in it, so the two add up to what is owed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { createAccount, paymentCategoryFor } from "../domain/accounts.ts";
import { createTransaction } from "../domain/transactions.ts";
import { createGroup, createCategory, setAssigned } from "../domain/budget.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, monthOf } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";
import { buildBudgetView } from "./viewmodel.ts";

const actor: Actor = { memberId: "m-asha", source: "ui" };
const flat = (s: string) => s.replace(/\s+/g, " ");

test("a credit overspend is not counted as set aside on Cards or the card panel", async () => {
  const db = freshDb();
  seedMember(db, "m-asha", "Asha");
  const month = monthOf(todayIST());
  createAccount(db, actor, {
    name: "Savings", kind: "budget", subtype: "savings",
    openingDate: `${month}-01`, openingBalance: rupees(2_00_000),
  });
  const card = createAccount(db, actor, {
    name: "Fictional Card", kind: "credit", subtype: "credit-card",
    openingDate: `${month}-01`, openingBalance: -rupees(10_450) as Paise,
  });
  setAssigned(db, actor, month, paymentCategoryFor(db, card.id)!.id, rupees(10_450));
  const group = createGroup(db, actor, "Flexible");
  const personal = createCategory(db, actor, { groupId: group.id, name: "Personal" });
  createTransaction(db, actor, {
    accountId: card.id, amount: -rupees(30_000) as Paise, categoryId: personal.id,
    payeeName: "Croma", date: todayIST(),
  });

  const app = await startTestApp(db, { memberId: "m-asha" });
  try {
    const cards = flat(await (await app.get("/cards")).text());
    assert.match(cards, /Not funded<\/div> <span class="amount amount-negative">₹30,000<\/span>/);
    assert.match(cards, /Set aside<\/div> <span class="amount">₹10,450<\/span>/,
      "₹10,450 set aside and ₹30,000 not: ₹40,450, what the card owes");

    const panel = flat(await (await app.get(`/accounts/${card.id}`)).text());
    assert.match(panel, /Outstanding<\/div> <strong[^>]*> ?-₹40,450/);
    assert.match(panel, />Funded<\/div> <strong[^>]*> ?₹10,450/);
    assert.match(panel, /Unfunded<\/div> <strong[^>]*> ?-₹30,000/);
    assert.deepEqual(app.failures, []);
  } finally {
    await app.close();
  }
});

/*
 * td-UI-5 · The same charge, seen from the budget row. A card owing ₹18,450
 * with nothing set aside, then ₹5,999 on it from an empty Eating out: the
 * payment envelope holds ₹5,999 that nobody assigned, and its row said
 * "Funded" right under "₹24,449 of your card balance isn't funded yet".
 */
test("a card payment row is not 'Funded' while its card has money nothing is behind", () => {
  const db = freshDb();
  seedMember(db, "m-asha", "Asha");
  const month = monthOf(todayIST());
  createAccount(db, actor, {
    name: "Savings", kind: "budget", subtype: "savings",
    openingDate: `${month}-01`, openingBalance: rupees(2_00_000),
  });
  const card = createAccount(db, actor, {
    name: "Fictional Card", kind: "credit", subtype: "credit-card",
    openingDate: `${month}-01`, openingBalance: -rupees(18_450) as Paise,
  });
  const group = createGroup(db, actor, "Flexible");
  const eatingOut = createCategory(db, actor, { groupId: group.id, name: "Eating out" });
  createTransaction(db, actor, {
    accountId: card.id, amount: -rupees(5_999) as Paise, categoryId: eatingOut.id,
    payeeName: "Swiggy", date: todayIST(),
  });
  const payment = paymentCategoryFor(db, card.id)!.id;

  let view = buildBudgetView(db, month, undefined, "m-asha");
  assert.equal(view.categories.get(payment)!.state.balance, rupees(5_999), "the control: R6 moved the charge");
  assert.equal(view.cards[0]!.unfunded, rupees(24_449));
  assert.equal(view.categories.get(payment)!.stateLabel, "Not funded");

  // Part of it really set aside: partly funded.
  setAssigned(db, actor, month, payment, rupees(10_000));
  view = buildBudgetView(db, month, undefined, "m-asha");
  assert.equal(view.categories.get(payment)!.stateLabel, "Partly funded");

  // All of it set aside and the overspend covered: funded.
  setAssigned(db, actor, month, payment, rupees(18_450));
  setAssigned(db, actor, month, eatingOut.id, rupees(5_999));
  view = buildBudgetView(db, month, undefined, "m-asha");
  assert.equal(view.cards[0]!.unfunded, 0);
  assert.equal(view.categories.get(payment)!.stateLabel, "Funded");
});
