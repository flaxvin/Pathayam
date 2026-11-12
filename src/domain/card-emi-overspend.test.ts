/**
 * ENG-21 · Converting a charge that overspent its envelope moves only money
 * that was set aside.
 *
 * A ₹30,000 charge from an envelope holding ₹0 puts ₹30,000 in the card's
 * payment envelope on paper, but all of it is credit overspend: nothing was set
 * aside (cardFunding's reallyFunded is 0). The conversion moved the whole
 * ₹30,000 to the plan's envelope, which then read "over-funded ₹30,000" while
 * the card showed its debt as unfunded. Found by the UI pass (UI-13).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned } from "./budget.ts";
import { createTransaction } from "./transactions.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget, identityResidual, cardFunding } from "../engine/engine.ts";
import { cardsDue } from "../web/screen-data.ts";
import { householdBudgetId } from "./budgets.ts";
import { convertToEmi } from "./card-emi.ts";
import { paymentCategoryForLoan } from "./loans.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };
const MONTH = monthOf(todayIST());

function cardWith(assignedToPersonal: number) {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m-ravi", "ravi@example.com", "Ravi", nowIST());
  createAccount(db, actor, {
    name: "Fictional savings", kind: "budget", subtype: "savings",
    openingBalance: rupees(1_00_000), openingDate: todayIST(),
  });
  const card = createAccount(db, actor, {
    name: "Fictional Card", kind: "credit", subtype: "credit-card",
    openingDate: todayIST(), statementDay: 18, dueDay: 5,
  });
  const group = createGroup(db, actor, "Spending");
  const personal = createCategory(db, actor, { groupId: group.id, name: "Personal" });
  if (assignedToPersonal > 0) setAssigned(db, actor, MONTH, personal.id, assignedToPersonal);
  const charge = createTransaction(db, actor, {
    accountId: card.id, amount: -rupees(30_000), date: todayIST(),
    categoryId: personal.id, payeeName: "Fictional Store",
  });
  return { db, card, charge };
}

function planBalance(db: ReturnType<typeof cardWith>["db"], loanId: string) {
  const id = paymentCategoryForLoan(db, loanId)!.id;
  return computeBudget(loadEngineInput(db, { through: MONTH })).get(MONTH)!.categories.get(id)!.balance;
}

describe("ENG-21 · only money set aside follows the debt to the plan", () => {
  test("a charge from an empty envelope moves nothing", () => {
    const { db, charge } = cardWith(0);
    const r = convertToEmi(db, actor, { transactionId: charge.id, tenureMonths: 6, annualRatePct: 15 });
    assert.equal(planBalance(db, r.loan.id), 0, "nothing was set aside, so the plan holds nothing");
    assert.equal(identityResidual(computeBudget(loadEngineInput(db, { through: MONTH })).get(MONTH)!), 0);
  });

  test("a part-funded charge moves only the funded part", () => {
    const { db, charge } = cardWith(rupees(10_000));
    const r = convertToEmi(db, actor, { transactionId: charge.id, tenureMonths: 6, annualRatePct: 15 });
    assert.equal(planBalance(db, r.loan.id), rupees(10_000));
  });

  test("a fully funded charge still moves all of it", () => {
    const { db, charge } = cardWith(rupees(30_000));
    const r = convertToEmi(db, actor, { transactionId: charge.id, tenureMonths: 6, annualRatePct: 15 });
    assert.equal(planBalance(db, r.loan.id), rupees(30_000));
  });
});

/*
 * REV-20 · UI-14 and ENG-21 together. ENG-21 leaves the overspent ₹30,000 in
 * the card's payment envelope (it is not money, so it does not follow the
 * debt), and UI-14's "Set aside" took only the overspend still unfunded off
 * that balance. Once the charge is converted the card owes nothing, so none of
 * the overspend is unfunded, and Cards read "Set aside ₹30,000" on a card
 * nobody had put a rupee by for. Set aside is the balance less the whole
 * overspend in it.
 */
describe("REV-20 · a card converted after overspending shows nothing set aside that was not", () => {
  const due = (db: ReturnType<typeof cardWith>["db"], cardId: string) =>
    cardsDue(db, { month: MONTH, budgetId: householdBudgetId(db), viewerMemberId: "m-ravi" })
      .find((c) => c.accountId === cardId)!;

  test("a charge from an empty envelope, converted: ₹0 set aside", () => {
    const { db, card, charge } = cardWith(0);
    assert.equal(due(db, card.id).setAside, 0, "before: nothing set aside");
    convertToEmi(db, actor, { transactionId: charge.id, tenureMonths: 6, annualRatePct: 15 });
    const after = due(db, card.id);
    assert.equal(after.owed, 0);
    assert.equal(after.setAside, 0, "the overspend is still not money once the debt has moved");
  });

  test("a part-funded charge, converted: the funded part went to the plan, so ₹0 is left", () => {
    const { db, card, charge } = cardWith(rupees(10_000));
    assert.equal(due(db, card.id).setAside, rupees(10_000));
    convertToEmi(db, actor, { transactionId: charge.id, tenureMonths: 6, annualRatePct: 15 });
    assert.equal(due(db, card.id).setAside, 0);
  });

  test("an envelope holding more than an overspent card owes counts only the real money", () => {
    const f = cardFunding("c", -rupees(30_000) as Paise, rupees(80_000) as Paise, rupees(30_000) as Paise);
    assert.equal(f.setAside, rupees(50_000), "₹80,000 in the envelope, ₹30,000 of it overspend");
  });
});
