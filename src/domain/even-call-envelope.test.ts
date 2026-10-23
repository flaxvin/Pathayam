/**
 * DEBUG-ENGINE-7 · Calling it even spends from an envelope the budget still reads.
 *
 * The giving envelope is named on the form, and callItEven checked only that it
 * was in the giving budget. A deleted envelope passed — the engine does not walk
 * deleted envelopes, so the ₹2,000 let go was spent from nowhere and the
 * household's books were out by it — and so did a card's payment envelope or a
 * commitment envelope, which nothing may be filed to directly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned, deleteCategory } from "./budget.ts";
import { createTransaction } from "./transactions.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget, identityResidual } from "../engine/engine.ts";
import { householdBudgetId, ensurePersonalBudget } from "./budgets.ts";
import { ensureCommitmentEnvelope, commitmentEnvelope } from "./commitments.ts";
import { callItEven } from "./squaring-up.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const actor: Actor = { memberId: RAVI, source: "ui" };
const MONTH = monthOf(todayIST());

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  for (const [id, name] of [[RAVI, "Ravi"], [PRIYA, "Priya"]] as const) {
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
      id, `${name.toLowerCase()}@example.com`, name, nowIST());
  }
  const household = householdBudgetId(db);
  const hers = ensurePersonalBudget(db, PRIYA, "Priya");
  ensureCommitmentEnvelope(db, actor, hers.id);
  const card = createAccount(db, actor, {
    name: "Household card", kind: "credit", subtype: "credit-card", openingDate: todayIST(),
  });
  createAccount(db, actor, {
    name: "Joint current", kind: "budget", subtype: "savings",
    openingBalance: rupees(50_000), openingDate: todayIST(),
  });
  createAccount(db, actor, {
    name: "Her savings", kind: "budget", subtype: "savings",
    budgetId: hers.id, openingBalance: rupees(40_000), openingDate: todayIST(),
  });
  const herGroup = createGroup(db, actor, "Mine", "normal", hers.id);
  const clothes = createCategory(db, actor, { groupId: herGroup.id, name: "Clothes" });
  setAssigned(db, actor, MONTH, clothes.id, rupees(2_000));
  createTransaction(db, actor, {
    accountId: card.id, amount: -rupees(2_000), date: todayIST(),
    categoryId: clothes.id, ownerMemberId: PRIYA,
  });
  const shared = createGroup(db, actor, "Shared", "normal", household);
  const old = createCategory(db, actor, { groupId: shared.id, name: "Old" });
  deleteCategory(db, actor, old.id, { currentBalance: 0 });
  const payment = db.prepare(`SELECT id FROM categories WHERE payment_account_id = ?`)
    .get(card.id) as { id: string };
  return { db, household, hers, envelope: commitmentEnvelope(db, hers.id)!, old: old.id, payment: payment.id };
}

function residuals(db: DB, budgetIds: string[]): string[] {
  const out: string[] = [];
  for (const budgetId of budgetIds) {
    const s = computeBudget(loadEngineInput(db, { through: MONTH, budgetId })).get(MONTH)!;
    if (identityResidual(s) !== 0) out.push(`${budgetId} ${identityResidual(s)}`);
  }
  return out;
}

test("a deleted envelope cannot be the one the amount is spent from", () => {
  const { db, household, hers, envelope, old } = setup();
  assert.throws(() => callItEven(db, actor, {
    envelopeId: envelope.id, amount: rupees(2_000), month: MONTH, givingCategoryId: old,
  }), Refusal);
  assert.deepEqual(residuals(db, [household, hers.id]), []);
  db.close();
});

test("nor can a card's payment envelope", () => {
  const { db, household, hers, envelope, payment } = setup();
  assert.throws(() => callItEven(db, actor, {
    envelopeId: envelope.id, amount: rupees(2_000), month: MONTH, givingCategoryId: payment,
  }), Refusal);
  assert.deepEqual(residuals(db, [household, hers.id]), []);
  db.close();
});
