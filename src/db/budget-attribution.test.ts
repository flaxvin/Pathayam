/**
 * B108 · Nothing that holds money may be without a budget.
 *
 * `budget_id` NULL is not a neutral default: every scoped read compares with
 * `=`, which NULL never satisfies, so a budget-less envelope disappears from
 * every grid *and* from every identity — which then fails by its balance, in the
 * one direction nobody is looking at. Four creators did exactly this, and the
 * failure surfaced only when a personal budget existed to expose it.
 *
 * This exercises the real creators rather than the schema, because the schema
 * cannot state the rule: a card's envelope belongs where the card is, and only
 * code knows that.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryAll, type DB } from "./db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createLoan } from "../domain/loans.ts";
import { reconcile } from "../domain/reconciliation.ts";
import { startBlank } from "../domain/starting-budget.ts";
import { householdBudgetId, ensurePersonalBudget } from "../domain/budgets.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup(): DB {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  return db;
}

/** Every row that holds or shapes money, and the budget it claims. */
function orphans(db: DB) {
  return {
    categories: queryAll<{ name: string }>(
      db, `SELECT name FROM categories WHERE budget_id IS NULL`,
    ).map((r) => r.name),
    groups: queryAll<{ name: string }>(
      db, `SELECT name FROM category_groups WHERE budget_id IS NULL`,
    ).map((r) => r.name),
    // A tracking account funds nothing, so NULL is right for those only.
    accounts: queryAll<{ name: string }>(
      db, `SELECT name FROM accounts WHERE budget_id IS NULL AND kind <> 'tracking'`,
    ).map((r) => r.name),
  };
}

describe("B108 · every envelope, group and funding account has a budget", () => {
  test("a card, its payment envelope, a loan and a blank start all land somewhere", () => {
    const db = setup();
    startBlank(db, actor);
    createAccount(db, actor, {
      name: "HDFC Regalia", kind: "credit", subtype: "credit-card",
      openingBalance: rupees(-5_000), openingDate: todayIST(),
    });
    const repay = createAccount(db, actor, {
      name: "Joint current", kind: "budget", subtype: "savings",
      openingBalance: rupees(1_00_000), openingDate: todayIST(),
    });
    createLoan(db, actor, {
      lender: "HDFC", loanType: "car", sanctioned: rupees(5_00_000),
      sanctionDate: todayIST(), interestModel: "reducing",
      annualRatePct: 9, tenureMonths: 60, repaymentAccountId: repay.id,
    });

    assert.deepEqual(orphans(db), { categories: [], groups: [], accounts: [] });
    db.close();
  });

  test("a reconciliation adjustment lands in the account's budget, not the household's", () => {
    const db = setup();
    const mine = ensurePersonalBudget(db, RAVI, "Ravi");
    const account = createAccount(db, actor, {
      name: "My savings", kind: "budget", subtype: "savings",
      budgetId: mine.id, openingBalance: rupees(50_000), openingDate: todayIST(),
    });

    // A bank balance that disagrees, which is what forces the adjustment.
    reconcile(db, actor, {
      accountId: account.id, bankBalance: rupees(49_000), asOf: todayIST(),
      allowAdjustment: true,
    });

    const reconciliation = queryAll<{ budget_id: string | null; name: string }>(
      db, `SELECT name, budget_id FROM categories WHERE name = 'Reconciliation'`,
    );
    assert.equal(reconciliation.length, 1);
    assert.equal(reconciliation[0]!.budget_id, mine.id);
    assert.deepEqual(orphans(db), { categories: [], groups: [], accounts: [] });
    db.close();
  });

  test("a card in a personal budget puts its payment envelope there too", () => {
    // 15 §3A.5 · One limit, one statement, one payment: the envelope funding the
    // debt belongs with the account that carries it.
    const db = setup();
    const mine = ensurePersonalBudget(db, RAVI, "Ravi");
    const card = createAccount(db, actor, {
      name: "My card", kind: "credit", subtype: "credit-card",
      budgetId: mine.id, visibility: "private",
      openingBalance: rupees(-2_000), openingDate: todayIST(),
    });

    const envelope = queryAll<{ budget_id: string | null }>(
      db, `SELECT budget_id FROM categories WHERE payment_account_id = ?`, card.id,
    );
    assert.equal(envelope.length, 1);
    assert.equal(envelope[0]!.budget_id, mine.id);
    assert.notEqual(envelope[0]!.budget_id, householdBudgetId(db));
    db.close();
  });
});
