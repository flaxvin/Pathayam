/**
 * Undo paths that could leave the budget's books unbalanced, or reach the
 * household as a raw "FOREIGN KEY constraint failed" 500.
 *
 * Every case asserts the identity in every scope, live and through the rollup,
 * after the undo — the only check a half-working undo cannot pass.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne, queryAll, type DB } from "../db/db.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount } from "./accounts.ts";
import { createTransaction, createTransfer } from "./transactions.ts";
import { ensurePersonalBudget } from "./budgets.ts";
import { createGroup, createCategory, startPersonalBudget } from "./budget.ts";
import { commitmentEnvelope } from "./commitments.ts";
import { freshHousehold, identityProblems, RAVI, PRIYA } from "../engine/identity.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

/** The newest event of this kind about this row. */
function eventFor(db: DB, entity: string, entityId: string, action: string): string {
  const row = queryOne<{ id: string }>(
    db,
    `SELECT id FROM events WHERE entity = ? AND entity_id = ? AND action = ?
      ORDER BY seq DESC LIMIT 1`,
    entity, entityId, action,
  );
  assert.ok(row, `no ${entity}/${action} event for ${entityId}`);
  return row.id;
}

function bankAndCard() {
  const db = freshHousehold();
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: 10_000_000,
  }).id;
  const card = createAccount(db, actor, {
    name: "Card", kind: "credit", subtype: "credit-card", openingDate: "2025-01-01",
  }).id;
  return { db, bank, card };
}

/*
 * D13 · createTransfer logs a create event per leg. Undoing the bank leg's
 * create of a ₹123.45 card payment removed only that leg: the card kept a
 * ₹123.45 credit with no bank side, and the identity was out by −12,345 paise
 * from 2026-03 on (+12,345 for bank → card, undoing the bank leg).
 */
describe("D13 · undoing one leg's create removes the transfer", () => {
  for (const which of ["out", "back"] as const) {
    for (const [label, direction] of [["card → bank", "card-out"], ["bank → card", "bank-out"]] as const) {
      test(`${label}, undoing the ${which === "out" ? "sending" : "receiving"} leg`, () => {
        const { db, bank, card } = bankAndCard();
        const [out, back] = createTransfer(db, actor, {
          fromAccountId: direction === "card-out" ? card : bank,
          toAccountId: direction === "card-out" ? bank : card,
          amount: 12_345, date: "2026-03-28",
        });
        const leg = which === "out" ? out : back;

        const result = undoEvent(db, eventFor(db, "transaction", leg.id, "create"), actor);
        assert.equal(result.ok, true);

        const left = queryAll(
          db, `SELECT id FROM transactions WHERE transfer_pair_id = ?`, out.transfer_pair_id,
        );
        assert.equal(left.length, 0, "both legs go");
        assert.deepEqual(identityProblems(db, "2027-03"), []);
      });
    }
  }
});

/*
 * D12 · Priya's ₹500.03 filed to a household envelope opened her commitment
 * envelope automatically. Undoing that "opened" event hard-deleted it while the
 * filing still needed it: no link was left between the two budgets, and the
 * household was +₹500.03 and Priya −₹500.03 in every month from 2026-05.
 */
describe("D12 · the commitment envelope cannot be undone out from under its filings", () => {
  function priyaFiles() {
    const db = freshHousehold();
    const priya = ensurePersonalBudget(db, PRIYA, "Priya").id;
    startPersonalBudget(db, actor, priya);
    const groceries = createCategory(db, actor, {
      groupId: createGroup(db, actor, "Everyday").id, name: "Groceries",
    }).id;
    const bank = createAccount(db, actor, {
      name: "QBank", kind: "budget", subtype: "savings", openingDate: "2025-01-01",
      openingBalance: 1_000_000, budgetId: priya, holderMemberId: PRIYA,
    }).id;
    return { db, priya, groceries, bank };
  }

  test("refused while a filing crosses the two budgets", () => {
    const s = priyaFiles();
    createTransaction(s.db, actor, {
      accountId: s.bank, amount: -50_003, date: "2026-05-10", categoryId: s.groceries,
    });
    const envelope = commitmentEnvelope(s.db, s.priya)!;
    assert.throws(
      () => undoEvent(s.db, eventFor(s.db, "category", envelope.id, "commitment-envelope"), actor),
      (e: unknown) => e instanceof Refusal && /spending filed across the two budgets/.test((e as Error).message),
    );
    assert.ok(commitmentEnvelope(s.db, s.priya), "the envelope stays");
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });

  test("refused while a card payment crosses them", () => {
    const s = priyaFiles();
    const card = createAccount(s.db, actor, {
      name: "HCard", kind: "credit", subtype: "credit-card", openingDate: "2025-01-01",
    }).id;
    createTransfer(s.db, actor, { fromAccountId: s.bank, toAccountId: card, amount: 20_000, date: "2026-05-11" });
    const envelope = commitmentEnvelope(s.db, s.priya)!;
    assert.throws(
      () => undoEvent(s.db, eventFor(s.db, "category", envelope.id, "commitment-envelope"), actor),
      (e: unknown) => e instanceof Refusal && /card payments between the two budgets/.test((e as Error).message),
    );
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });

  test("allowed once nothing depends on it", () => {
    const s = priyaFiles();
    const tx = createTransaction(s.db, actor, {
      accountId: s.bank, amount: -50_003, date: "2026-05-10", categoryId: s.groceries,
    });
    const envelope = commitmentEnvelope(s.db, s.priya)!;
    undoEvent(s.db, eventFor(s.db, "transaction", tx.id, "create"), actor);
    const result = undoEvent(s.db, eventFor(s.db, "category", envelope.id, "commitment-envelope"), actor);
    assert.equal(result.ok, true);
    assert.equal(commitmentEnvelope(s.db, s.priya), null);
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });
});
