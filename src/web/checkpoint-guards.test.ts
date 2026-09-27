/**
 * Every door into a reconciled period asks first (R7.b) and, confirmed, marks
 * the checkpoint broken (R7.c).
 *
 * The edit route guarded both legs of a transfer; the delete route only the
 * leg it was reached from (MONEY-CORE-7), and adding a cleared entry or undoing
 * an earlier change from Activity did not guard at all (MONEY-CORE-17, 23).
 * Either way the checkpoint went on asserting a balance that no longer held,
 * and nothing reached Review.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { queryOne } from "../db/db.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransfer, createTransaction, updateTransaction, getTransaction } from "../domain/transactions.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { reconcile, clearedBalanceAsOf } from "../domain/reconciliation.ts";
import { parseStatement } from "../import/csv.ts";
import { ingest, listStaged, approveStagedAsTransfer } from "../import/pipeline.ts";
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

describe("MONEY-CORE-23 · undoing an earlier change inside a reconciled period", () => {
  function corrected() {
    const h = household();
    const t = createTransaction(h.db, actor, {
      accountId: h.a, amount: -50_000, date: "2026-09-05", payeeName: "Shop", categoryId: h.food, cleared: true,
    });
    updateTransaction(h.db, actor, t.id, { amount: -70_000 });
    const edit = queryOne<{ id: string }>(
      h.db, `SELECT id FROM events WHERE entity = 'transaction' AND action = 'update' ORDER BY seq DESC LIMIT 1`,
    )!.id;
    reconcile(h.db, actor, { accountId: h.a, bankBalance: 930_000, asOf: "2026-09-10" });
    return { ...h, t, edit };
  }

  test("asks first, changes nothing until confirmed, then breaks the checkpoint", async () => {
    const { db, a, edit } = corrected();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const ask = await app.post(`/activity/${edit}/undo`, {});
      assert.equal(ask.status, 200);
      assert.match(await ask.text(), /Bank A was reconciled/);
      assert.equal(clearedBalanceAsOf(db, a, "2026-09-10"), 930_000, "nothing undone before the yes");
      assert.equal(broken(db, a), false);

      const yes = await app.post(`/activity/${edit}/undo`, { confirm_checkpoint: "1" });
      assert.equal(yes.status, 303);
      assert.equal(clearedBalanceAsOf(db, a, "2026-09-10"), 950_000);
      assert.equal(broken(db, a), true);
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });

  test("an undo that leaves the reconciled balance alone asks nothing", async () => {
    const { db, a, t } = corrected();
    updateTransaction(db, actor, t.id, { memo: "receipt in the drawer" });
    const memo = queryOne<{ id: string }>(
      db, `SELECT id FROM events WHERE entity = 'transaction' AND action = 'update' ORDER BY seq DESC LIMIT 1`,
    )!.id;
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      assert.equal((await app.post(`/activity/${memo}/undo`, {})).status, 303);
      assert.equal(broken(db, a), false);
    } finally { await app.close(); }
  });
});

describe("an imported transfer whose two statements date it differently", () => {
  /*
   * The bank sent ₹5,000 on the 5th; the card credited it on the 7th. Each leg
   * carries its own statement's date, and the bank is reconciled on the 5th.
   */
  function paidCard() {
    const { db, a } = household();
    const card = createAccount(db, actor, {
      name: "Card", kind: "credit", subtype: "credit-card", openingDate: "2026-01-01", openingBalance: 0,
    }).id;
    const imp = (accountId: string, csv: string) => {
      const { result } = parseStatement(csv);
      ingest(db, actor, {
        accountId, source: "csv", adapter: "csv",
        records: result.records, errors: result.errors, rowsRead: result.rowsRead,
      });
    };
    imp(a, "Date,Narration,Amount\n05-09-2026,CARD BILL,-5000.00");
    imp(card, "Date,Narration,Amount\n07-09-2026,PAYMENT RECEIVED,5000.00");
    const bankLeg = getTransaction(db, approveStagedAsTransfer(
      db, actor, listStaged(db).find((r) => r.account_id === a)!.id, card,
    ).transactionId)!;
    const cardLeg = queryOne<{ id: string; date: string }>(
      db, `SELECT id, date FROM transactions WHERE transfer_pair_id = ? AND id <> ?`,
      bankLeg.transfer_pair_id, bankLeg.id,
    )!;
    assert.deepEqual([bankLeg.date, cardLeg.date], ["2026-09-05", "2026-09-07"]);
    reconcile(db, actor, { accountId: a, bankBalance: 500_000, asOf: "2026-09-05" });
    return { db, a, bankLeg, cardLeg };
  }

  test("a memo edit on the card's side leaves the bank's side where its statement put it", async () => {
    const { db, a, bankLeg, cardLeg } = paidCard();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const res = await app.post(`/transaction/${cardLeg.id}`, {
        amount: "5000", date: "07-09-2026", memo: "September bill", cleared: "1",
      });
      assert.equal(res.status, 303);
      assert.equal(getTransaction(db, bankLeg.id)!.date, "2026-09-05");
      assert.equal(clearedBalanceAsOf(db, a, "2026-09-05"), 500_000);
      assert.equal(broken(db, a), false);
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });

  test("a date edit asks about the bank's checkpoint from the bank leg's own date", async () => {
    const { db, a, bankLeg, cardLeg } = paidCard();
    const app = await startTestApp(db, { memberId: RAVI });
    const form = { amount: "5000", date: "08-09-2026", cleared: "1" };
    try {
      const ask = await app.post(`/transaction/${cardLeg.id}`, form);
      assert.equal(ask.status, 200);
      assert.match(await ask.text(), /Bank A was reconciled/);
      assert.equal(getTransaction(db, bankLeg.id)!.date, "2026-09-05", "nothing moved before the yes");

      const yes = await app.post(`/transaction/${cardLeg.id}`, { ...form, confirm_checkpoint: "1" });
      assert.equal(yes.status, 303);
      assert.equal(getTransaction(db, bankLeg.id)!.date, "2026-09-08");
      assert.equal(broken(db, a), true);
    } finally { await app.close(); }
  });
});

