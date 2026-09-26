/**
 * Every door into a reconciled period asks first (R7.b) and, confirmed, marks
 * the checkpoint broken (R7.c).
 *
 * The edit route guarded both legs of a transfer; the delete route only the
 * leg it was reached from (MONEY-CORE-7), and adding a cleared entry did not
 * guard at all (MONEY-CORE-17). Either way the checkpoint went on asserting a
 * balance that no longer held, and nothing reached Review.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { queryOne } from "../db/db.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransfer } from "../domain/transactions.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { reconcile, clearedBalanceAsOf } from "../domain/reconciliation.ts";
import { freshHousehold, RAVI } from "../engine/identity.test-data.ts";
import { startTestApp } from "./harness.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

function household() {
  const db = freshHousehold();
  const a = createAccount(db, actor, {
    name: "Bank A", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 1_000_000,
  }).id;
  const b = createAccount(db, actor, {
    name: "Bank B", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 0,
  }).id;
  const food = createCategory(db, actor, { groupId: createGroup(db, actor, "H").id, name: "Food" }).id;
  return { db, a, b, food };
}

const broken = (db: ReturnType<typeof household>["db"], accountId: string) =>
  queryOne<{ b: number }>(db, `SELECT broken_at IS NOT NULL AS b FROM reconciliations WHERE account_id = ?`, accountId)!.b === 1;

describe("MONEY-CORE-7 · deleting a transfer from its unreconciled side", () => {
  test("asks about the other account's checkpoint, and breaks it once confirmed", async () => {
    const { db, a, b } = household();
    const [out] = createTransfer(db, actor, { fromAccountId: a, toAccountId: b, amount: 300_000, date: "2026-09-05", cleared: true });
    reconcile(db, actor, { accountId: b, bankBalance: 300_000, asOf: "2026-09-10" });
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const ask = await app.post(`/transaction/${out.id}/delete`, {});
      assert.equal(ask.status, 200);
      assert.match(await ask.text(), /Bank B was reconciled/);
      assert.equal(clearedBalanceAsOf(db, b, "2026-09-10"), 300_000, "nothing deleted before the yes");
      assert.equal(broken(db, b), false);

      const yes = await app.post(`/transaction/${out.id}/delete`, { confirm_checkpoint: "1" });
      assert.equal(yes.status, 303);
      assert.equal(clearedBalanceAsOf(db, b, "2026-09-10"), 0);
      assert.equal(broken(db, b), true);
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });
});

describe("MONEY-CORE-17 · adding a cleared entry inside a reconciled period", () => {
  test("asks first, and breaks the checkpoint once confirmed", async () => {
    const { db, a, food } = household();
    reconcile(db, actor, { accountId: a, bankBalance: 1_000_000, asOf: "2026-09-10" });
    const app = await startTestApp(db, { memberId: RAVI });
    const form = { account_id: a, amount: "700", direction: "out", date: "05-09-2026", payee: "Shop", split_category_0: food, cleared: "1" };
    try {
      const ask = await app.post("/add", form);
      assert.equal(ask.status, 200);
      assert.match(await ask.text(), /Bank A was reconciled/);
      assert.equal(clearedBalanceAsOf(db, a, "2026-09-10"), 1_000_000, "nothing added before the yes");

      const yes = await app.post("/add", { ...form, confirm_checkpoint: "1" });
      assert.equal(yes.status, 303);
      assert.equal(clearedBalanceAsOf(db, a, "2026-09-10"), 930_000);
      assert.equal(broken(db, a), true);
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });

  test("an uncleared entry, or one after the checkpoint, asks nothing", async () => {
    const { db, a, food } = household();
    reconcile(db, actor, { accountId: a, bankBalance: 1_000_000, asOf: "2026-09-10" });
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const base = { account_id: a, amount: "700", direction: "out", payee: "Shop", split_category_0: food };
      assert.equal((await app.post("/add", { ...base, date: "05-09-2026" })).status, 303);
      assert.equal((await app.post("/add", { ...base, date: "15-09-2026", cleared: "1" })).status, 303);
      assert.equal(broken(db, a), false);
    } finally { await app.close(); }
  });
});
