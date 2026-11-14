/**
 * Decision 6 (P-1) · A payee that began on a private row, once nothing uses it
 * any more, is deleted — not left "used nowhere" and so listed to every member.
 * Its only row renamed, purged or taken back by undo, the merchant's name
 * reached Priya's /payees, /add, /activity ("Added the payee …") and export.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { queryOne, queryAll, execute } from "../db/db.ts";
import { undoEvent } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import {
  createTransaction, deleteTransaction, getTransaction, listPayees, purgeDeleted, updateTransaction,
  resolvePayee,
} from "../domain/transactions.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi = { memberId: RAVI, source: "ui" as const };
const SECRET = "UPI-DRSHARMAPSYCH";

function world() {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, PRIYA, "Priya");
  const his = ensurePersonalBudget(db, RAVI, "Ravi");
  const priv = createAccount(db, ravi, {
    name: "Ravi private", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
    openingBalance: 1_000_000, holderMemberId: RAVI, visibility: "private", budgetId: his.id,
  });
  const joint = createAccount(db, ravi, {
    name: "Joint", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 1_000_000,
  });
  const privateTx = createTransaction(db, ravi, {
    accountId: priv.id, amount: -50_000, date: "2026-09-01", payeeName: SECRET,
    raw: { narration: "UPI/DRSHARMAPSYCH/123456" },
  });
  // A raw string learnt for it elsewhere, which has to go with it.
  resolvePayee(db, ravi, SECRET, "DRSHARMAPSYCH CLINIC");
  const jointTx = createTransaction(db, ravi, {
    accountId: joint.id, amount: -20_000, date: "2026-09-02", payeeName: "UPI-DMART",
  });
  return { db, privateTx: privateTx.id, jointTx: jointTx.id, secretId: privateTx.payee_id! };
}

const payeeNamed = (db: ReturnType<typeof freshDb>, name: string) =>
  queryOne<{ id: string }>(db, `SELECT id FROM payees WHERE name = ?`, name);

function eventFor(db: ReturnType<typeof freshDb>, entity: string, entityId: string, action: string): string {
  return queryOne<{ id: string }>(
    db, `SELECT id FROM events WHERE entity = ? AND entity_id = ? AND action = ? ORDER BY seq DESC LIMIT 1`,
    entity, entityId, action,
  )!.id;
}

async function priyaSeesNothing(db: ReturnType<typeof freshDb>) {
  assert.ok(!listPayees(db, PRIYA).some((p) => p.name === SECRET));
  const asPriya = await startTestApp(db, { memberId: PRIYA });
  try {
    for (const path of ["/payees", "/add", "/activity", "/export.json"]) {
      const text = await (await asPriya.get(path)).text();
      assert.doesNotMatch(text, /DRSHARMAPSYCH/, path);
    }
    assert.deepEqual(asPriya.failures, []);
  } finally { await asPriya.close(); }
}

describe("Decision 6 · a private payee nothing uses any more is deleted", () => {
  test("renamed away on the web: gone from Priya's screens; undoing the rename brings it back", async () => {
    const { db, privateTx, secretId } = world();
    assert.equal(queryAll(db, `SELECT 1 FROM payee_aliases WHERE payee_id = ?`, secretId).length, 1);
    const asRavi = await startTestApp(db, { memberId: RAVI });
    try {
      assert.equal((await asRavi.post(`/transaction/${privateTx}`, { payee: "Dr Sharma" })).status, 303);
      assert.deepEqual(asRavi.failures, []);
    } finally { await asRavi.close(); }
    assert.equal(payeeNamed(db, SECRET), null);
    assert.equal(queryAll(db, `SELECT 1 FROM payee_aliases WHERE payee_id = ?`, secretId).length, 0);
    await priyaSeesNothing(db);

    // Ravi's own undo of the rename still works: the payee comes back as it was.
    const edit = eventFor(db, "transaction", privateTx, "update");
    assert.equal(undoEvent(db, edit, ravi, { force: true }).ok, true);
    assert.equal(getTransaction(db, privateTx)!.payee_id, secretId);
    // And "Dr Sharma", created for the private row and now unused, goes in turn.
    assert.equal(payeeNamed(db, "Dr Sharma"), null);
    await priyaSeesNothing(db);
    assert.ok(listPayees(db, RAVI).some((p) => p.name === SECRET));
  });

  test("purged after delete: gone", async () => {
    const { db, privateTx } = world();
    deleteTransaction(db, ravi, privateTx);
    execute(db, `UPDATE transactions SET deleted_at = '2026-01-01T00:00:00+05:30' WHERE id = ?`, privateTx);
    assert.equal(purgeDeleted(db, 30, "2026-11-14"), 1);
    assert.equal(payeeNamed(db, SECRET), null);
    await priyaSeesNothing(db);
  });

  test("taken back by undoing its create: gone", async () => {
    const { db, privateTx } = world();
    assert.equal(undoEvent(db, eventFor(db, "transaction", privateTx, "create"), ravi).ok, true);
    assert.equal(payeeNamed(db, SECRET), null);
    await priyaSeesNothing(db);
  });

  test("a payee begun on a row everyone can see stays when its row is renamed", () => {
    const { db, jointTx } = world();
    const other = resolvePayee(db, ravi, "DMart");
    updateTransaction(db, ravi, jointTx, { payeeId: other.id });
    assert.ok(payeeNamed(db, "UPI-DMART"));
    assert.ok(listPayees(db, PRIYA).some((p) => p.name === "UPI-DMART"));
  });

  test("a payee from before the migration, used nowhere, is left alone", () => {
    const { db } = world();
    execute(db, `INSERT INTO payees (id,name,created_at) VALUES ('p-old','Old Name','2026-01-01T00:00:00+05:30')`);
    assert.ok(listPayees(db, PRIYA).some((p) => p.name === "Old Name"));
  });

  test("a private payee still used elsewhere is kept", () => {
    const { db, privateTx, secretId } = world();
    const tx = getTransaction(db, privateTx)!;
    createTransaction(db, ravi, { accountId: tx.account_id, amount: -1_000, date: "2026-09-05", payeeId: secretId });
    updateTransaction(db, ravi, privateTx, { payeeId: resolvePayee(db, ravi, "Elsewhere").id });
    assert.ok(payeeNamed(db, SECRET));
    assert.ok(!listPayees(db, PRIYA).some((p) => p.name === SECRET));
  });
});
