/**
 * D6 · Moving an account to another budget left the sealed rollup stale.
 *
 * Household Bank ₹1,00,000 and Bank2 ₹0; ₹400 moved Bank → Bank2 in 2025-02;
 * the months were sealed; then Bank2 moved into Ravi's budget. A sealed month
 * had decided, when it was built, that the transfer was internal to one budget
 * — and the invalidation trigger watches kind and opening balance, not
 * budget_id. Live, Ravi's Ready to Assign was ₹50,400; through the rollup
 * ₹50,000, with a residual of +₹400 in every month from 2025-02.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne } from "../db/db.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount, updateAccount } from "../domain/accounts.ts";
import { createTransfer } from "../domain/transactions.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { startPersonalBudget } from "../domain/budget.ts";
import { commitmentEnvelope } from "../domain/commitments.ts";
import { freshHousehold, identityProblems, RAVI, PRIYA } from "./identity.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

function setup() {
  const db = freshHousehold();
  const ravi = ensurePersonalBudget(db, RAVI, "Ravi").id;
  startPersonalBudget(db, actor, ravi);
  createAccount(db, actor, {
    name: "RBank", kind: "budget", subtype: "savings", openingDate: "2025-01-01",
    openingBalance: 5_000_000, budgetId: ravi, holderMemberId: RAVI,
  });
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: 10_000_000,
  }).id;
  const bank2 = createAccount(db, actor, {
    name: "Bank2", kind: "budget", subtype: "savings", openingDate: "2025-01-01",
  }).id;
  return { db, ravi, bank, bank2 };
}

describe("D6 · a move drops the sealed months it changes", () => {
  test("Bank2 into Ravi's budget after its transfer was sealed", () => {
    const s = setup();
    createTransfer(s.db, actor, { fromAccountId: s.bank, toAccountId: s.bank2, amount: 40_000, date: "2025-02-10" });
    assert.deepEqual(identityProblems(s.db, "2027-03"), [], "sealed, and correct");
    assert.ok(queryOne(s.db, `SELECT 1 FROM month_rollup_state WHERE month = '2025-02'`), "2025-02 is sealed");

    updateAccount(s.db, actor, s.bank2, { budget_id: s.ravi });
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });

  test("undoing the move is a move too", () => {
    const s = setup();
    updateAccount(s.db, actor, s.bank2, { budget_id: s.ravi });
    createTransfer(s.db, actor, { fromAccountId: s.bank, toAccountId: s.bank2, amount: 40_000, date: "2025-02-10" });
    updateAccount(s.db, actor, s.bank2, { budget_id: "budget-household" });
    assert.deepEqual(identityProblems(s.db, "2027-03"), [], "sealed with both legs in the household");
    const event = queryOne<{ id: string }>(
      s.db, `SELECT id FROM events WHERE entity = 'account' AND entity_id = ? AND action = 'update'
              ORDER BY seq DESC LIMIT 1`, s.bank2,
    )!.id;
    undoEvent(s.db, event, actor);
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });

  test("a moved bank that paid the household card opens the claim it now needs", () => {
    const s = setup();
    const card = createAccount(s.db, actor, {
      name: "HCard", kind: "credit", subtype: "credit-card", openingDate: "2025-01-01",
    }).id;
    createTransfer(s.db, actor, { fromAccountId: s.bank2, toAccountId: card, amount: 20_000, date: "2025-03-20" });
    updateAccount(s.db, actor, s.bank2, { budget_id: s.ravi });
    assert.ok(commitmentEnvelope(s.db, s.ravi));
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });

  test("a move that would leave two personal budgets owing with nothing linking them is refused", () => {
    const s = setup();
    const priya = ensurePersonalBudget(s.db, PRIYA, "Priya").id;
    const rCard = createAccount(s.db, actor, {
      name: "RCard", kind: "credit", subtype: "credit-card", openingDate: "2025-01-01",
      budgetId: s.ravi, holderMemberId: RAVI,
    }).id;
    const pBank = createAccount(s.db, actor, {
      name: "PBank", kind: "budget", subtype: "savings", openingDate: "2025-01-01",
      openingBalance: 1_000_000, budgetId: s.ravi, holderMemberId: RAVI,
    }).id;
    createTransfer(s.db, actor, { fromAccountId: pBank, toAccountId: rCard, amount: 20_000, date: "2025-03-20" });
    assert.throws(
      () => updateAccount(s.db, actor, pBank, { budget_id: priya, holder_member_id: PRIYA }),
      Refusal,
    );
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });
});
