/**
 * Undo paths that could leave the budget's books unbalanced, or reach the
 * household as a raw "FOREIGN KEY constraint failed" 500.
 *
 * Every case asserts the identity in every scope, live and through the rollup,
 * after the undo — the only check a half-working undo cannot pass.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne, queryAll, execute, type DB } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount } from "./accounts.ts";
import { createTransaction, createTransfer, resolvePayee } from "./transactions.ts";
import { convertToEmi } from "./card-emi.ts";
import { ensurePersonalBudget } from "./budgets.ts";
import {
  createGroup, createCategory, startPersonalBudget, setAssigned, deleteCategory, getCategory,
} from "./budget.ts";
import { commitmentEnvelope } from "./commitments.ts";
import { freshHousehold, identityProblems, RAVI, PRIYA } from "../engine/identity.test-data.ts";
import { startTestApp } from "../web/harness.test-data.ts";

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

/*
 * D10 · Undoing the create of something since used threw a raw
 * "FOREIGN KEY constraint failed" — a plain Error, so a 500 through
 * /activity/:id/undo — for a group with an envelope in it, an envelope with
 * money assigned, and (after converting a ₹60,000 card charge to a 6-month EMI)
 * the plan's envelope, its loan and its payee. Each is now refused by name.
 */
describe("D10 · undoing the create of something in use is refused, not a 500", () => {
  const refusedFor = (what: RegExp) => (e: unknown) =>
    e instanceof Refusal && what.test((e as Error).message);

  test("a group with an envelope in it", () => {
    const { db } = bankAndCard();
    const group = createGroup(db, actor, "X").id;
    createCategory(db, actor, { groupId: group, name: "In X" });
    assert.throws(
      () => undoEvent(db, eventFor(db, "category-group", group, "create"), actor, { force: true }),
      refusedFor(/already holds envelopes \(In X\)/),
    );
  });

  test("a group whose only envelope was deleted unused goes, tombstone and all", () => {
    const { db } = bankAndCard();
    const group = createGroup(db, actor, "X").id;
    const only = createCategory(db, actor, { groupId: group, name: "Gone" }).id;
    deleteCategory(db, actor, only, { currentBalance: 0 });
    const result = undoEvent(db, eventFor(db, "category-group", group, "create"), actor, { force: true });
    assert.equal(result.ok, true);
    assert.equal(getCategory(db, only), null);
  });

  test("an envelope with money assigned", () => {
    const { db } = bankAndCard();
    const a = createCategory(db, actor, { groupId: createGroup(db, actor, "G").id, name: "A" }).id;
    setAssigned(db, actor, "2025-03", a, 5_000);
    assert.throws(
      () => undoEvent(db, eventFor(db, "category", a, "create"), actor, { force: true }),
      refusedFor(/money assigned to it/),
    );
    assert.deepEqual(identityProblems(db, "2027-03"), []);
  });

  test("an envelope whose assignment was cleared back to zero still goes", () => {
    const { db } = bankAndCard();
    const a = createCategory(db, actor, { groupId: createGroup(db, actor, "G").id, name: "A" }).id;
    setAssigned(db, actor, "2025-03", a, 5_000);
    setAssigned(db, actor, "2025-03", a, 0);
    const result = undoEvent(db, eventFor(db, "category", a, "create"), actor, { force: true });
    assert.equal(result.ok, true);
    assert.deepEqual(identityProblems(db, "2027-03"), []);
  });

  test("the EMI plan's envelope, loan and payee", () => {
    const { db, card } = bankAndCard();
    const a = createCategory(db, actor, { groupId: createGroup(db, actor, "G").id, name: "A" }).id;
    const b = createCategory(db, actor, { groupId: createGroup(db, actor, "H").id, name: "B" }).id;
    setAssigned(db, actor, "2026-08", a, 6_000_000);
    const charge = createTransaction(db, actor, {
      accountId: card, amount: -6_000_000, date: "2026-08-10", categoryId: a,
    });
    const since = queryOne<{ n: number }>(db, `SELECT MAX(seq) AS n FROM events`)!.n;
    convertToEmi(db, actor, {
      transactionId: charge.id, tenureMonths: 6, annualRatePct: 15, processingFee: 19_900, feeCategoryId: b,
    });
    for (const entity of ["category", "loan", "payee"]) {
      const event = queryOne<{ id: string }>(
        db, `SELECT id FROM events WHERE entity = ? AND action = 'create' AND seq > ?`, entity, since,
      );
      assert.ok(event, `the conversion logged a ${entity}/create`);
      assert.throws(() => undoEvent(db, event.id, actor, { force: true }), Refusal, entity);
    }
    assert.deepEqual(identityProblems(db, "2027-03"), []);
  });

  test("a payee nothing names yet still goes, aliases and all", () => {
    const { db } = bankAndCard();
    const payee = resolvePayee(db, actor, "Corner Shop", "CORNER SHOP 123");
    const result = undoEvent(db, eventFor(db, "payee", payee.id, "create"), actor, { force: true });
    assert.equal(result.ok, true);
  });

  test("through the Activity page it is a 422", async () => {
    const { db, bank } = bankAndCard();
    execute(db, `UPDATE household SET setup_completed_at = ? WHERE id = 1`, nowIST());
    const payee = resolvePayee(db, actor, "Corner Shop");
    createTransaction(db, actor, { accountId: bank, amount: -500, date: "2026-08-10", payeeId: payee.id });
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const res = await app.post(`/activity/${eventFor(db, "payee", payee.id, "create")}/undo`, { force: "1" });
      assert.equal(res.status, 422);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
