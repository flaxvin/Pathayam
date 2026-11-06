/**
 * ENG-11 · Converting a charge to EMI reads the card's own budget.
 *
 * The envelope move (§7.4) takes what the card's payment envelope holds and
 * moves it to the plan's. It was the one domain read of the engine with no
 * budget; the figure it needs is the card's budget's. This case — the
 * household's card, an add-on holder's charge filed to her own, underfunded
 * envelope — is where the two could part, and pins the card's budget's
 * figure. (It read the same either way when written: no case was found where
 * the unscoped read differs, so this guards the read rather than reproducing
 * a wrong move.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount, createCard, paymentCategoryFor } from "./accounts.ts";
import { createGroup, createCategory, setAssigned } from "./budget.ts";
import { createTransaction } from "./transactions.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget } from "../engine/engine.ts";
import { householdBudgetId, ensurePersonalBudget } from "./budgets.ts";
import { ensureCommitmentEnvelope } from "./commitments.ts";
import { convertToEmi } from "./card-emi.ts";
import { paymentCategoryForLoan } from "./loans.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const actor: Actor = { memberId: RAVI, source: "ui" };
const MONTH = monthOf(todayIST());

function setup(): DB {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  for (const [id, name] of [[RAVI, "Ravi"], [PRIYA, "Priya"]] as const) {
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
      id, `${name.toLowerCase()}@example.com`, name, nowIST());
  }
  return db;
}

test("a charge filed to a member's own envelope moves what the card's budget held for it", () => {
  const db = setup();
  const household = householdBudgetId(db);
  const hers = ensurePersonalBudget(db, PRIYA, "Priya");
  ensureCommitmentEnvelope(db, actor, hers.id);
  // The household's card, with her add-on on it.
  const card = createAccount(db, actor, {
    name: "Household card", kind: "credit", subtype: "credit-card", openingDate: todayIST(),
  });
  createCard(db, actor, { accountId: card.id, label: "Priya's add-on", holderMemberId: PRIYA, isPrimary: false });
  createAccount(db, actor, {
    name: "Her savings", kind: "budget", subtype: "savings",
    budgetId: hers.id, openingBalance: rupees(50_000), openingDate: todayIST(),
  });
  const herGroup = createGroup(db, actor, "Mine", "normal", hers.id);
  const phone = createCategory(db, actor, { groupId: herGroup.id, name: "Phone" });
  setAssigned(db, actor, MONTH, phone.id, rupees(10_000));
  const charge = createTransaction(db, actor, {
    accountId: card.id, amount: -rupees(30_000), date: todayIST(),
    categoryId: phone.id, ownerMemberId: PRIYA,
  });

  const cardEnvelope = paymentCategoryFor(db, card.id)!.id;
  const held = computeBudget(loadEngineInput(db, { through: MONTH, budgetId: household }))
    .get(MONTH)!.categories.get(cardEnvelope)!.balance;
  assert.equal(held, rupees(30_000), "the household's budget holds the charge in the card's envelope");

  const { loan } = convertToEmi(db, actor, {
    transactionId: charge.id, annualRatePct: 15, tenureMonths: 6,
  });
  const after = computeBudget(loadEngineInput(db, { through: MONTH, budgetId: household })).get(MONTH)!;
  assert.equal(after.categories.get(paymentCategoryForLoan(db, loan.id)!.id)!.balance, rupees(30_000),
    "the plan's envelope took it");
  assert.equal(after.categories.get(cardEnvelope)!.balance, 0, "and nothing is left behind on the card");
  db.close();
});
