/**
 * A transfer is one movement with two sides, and an undo puts back what it took.
 *
 * An audit found the ledger could be made to disagree with itself through
 * ordinary screens, each time breaking the identity the whole engine rests on:
 *
 *   · Editing one side of a ₹1,000 transfer to ₹3,000 changed that side only.
 *     ₹2,000 left one account and arrived nowhere, and the identity was out by
 *     that much in every month from then on.
 *   · Deleting a transfer deletes both sides; undoing the delete brought back
 *     one. The screen promises "restore it for the next 30 days".
 *   · Undoing an edit restored the row and not its split lines, which live in
 *     their own table — a split charge flattened then undone came back marked
 *     split with no lines, its ₹900 in no envelope at all.
 *   · Undoing "cleared" from a reconciliation wrote NULL into account_id — a
 *     500, on an undo the activity page kept offering.
 *   · And one I introduced: the "money out needs an envelope" rule applied to a
 *     transfer's outgoing side, so it could not be saved — not even to mark it
 *     cleared — without being filed to an envelope it has no business in.
 *
 * Every assertion here also checks the identity, because that is what each of
 * these actually broke.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, testConfig } from "../web/harness.test-data.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createTransaction, createTransfer, getTransaction, getSplits, updateTransaction } from "./transactions.ts";
import { reconcile } from "./reconciliation.ts";
import { computeBudget, identityResidual } from "../engine/engine.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { Refusal } from "../core/refusal.ts";
import { rupees, formatPaise, type Paise } from "../core/money.ts";
import { queryOne, execute, type DB } from "../db/db.ts";
import type { MonthKey, IsoDate } from "../core/dates.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

function residuals(db: DB): string[] {
  const out: string[] = [];
  for (const useRollup of [false, true]) {
    for (const [m, st] of computeBudget(loadEngineInput(db, { through: "2026-12" as MonthKey, useRollup }))) {
      const r = identityResidual(st);
      if (r !== 0) out.push(`${useRollup ? "rollup" : "live"} ${m}: out by ${formatPaise(r)}`);
    }
  }
  return out;
}

function world() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const a = createAccount(db, actor, { name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(50_000) }).id;
  const b = createAccount(db, actor, { name: "SBI", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(50_000) }).id;
  const card = createAccount(db, actor, { name: "Card", kind: "credit", subtype: "credit-card",
    openingDate: "2026-08-01", openingBalance: 0 as Paise, statementDay: 18, dueDay: 8 }).id;
  const g = createGroup(db, actor, "Home");
  const food = createCategory(db, actor, { groupId: g.id, name: "Food" }).id;
  const fuel = createCategory(db, actor, { groupId: g.id, name: "Fuel" }).id;
  const [out, inn] = createTransfer(db, actor, {
    fromAccountId: a, toAccountId: b, amount: rupees(1_000) as Paise, date: "2026-09-10" as IsoDate,
  });
  return { db, a, b, card, food, fuel, out, inn };
}

function lastEvent(db: DB, action: string): string {
  return queryOne<{ id: string }>(
    db, `SELECT id FROM events WHERE entity = 'transaction' AND action = ? ORDER BY seq DESC LIMIT 1`, action,
  )!.id;
}

describe("the two sides of a transfer move together", () => {
  test("changing one side's amount changes the other", async () => {
    const w = world();
    const app = await startTestApp(w.db, { memberId: "m-ravi", config: testConfig({}) });
    try {
      const res = await app.post(`/transaction/${w.out.id}`, { amount: "3000", date: "10-09-2026" });
      assert.equal(res.status, 303);
      assert.equal(getTransaction(w.db, w.out.id)!.amount, -rupees(3_000));
      assert.equal(getTransaction(w.db, w.inn.id)!.amount, rupees(3_000), "the other side stayed at ₹1,000");
      assert.deepEqual(residuals(w.db), []);
    } finally { await app.close(); }
  });

  test("and its date", () => {
    const w = world();
    updateTransaction(w.db, actor, w.inn.id, { date: "2026-10-02" as IsoDate });
    assert.equal(getTransaction(w.db, w.out.id)!.date, "2026-10-02");
    assert.deepEqual(residuals(w.db), [], "a month with one side and not the other");
  });

  test("its direction cannot be flipped from one side", () => {
    const w = world();
    assert.throws(
      () => updateTransaction(w.db, actor, w.inn.id, { amount: -rupees(1_000) as Paise }),
      (e: Error) => e instanceof Refusal && /direction is fixed/.test(e.message),
    );
    assert.deepEqual(residuals(w.db), []);
  });

  test("a side is never filed to an envelope", () => {
    const w = world();
    assert.throws(
      () => updateTransaction(w.db, actor, w.out.id, { categoryId: w.food }),
      (e: Error) => e instanceof Refusal && /no envelope/.test(e.message),
    );
  });

  test("the outgoing side can be saved without an envelope — e.g. just to mark it cleared", async () => {
    const w = world();
    const app = await startTestApp(w.db, { memberId: "m-ravi", config: testConfig({}) });
    try {
      // Exactly what the old edit form posted: a direction, and a blank first
      // envelope line — which the envelope rule read as "spending with no envelope".
      const res = await app.post(`/transaction/${w.out.id}`, {
        amount: "1000", direction: "out", date: "10-09-2026", cleared: "1", split_category_0: "",
      });
      assert.equal(res.status, 303, "the envelope rule was applied to money that was never spent");
      assert.equal(getTransaction(w.db, w.out.id)!.cleared, 1);
      assert.equal(getTransaction(w.db, w.out.id)!.category_id, null);
      assert.deepEqual(residuals(w.db), []);
    } finally { await app.close(); }
  });

  test("the edit page does not offer an envelope or a direction for a side", async () => {
    const w = world();
    const app = await startTestApp(w.db, { memberId: "m-ravi", config: testConfig({}) });
    try {
      const body = await (await app.get(`/transaction/${w.out.id}`)).text();
      assert.doesNotMatch(body, /name="split_category_0"/);
      assert.doesNotMatch(body, /name="direction"/);
      assert.match(body, /one side of a transfer/);
    } finally { await app.close(); }
  });
});

describe("undo puts back what it took", () => {
  test("undoing a transfer's delete brings back both sides", async () => {
    const w = world();
    const app = await startTestApp(w.db, { memberId: "m-ravi", config: testConfig({}) });
    try {
      assert.equal((await app.post(`/transaction/${w.out.id}/delete`, {})).status, 303);
      assert.equal((await app.post(`/activity/${lastEvent(w.db, "delete")}/undo`, {})).status, 303);
      assert.equal(getTransaction(w.db, w.out.id)!.deleted_at, null);
      assert.equal(getTransaction(w.db, w.inn.id)!.deleted_at, null, "only one side came back");
      assert.deepEqual(residuals(w.db), []);
    } finally { await app.close(); }
  });

  test("undoing an un-split puts the split lines back", () => {
    const w = world();
    const t = createTransaction(w.db, actor, {
      accountId: w.card, amount: -rupees(900) as Paise, date: "2026-09-12" as IsoDate,
      splits: [{ categoryId: w.food, amount: -rupees(600) as Paise }, { categoryId: w.fuel, amount: -rupees(300) as Paise }],
    });
    updateTransaction(w.db, actor, t.id, { splits: null, categoryId: w.food });
    const app = startTestApp(w.db, { memberId: "m-ravi", config: testConfig({}) });
    return app.then(async (a) => {
      try {
        assert.equal((await a.post(`/activity/${lastEvent(w.db, "update")}/undo`, {})).status, 303);
        const lines = getSplits(w.db, t.id).map((l) => [l.category_id, l.amount]);
        assert.deepEqual(lines, [[w.food, -rupees(600)], [w.fuel, -rupees(300)]], "the lines did not come back");
        assert.equal(getTransaction(w.db, t.id)!.is_split, 1);
        assert.deepEqual(residuals(w.db), [], "the ₹900 is in no envelope");
      } finally { await a.close(); }
    });
  });

  test("undoing a split leaves no orphan lines behind", async () => {
    const w = world();
    const t = createTransaction(w.db, actor, {
      accountId: w.card, amount: -rupees(900) as Paise, date: "2026-09-12" as IsoDate, categoryId: w.food,
    });
    updateTransaction(w.db, actor, t.id, {
      splits: [{ categoryId: w.food, amount: -rupees(600) as Paise }, { categoryId: w.fuel, amount: -rupees(300) as Paise }],
    });
    const app = await startTestApp(w.db, { memberId: "m-ravi", config: testConfig({}) });
    try {
      assert.equal((await app.post(`/activity/${lastEvent(w.db, "update")}/undo`, {})).status, 303);
      assert.equal(getTransaction(w.db, t.id)!.is_split, 0);
      assert.equal(getSplits(w.db, t.id).length, 0, "the split lines survived the undo");
      assert.deepEqual(residuals(w.db), [], "₹900 of spending counted twice");
    } finally { await app.close(); }
  });

  test("undoing a transfer-side edit moves both sides back", async () => {
    const w = world();
    updateTransaction(w.db, actor, w.out.id, { amount: -rupees(3_000) as Paise });
    const app = await startTestApp(w.db, { memberId: "m-ravi", config: testConfig({}) });
    try {
      assert.equal((await app.post(`/activity/${lastEvent(w.db, "update")}/undo`, {})).status, 303);
      assert.equal(getTransaction(w.db, w.out.id)!.amount, -rupees(1_000));
      assert.equal(getTransaction(w.db, w.inn.id)!.amount, rupees(1_000));
      assert.deepEqual(residuals(w.db), []);
    } finally { await app.close(); }
  });

  test("undoing 'cleared' from a reconciliation is not a crash", async () => {
    const w = world();
    const t = createTransaction(w.db, actor, {
      accountId: w.a, amount: -rupees(500) as Paise, date: "2026-09-05" as IsoDate, categoryId: w.food,
    });
    reconcile(w.db, actor, {
      accountId: w.a, asOf: "2026-09-30" as IsoDate, bankBalance: rupees(48_500) as Paise,
      clearTransactionIds: [t.id], allowAdjustment: true,
    } as never);
    const app = await startTestApp(w.db, { memberId: "m-ravi", config: testConfig({}) });
    try {
      const res = await app.post(`/activity/${lastEvent(w.db, "clear")}/undo`, {});
      assert.equal(res.status, 303, `answered ${res.status}`);
      const row = getTransaction(w.db, t.id)!;
      assert.equal(row.cleared, 0);
      assert.equal(row.account_id, w.a, "the undo wrote the rest of the row from a partial snapshot");
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });
});

describe("the engine does not trust the ledger to be perfect", () => {
  test("stray split rows on an unsplit transaction are not counted", () => {
    const w = world();
    const t = createTransaction(w.db, actor, {
      accountId: w.card, amount: -rupees(900) as Paise, date: "2026-09-12" as IsoDate, categoryId: w.food,
    });
    execute(w.db,
      `INSERT INTO transaction_splits (id,transaction_id,category_id,amount,memo,sort) VALUES ('x1',?,?,?,NULL,0)`,
      t.id, w.fuel, -rupees(900));
    assert.deepEqual(residuals(w.db), [], "the orphan line was counted on top of the envelope");
  });

  test("a transfer side whose partner is deleted counts as an ordinary flow", () => {
    const w = world();
    execute(w.db, `UPDATE transactions SET deleted_at = '2026-09-11T00:00:00+05:30' WHERE id = ?`, w.inn.id);
    assert.deepEqual(residuals(w.db), [], "half a transfer vanished from the household's money");
  });
});
