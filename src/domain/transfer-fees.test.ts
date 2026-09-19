/**
 * A transfer that costs something to make.
 *
 * IMPS above a threshold, NEFT at some banks, a demat transfer, the markup on a
 * currency conversion. Until now the two legs had to be equal, so the charge
 * had to be entered as a separate transaction by hand — and if it was not, the
 * account balance stopped matching the statement.
 *
 * The rule under test: the fee is spending. It leaves the budget accounts, so
 * it must land in an envelope. If it did not, it would come out of Ready to
 * Assign instead and the household's unassigned money would shrink with no
 * line item explaining why.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryAll } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, formatPaise, type Paise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned } from "./budget.ts";
import { createTransfer } from "./transactions.ts";
import { computeBudget, identityResidual } from "../engine/engine.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { Refusal } from "../core/refusal.ts";

const actor: Actor = { memberId: "m", source: "ui" };
const AUG = "2026-08";

function household() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  const a = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(100_000),
  }).id;
  const b = createAccount(db, actor, {
    name: "ICICI", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: 0,
  }).id;
  const group = createGroup(db, actor, "Flexible");
  const charges = createCategory(db, actor, { groupId: group.id, name: "Bank charges" }).id;
  setAssigned(db, actor, AUG, charges, rupees(500));
  return { db, a, b, charges, group };
}

function state(db: ReturnType<typeof household>["db"]) {
  return computeBudget(loadEngineInput(db, { through: AUG })).get(AUG)!;
}

/** Opening balance is a column on the account, not a transaction. */
function balance(db: ReturnType<typeof household>["db"], accountId: string): Paise {
  const opening = queryAll<{ opening_balance: number }>(
    db, `SELECT opening_balance FROM accounts WHERE id = ?`, accountId,
  )[0]!.opening_balance;
  const moved = queryAll<{ amount: number }>(
    db, `SELECT amount FROM transactions WHERE account_id = ? AND deleted_at IS NULL`, accountId,
  ).reduce((t, r) => t + r.amount, 0);
  return (opening + moved) as Paise;
}

describe("a transfer with a charge on it", () => {
  test("the destination gets the amount, the source pays amount plus fee", () => {
    const h = household();
    createTransfer(h.db, actor, {
      fromAccountId: h.a, toAccountId: h.b, amount: rupees(10_000),
      date: "2026-08-10", fee: { amount: rupees(5), categoryId: h.charges },
    });

    assert.equal(balance(h.db, h.b), rupees(10_000), "the destination was short-changed");
    assert.equal(
      balance(h.db, h.a), rupees(100_000) - rupees(10_005),
      "the source did not pay the charge — this is where the statement stops matching",
    );
  });

  test("the fee lands in its envelope, not in Ready to Assign", () => {
    const h = household();
    const before = state(h.db).readyToAssign;

    createTransfer(h.db, actor, {
      fromAccountId: h.a, toAccountId: h.b, amount: rupees(10_000),
      date: "2026-08-10", fee: { amount: rupees(5), categoryId: h.charges },
    });

    const after = state(h.db);
    assert.equal(
      after.readyToAssign, before,
      "the charge came out of unassigned money instead of the envelope",
    );
    assert.equal(
      after.categories.get(h.charges)!.balance, rupees(495),
      "the envelope did not absorb the charge",
    );
  });

  test("and the identity still holds", () => {
    const h = household();
    createTransfer(h.db, actor, {
      fromAccountId: h.a, toAccountId: h.b, amount: rupees(10_000),
      date: "2026-08-10", fee: { amount: rupees(5), categoryId: h.charges },
    });
    const s = state(h.db);
    assert.equal(
      identityResidual(s), 0,
      `identity broken: accounts ${formatPaise(s.budgetAccountBalance)}`,
    );
  });

  test("the fee is not part of the transfer pair", () => {
    /*
     * If it were, the pair would no longer cancel and every report that
     * excludes transfers would swallow a real expense.
     */
    const h = household();
    createTransfer(h.db, actor, {
      fromAccountId: h.a, toAccountId: h.b, amount: rupees(10_000),
      date: "2026-08-10", fee: { amount: rupees(5), categoryId: h.charges },
    });
    const paired = queryAll<{ amount: number }>(
      h.db, `SELECT amount FROM transactions WHERE transfer_pair_id IS NOT NULL`,
    );
    assert.equal(paired.length, 2, "the fee was pulled into the transfer pair");
    assert.equal(paired.reduce((t, r) => t + r.amount, 0), 0, "the two legs no longer cancel");
  });

  test("a transfer without a fee behaves exactly as before", () => {
    const h = household();
    createTransfer(h.db, actor, {
      fromAccountId: h.a, toAccountId: h.b, amount: rupees(10_000), date: "2026-08-10",
    });
    assert.equal(balance(h.db, h.a), rupees(90_000));
    assert.equal(balance(h.db, h.b), rupees(10_000));
    assert.equal(
      queryAll(h.db, `SELECT id FROM transactions WHERE deleted_at IS NULL`).length, 2,
      "an extra transaction appeared for a transfer with no fee",
    );
  });

  test("a zero fee creates nothing", () => {
    const h = household();
    createTransfer(h.db, actor, {
      fromAccountId: h.a, toAccountId: h.b, amount: rupees(10_000), date: "2026-08-10",
      fee: { amount: 0 as Paise, categoryId: h.charges },
    });
    assert.equal(balance(h.db, h.a), rupees(90_000));
  });

  test("a card's payment envelope cannot absorb the charge", () => {
    // The same rule as everywhere else: a payment category's activity is
    // derived from its card, so filing a bank charge into one breaks it.
    const h = household();
    const card = createAccount(h.db, actor, {
      name: "Atlas", kind: "credit", subtype: "credit-card",
      openingDate: "2026-08-01", openingBalance: 0,
    }).id;
    const payment = queryAll<{ id: string }>(
      h.db, `SELECT id FROM categories WHERE payment_account_id = ?`, card,
    )[0]!.id;

    assert.throws(
      () => createTransfer(h.db, actor, {
        fromAccountId: h.a, toAccountId: h.b, amount: rupees(10_000),
        date: "2026-08-10", fee: { amount: rupees(5), categoryId: payment },
      }),
      Refusal,
    );
  });
});
