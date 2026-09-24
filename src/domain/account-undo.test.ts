/**
 * Money that goes into an account the app values some other way, and undo on
 * accounts and payees.
 *
 * Found by the same ledger audit as transfer-integrity.test.ts:
 *
 *   · The transfer form offered derived accounts — a demat, a gold holding —
 *     whose value comes from their own records, not their balance. ₹5,000
 *     moved from the bank into an investment account left the bank and never
 *     appeared in the investment's value: net worth fell by exactly ₹5,000.
 *   · Undoing an account's creation after anything had been recorded against
 *     it failed on a foreign key — a 500.
 *   · Undoing an account edit said "Restored" and left the holder, visibility,
 *     budget and sort order exactly as the edit had set them.
 *   · Undoing a payee merge cleared the merge flag and left every transaction
 *     and alias with the winner — the loser came back empty.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, testConfig } from "../web/harness.test-data.ts";
import { createAccount, updateAccount, getAccount } from "./accounts.ts";
import { createAssetAccount } from "./assets.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createTransaction, createTransfer, mergePayees, resolvePayee } from "./transactions.ts";
import { Refusal } from "../core/refusal.ts";
import { rupees, type Paise } from "../core/money.ts";
import { queryOne, queryAll, type DB } from "../db/db.ts";
import type { IsoDate } from "../core/dates.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

function lastEvent(db: DB, entity: string, action: string): string {
  return queryOne<{ id: string }>(
    db, `SELECT id FROM events WHERE entity = ? AND action = ? ORDER BY seq DESC LIMIT 1`, entity, action,
  )!.id;
}

function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const bank = createAccount(db, actor, { name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(50_000) }).id;
  const g = createGroup(db, actor, "Home");
  const food = createCategory(db, actor, { groupId: g.id, name: "Food" }).id;
  return { db, bank, food };
}

describe("a transfer does not reach an account valued another way", () => {
  test("into an investment account is refused, and says where to go instead", () => {
    const { db, bank } = setup();
    const demat = createAssetAccount(db, actor, { name: "Zerodha", subtype: "investment" }).id;
    assert.throws(
      () => createTransfer(db, actor, {
        fromAccountId: bank, toAccountId: demat, amount: rupees(5_000) as Paise, date: "2026-09-10" as IsoDate,
      }),
      (e: Error) => e instanceof Refusal && /Portfolio/.test(e.message),
      "₹5,000 would have left the bank and been counted nowhere",
    );
  });

  test("and the transfer form does not offer one", async () => {
    const { db } = setup();
    createAssetAccount(db, actor, { name: "Wombat Gold", subtype: "physical" });
    const app = await startTestApp(db, { memberId: "m-ravi", config: testConfig({}) });
    try {
      const body = await (await app.get("/transfer")).text();
      assert.doesNotMatch(body, /Wombat Gold/);
    } finally { await app.close(); }
  });
});

describe("undo on an account", () => {
  test("undoing a creation the account has since been used for is refused, not a crash", async () => {
    const { db, food } = setup();
    const wallet = createAccount(db, actor, { name: "Wallet", kind: "budget", subtype: "wallet",
      openingDate: "2026-08-01", openingBalance: rupees(2_000) }).id;
    const createEvent = queryOne<{ id: string }>(
      db, `SELECT id FROM events WHERE entity = 'account' AND action = 'create' AND entity_id = ?`, wallet,
    )!.id;
    createTransaction(db, actor, { accountId: wallet, amount: -rupees(100) as Paise,
      date: "2026-09-05" as IsoDate, categoryId: food });
    const app = await startTestApp(db, { memberId: "m-ravi", config: testConfig({}) });
    try {
      const res = await app.post(`/activity/${createEvent}/undo`, { force: "1" });
      assert.equal(res.status, 422, `answered ${res.status}`);
      assert.match(await res.text(), /Close the account instead/);
      assert.ok(getAccount(db, wallet), "the account was deleted anyway");
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });

  test("undoing an edit restores the holder, visibility and sort too", async () => {
    const { db } = setup();
    seedMember(db, "m-priya", "Priya");
    // A tracking account: a budget account in the household budget cannot be
    // private at all (its balance is in everyone's Ready to Assign).
    const fd = createAccount(db, actor, { name: "SBI FD", kind: "tracking", subtype: "fixed-deposit",
      openingDate: "2026-08-01", openingBalance: rupees(1_00_000) }).id;
    const bank = fd;
    const before = getAccount(db, bank)!;
    updateAccount(db, actor, bank, { holder_member_id: "m-ravi", visibility: "private", sort: 9 });
    const app = await startTestApp(db, { memberId: "m-ravi", config: testConfig({}) });
    try {
      assert.equal((await app.post(`/activity/${lastEvent(db, "account", "update")}/undo`, {})).status, 303);
      const after = getAccount(db, bank)!;
      assert.equal(after.holder_member_id, before.holder_member_id);
      assert.equal(after.visibility, before.visibility, "still private after 'Restored'");
      assert.equal(after.sort, before.sort);
    } finally { await app.close(); }
  });
});

describe("undo on a payee merge", () => {
  test("moves the transactions and aliases back", async () => {
    const { db, bank, food } = setup();
    const loser = resolvePayee(db, actor, "Corner Shop", "CORNER SHOP 123").id;
    const winner = resolvePayee(db, actor, "Corner Store").id;
    const t = createTransaction(db, actor, { accountId: bank, amount: -rupees(250) as Paise,
      date: "2026-09-05" as IsoDate, categoryId: food, payeeName: "Corner Shop" }).id;
    mergePayees(db, actor, loser, winner);

    const app = await startTestApp(db, { memberId: "m-ravi", config: testConfig({}) });
    try {
      assert.equal((await app.post(`/activity/${lastEvent(db, "payee", "merge")}/undo`, {})).status, 303);
      assert.equal(
        queryOne<{ payee_id: string }>(db, `SELECT payee_id FROM transactions WHERE id = ?`, t)!.payee_id,
        loser, "the transaction stayed with the winner",
      );
      const aliases = queryAll<{ payee_id: string }>(db, `SELECT payee_id FROM payee_aliases WHERE raw = 'CORNER SHOP 123'`);
      assert.equal(aliases[0]?.payee_id, loser, "the alias stayed with the winner");
    } finally { await app.close(); }
  });
});
