/**
 * DEBUG-ENGINE-13 · Undo never closes an account that holds money, and an
 * edit's undo does not open or close it.
 *
 * The account undo wrote every column of the snapshot back, `closed_at`
 * included. Rename an account, close it, then undo the rename: the account
 * came back open, nobody having asked. And undoing a reopen after money had
 * landed closed the account around a ₹1,000 balance — out of net worth, still
 * in Ready to Assign, the gap closing at nil exists to stop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne, type DB } from "../db/db.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount, updateAccount, closeAccount, reopenAccount, getAccount } from "./accounts.ts";
import { createTransaction } from "./transactions.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "ravi@example.com", "Ravi", nowIST());
  const old = createAccount(db, actor, {
    name: "Old bank", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
  }).id;
  return { db, old };
}

const lastEvent = (db: DB, id: string, action: string) =>
  queryOne<{ id: string }>(db,
    `SELECT id FROM events WHERE entity = 'account' AND entity_id = ? AND action = ? ORDER BY seq DESC LIMIT 1`,
    id, action)!.id;

test("undoing a rename made before the close leaves the account closed", () => {
  const { db, old } = setup();
  updateAccount(db, actor, old, { name: "Old SBI" });
  closeAccount(db, actor, old);
  undoEvent(db, lastEvent(db, old, "update"), actor, { force: true });
  const after = getAccount(db, old)!;
  assert.equal(after.name, "Old bank");
  assert.ok(after.closed_at, "still closed");
  db.close();
});

test("undoing a reopen is refused once the account holds money", () => {
  const { db, old } = setup();
  closeAccount(db, actor, old);
  reopenAccount(db, actor, old);
  createTransaction(db, actor, { accountId: old, amount: rupees(1_000) as Paise, date: "2026-03-01" });
  assert.throws(() => undoEvent(db, lastEvent(db, old, "reopen"), actor, { force: true }));
  assert.equal(getAccount(db, old)!.closed_at, null, "still open, with its ₹1,000");
  db.close();
});
