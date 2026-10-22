/**
 * DEBUG-ENGINE-2 · Nothing new lands on a closed account.
 *
 * An account closes only at nil, because net worth counts open accounts and the
 * budget counts all of them. But nothing stopped money arriving afterwards: a
 * schedule still pointing at the old bank, marked paid, or a transfer from a
 * stale form, posted straight onto the closed account. Its balance then sat in
 * Ready to Assign and nowhere in net worth — exactly what closing at nil exists
 * to prevent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount, closeAccount, reopenAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createTransaction, createTransfer } from "./transactions.ts";
import { createSchedule, markPaid } from "./schedules.ts";

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
  return { db, bank, old, rent };
}

const onOld = (db: ReturnType<typeof setup>["db"], old: string) =>
  queryOne<{ n: number }>(db,
    `SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND deleted_at IS NULL`, old)!.n;

test("a schedule on a closed account is refused rather than posted there", () => {
  const { db, old, rent } = setup();
  const schedule = createSchedule(db, actor, {
    name: "Rent", amount: -rupees(20_000), recurrence: "monthly",
    nextDue: "2026-03-05", accountId: old, categoryId: rent,
  });
  closeAccount(db, actor, old);

  assert.throws(() => markPaid(db, actor, schedule.id, "2026-03-05"), Refusal);
  assert.equal(onOld(db, old), 0, "the closed account stays at nil");
  db.close();
});

test("a transaction or transfer naming a closed account is refused", () => {
  const { db, bank, old, rent } = setup();
  closeAccount(db, actor, old);

  assert.throws(() => createTransaction(db, actor, {
    accountId: old, amount: -rupees(100), date: "2026-03-05", categoryId: rent,
  }), Refusal);
  assert.throws(() => createTransfer(db, actor, {
    fromAccountId: bank, toAccountId: old, amount: rupees(1_000), date: "2026-03-05",
  }), Refusal);
  assert.equal(onOld(db, old), 0);

  // Reopened, it takes money again.
  reopenAccount(db, actor, old);
  createTransfer(db, actor, {
    fromAccountId: bank, toAccountId: old, amount: rupees(1_000), date: "2026-03-05",
  });
  assert.equal(onOld(db, old), 1);
  db.close();
});
