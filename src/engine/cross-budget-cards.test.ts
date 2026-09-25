/**
 * Transfers that touch another budget's card, checked against the identity in
 * every scope — the household, each personal budget, and all of them at once —
 * live and through the rollup.
 *
 * D5 · ₹200 from Ravi's bank to the household card, with no envelope between
 * the two budgets yet, left the household +₹200 and Ravi −₹200 in every month
 * after. The payer's leg is kept out of Ready to Assign (a card payment is
 * absorbed by the claim), but only a filing ever opened the envelope that
 * carries the claim — createTransfer never did. Between two personal budgets
 * nothing could ever open one, so it was always broken.
 *
 * D9 · ₹500 from Ravi's card to the household card (a balance transfer) broke
 * both budgets by ₹500 even with the envelope in place: the engine only read a
 * payer leg on a *budget* account, so each budget's payment envelope moved by
 * the other's debt and no claim met it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount, createCard } from "../domain/accounts.ts";
import { createTransfer } from "../domain/transactions.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { startPersonalBudget } from "../domain/budget.ts";
import { commitmentEnvelope } from "../domain/commitments.ts";
import { freshHousehold, identityProblems, RAVI, PRIYA } from "./identity.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };
const HH = "budget-household";

function threeBudgets() {
  const db = freshHousehold();
  const ravi = ensurePersonalBudget(db, RAVI, "Ravi").id;
  const priya = ensurePersonalBudget(db, PRIYA, "Priya").id;
  startPersonalBudget(db, actor, ravi);
  startPersonalBudget(db, actor, priya);
  const open = { openingDate: "2025-01-01" };
  const account = (name: string, kind: "budget" | "credit", budgetId?: string, holder?: string) =>
    createAccount(db, actor, {
      name, kind, subtype: kind === "credit" ? "credit-card" : "savings", ...open,
      openingBalance: kind === "budget" ? 5_000_000 : 0,
      ...(budgetId ? { budgetId, holderMemberId: holder } : {}),
    }).id;
  return {
    db, ravi, priya,
    hBank: account("HBank", "budget"), hCard: account("HCard", "credit"),
    rBank: account("RBank", "budget", ravi, RAVI), rCard: account("RCard", "credit", ravi, RAVI),
    pBank: account("PBank", "budget", priya, PRIYA),
  };
}

describe("D5 · paying another budget's card", () => {
  test("Ravi's bank pays the household card, with no envelope yet", () => {
    const b = threeBudgets();
    createTransfer(b.db, actor, { fromAccountId: b.rBank, toAccountId: b.hCard, amount: 20_000, date: "2025-03-20" });
    assert.ok(commitmentEnvelope(b.db, b.ravi, HH), "the envelope that carries the claim is opened");
    assert.deepEqual(identityProblems(b.db, "2027-03"), []);
  });

  test("the household bank pays Ravi's card", () => {
    const b = threeBudgets();
    createTransfer(b.db, actor, { fromAccountId: b.hBank, toAccountId: b.rCard, amount: 20_000, date: "2025-03-20" });
    assert.deepEqual(identityProblems(b.db, "2027-03"), []);
  });

  test("Ravi's card advances cash into the household bank", () => {
    const b = threeBudgets();
    createTransfer(b.db, actor, { fromAccountId: b.rCard, toAccountId: b.hBank, amount: 20_000, date: "2025-03-20" });
    assert.deepEqual(identityProblems(b.db, "2027-03"), []);
  });

  test("between two personal budgets with nothing linking them, it is refused", () => {
    const b = threeBudgets();
    assert.throws(
      () => createTransfer(b.db, actor, { fromAccountId: b.pBank, toAccountId: b.rCard, amount: 20_000, date: "2025-03-20" }),
      (e: unknown) => e instanceof Refusal && /nothing links the two budgets/.test((e as Error).message),
    );
    assert.deepEqual(identityProblems(b.db, "2027-03"), []);
  });

  test("Priya pays Ravi's card when she holds an add-on on it", () => {
    const b = threeBudgets();
    createCard(b.db, actor, { accountId: b.rCard, label: "Priya's add-on", holderMemberId: PRIYA, isPrimary: false });
    createTransfer(b.db, actor, { fromAccountId: b.pBank, toAccountId: b.rCard, amount: 20_000, date: "2025-03-20" });
    assert.ok(commitmentEnvelope(b.db, b.ravi, b.priya), "Ravi now owes Priya less — or is owed by her");
    assert.deepEqual(identityProblems(b.db, "2027-03"), []);
  });
});

describe("D9 · card to card across budgets", () => {
  test("Ravi's card → the household card", () => {
    const b = threeBudgets();
    createTransfer(b.db, actor, { fromAccountId: b.rCard, toAccountId: b.hCard, amount: 50_000, date: "2025-12-15" });
    assert.deepEqual(identityProblems(b.db, "2027-03"), []);
  });

  test("the household card → Ravi's card", () => {
    const b = threeBudgets();
    createTransfer(b.db, actor, { fromAccountId: b.hCard, toAccountId: b.rCard, amount: 50_000, date: "2025-12-15" });
    assert.deepEqual(identityProblems(b.db, "2027-03"), []);
  });

  test("both directions and a bank payment together still close every budget", () => {
    const b = threeBudgets();
    createTransfer(b.db, actor, { fromAccountId: b.rCard, toAccountId: b.hCard, amount: 50_000, date: "2025-12-15" });
    createTransfer(b.db, actor, { fromAccountId: b.hCard, toAccountId: b.rCard, amount: 12_345, date: "2026-01-02" });
    createTransfer(b.db, actor, { fromAccountId: b.rBank, toAccountId: b.hCard, amount: 777, date: "2026-02-02" });
    assert.deepEqual(identityProblems(b.db, "2027-03"), []);
  });
});