describe("a confirmed change that is then refused", () => {
  test("leaves the checkpoint intact — nothing it asserted has moved", async () => {
    const { db, a, food } = household();
    const fun = createCategory(db, actor, { groupId: createGroup(db, actor, "F").id, name: "Fun" }).id;
    const t = createTransaction(db, actor, {
      accountId: a, amount: -50_000, date: "2026-09-05", categoryId: food, cleared: true,
    });
    reconcile(db, actor, { accountId: a, bankBalance: 950_000, asOf: "2026-09-10" });
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      // ₹900 of lines on a ₹500 spend: refused, with the figures.
      const edit = await app.post(`/transaction/${t.id}`, {
        amount: "500", direction: "out", date: "05-09-2026", cleared: "1",
        split_category_0: food, split_category_1: fun, split_amount_1: "900", confirm_checkpoint: "1",
      });
      assert.equal(edit.status, 422);
      assert.equal(broken(db, a), false);

      // Spending with no envelope: refused by the add form.
      const add = await app.post("/add", {
        account_id: a, amount: "700", direction: "out", date: "05-09-2026", cleared: "1", confirm_checkpoint: "1",
      });
      assert.equal(add.status, 400);
      assert.equal(broken(db, a), false);
      assert.equal(clearedBalanceAsOf(db, a, "2026-09-10"), 950_000);

      // The same edit, made properly, still breaks it (R7.c).
      const ok = await app.post(`/transaction/${t.id}`, {
        amount: "600", direction: "out", date: "05-09-2026", cleared: "1",
        split_category_0: food, confirm_checkpoint: "1",
      });
      assert.equal(ok.status, 303);
      assert.equal(broken(db, a), true);
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });
});
