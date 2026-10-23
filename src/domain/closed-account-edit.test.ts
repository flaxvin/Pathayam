/**
 * DEBUG-ENGINE-10 · A closed account stays at nil.
 *
 * DEBUG-ENGINE-2 stopped new money landing on a closed account, but the rows
 * already there could still move: editing a ₹1,000 charge to ₹400, restoring
 * a deleted ₹500, deleting one side of a pair that netted to zero, or undoing
 * any of those left the closed account holding money — counted in Ready to
 * Assign and nowhere in net worth, the gap closing at nil exists to stop.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne } from "../db/db.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount, closeAccount, reopenAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import {
  createTransaction, createTransfer, updateTransaction, deleteTransaction, restoreTransaction,
  UndoRefused,
} from "./transactions.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "ravi@example.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(50_000),
  }).id;
  const old = createAccount(db, actor, {
    name: "Old bank", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
  }).id;
  const group = createGroup(db, actor, "Bills");
  const rent = createCategory(db, actor, { groupId: group.id, name: "Rent" }).id;
  // In ₹1,000, out ₹1,000 — and a ₹500 that was deleted. Nil, so it closes.
  createTransaction(db, actor, {
    accountId: old, amount: rupees(1_000) as Paise, date: "2026-02-01", categoryId: null,
  });
  const charge = createTransaction(db, actor, {
    accountId: old, amount: -rupees(1_000) as Paise, date: "2026-02-02", categoryId: rent,
  }).id;
  const gone = createTransaction(db, actor, {
    accountId: old, amount: -rupees(500) as Paise, date: "2026-02-03", categoryId: rent,
  }).id;
  deleteTransaction(db, actor, gone);
  closeAccount(db, actor, old);
  return { db, bank, old, rent, charge, gone };
}

const balanceOf = (db: ReturnType<typeof setup>["db"], id: string) =>
  queryOne<{ n: number }>(db,
    `SELECT COALESCE(SUM(amount), 0) AS n FROM transactions WHERE account_id = ? AND deleted_at IS NULL`, id)!.n;

const lastEvent = (db: ReturnType<typeof setup>["db"], entityId: string, action: string) =>
  queryOne<{ id: string }>(db,
    `SELECT id FROM events WHERE entity_id = ? AND action = ? ORDER BY seq DESC LIMIT 1`,
    entityId, action)!.id;

test("editing the amount of a transaction on a closed account is refused", () => {
  const { db, old, charge } = setup();
  assert.throws(() => updateTransaction(db, actor, charge, { amount: -rupees(400) as Paise }), Refusal);
  assert.equal(balanceOf(db, old), 0);
  // A memo is not money: that still saves.
  updateTransaction(db, actor, charge, { memo: "final rent" });
  db.close();
});

test("restoring, deleting or undoing on a closed account is refused", () => {
  const { db, old, charge, gone } = setup();
  assert.throws(() => restoreTransaction(db, actor, gone), Refusal);
  assert.throws(() => deleteTransaction(db, actor, charge), Refusal);
  assert.equal(balanceOf(db, old), 0);

  assert.throws(() => undoEvent(db, lastEvent(db, gone, "delete"), actor, { force: true }), UndoRefused);
  assert.throws(() => undoEvent(db, lastEvent(db, charge, "create"), actor, { force: true }), UndoRefused);
  assert.equal(balanceOf(db, old), 0);
  db.close();
});

test("an edit to a transfer whose other side is a closed account is refused", () => {
  const { db, bank, old } = setup();
  reopenAccount(db, actor, old);
  const [out] = createTransfer(db, actor, {
    fromAccountId: bank, toAccountId: old, amount: rupees(2_000) as Paise, date: "2026-02-05",
  });
  createTransfer(db, actor, {
    fromAccountId: old, toAccountId: bank, amount: rupees(2_000) as Paise, date: "2026-02-06",
  });
  closeAccount(db, actor, old);
  assert.throws(() => updateTransaction(db, actor, out.id, { amount: -rupees(3_000) as Paise }), Refusal);
  assert.equal(balanceOf(db, old), 0);
  db.close();
});

test("reopened, the same edit goes through", () => {
  const { db, old, charge } = setup();
  reopenAccount(db, actor, old);
  updateTransaction(db, actor, charge, { amount: -rupees(400) as Paise });
  assert.equal(balanceOf(db, old), rupees(600));
  db.close();
});
