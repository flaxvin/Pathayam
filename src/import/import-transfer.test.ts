/**
 * IMPORTS-SCHEDULES-32 · An imported card bill payment is recorded as the
 * transfer it is.
 *
 * Review offered only spending envelopes for the bank's "CARD BILL PAYMENT
 * −5,000", refused the card's payment envelope, and defaulted the card's
 * "PAYMENT RECEIVED +5,000" to new money — so following the form filed ₹5,000
 * of groceries and ₹5,000 of phantom income. Each row now offers "Transfer
 * to/from" the household's other accounts; the other account's own row, if it
 * is waiting too, becomes the second leg.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryAll, queryOne, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { listStaged, undoBatch } from "./pipeline.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const bank = createAccount(db, actor, {
    name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 10_000_000,
  });
  const card = createAccount(db, actor, {
    name: "ZZ Card", kind: "credit", subtype: "credit-card", openingDate: "2026-01-01", openingBalance: -500_000,
  });
  const g = createGroup(db, actor, "ZZ Group");
  createCategory(db, actor, { groupId: g.id, name: "ZZ Groceries" });
  return { db, bank: bank.id, card: card.id };
}

const live = (db: DB) => queryAll<{
  account_id: string; amount: number; date: string; category_id: string | null;
  transfer_pair_id: string | null; source_id: string | null; cleared: number;
}>(db,
  `SELECT account_id, amount, date, category_id, transfer_pair_id, source_id, cleared
     FROM transactions WHERE deleted_at IS NULL AND transfer_pair_id IS NOT NULL
    ORDER BY amount`);

describe("IMPORTS-SCHEDULES-32 · imported transfers", () => {
  test("the bank row and the card row become one transfer pair", async () => {
    const { db, bank, card } = setup();
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      await app.post("/import", {
        account_id: bank, file_name: "bank.csv",
        csv: "Date,Narration,Amount\n10-09-2026,ZZ CARD BILL PAYMENT,-5000.00",
      });
      await app.post("/import", {
        account_id: card, file_name: "card.csv",
        csv: "Date,Narration,Amount\n11-09-2026,PAYMENT RECEIVED THANK YOU,5000.00",
      });
      const bankRow = listStaged(db).find((r) => r.account_id === bank)!;

      const page = await (await app.get("/review")).text();
      assert.ok(page.includes(`value="transfer:${card}"`), "the bank row offers a transfer to the card");

      const res = await app.post("/review/approve", { staged_id: bankRow.id, category_id: `transfer:${card}` });
      assert.equal(res.status, 303);
      assert.match(decodeURIComponent(res.headers.get("location") ?? ""), /matched with its own imported row/);
      assert.equal(listStaged(db).length, 0, "both rows are resolved");

      const legs = live(db);
      assert.equal(legs.length, 2);
      assert.equal(legs[0]!.transfer_pair_id, legs[1]!.transfer_pair_id);
      assert.deepEqual(legs.map((l) => [l.account_id, l.amount, l.date, l.category_id, l.cleared]), [
        [bank, -500_000, "2026-09-10", null, 1],
        [card, 500_000, "2026-09-11", null, 1],
      ]);
      assert.ok(legs.every((l) => l.source_id), "each leg keeps its import identity");

      // Re-importing the bank file adds nothing: the leg is its ledger copy.
      await app.post("/import", {
        account_id: bank, file_name: "bank.csv",
        csv: "Date,Narration,Amount\n10-09-2026,ZZ CARD BILL PAYMENT,-5000.00",
      });
      assert.equal(listStaged(db).length, 0);
    } finally {
      await app.close();
    }
  });

  test("undoing one side's import removes the pair and returns the other row to Review", async () => {
    const { db, bank, card } = setup();
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      await app.post("/import", {
        account_id: bank, file_name: "bank.csv",
        csv: "Date,Narration,Amount\n10-09-2026,ZZ CARD BILL PAYMENT,-5000.00",
      });
      await app.post("/import", {
        account_id: card, file_name: "card.csv",
        csv: "Date,Narration,Amount\n10-09-2026,PAYMENT RECEIVED THANK YOU,5000.00",
      });
      const bankRow = listStaged(db).find((r) => r.account_id === bank)!;
      await app.post("/review/approve", { staged_id: bankRow.id, category_id: `transfer:${card}` });

      undoBatch(db, actor, bankRow.batch_id);
      assert.equal(queryOne<{ n: number }>(db,
        `SELECT COUNT(*) AS n FROM transactions WHERE deleted_at IS NULL AND transfer_pair_id IS NOT NULL`)!.n, 0);
      assert.deepEqual(listStaged(db).map((r) => r.account_id), [card]);
    } finally {
      await app.close();
    }
  });

  test("with no row from the other side, the other leg is posted uncleared", async () => {
    const { db, bank, card } = setup();
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      await app.post("/import", {
        account_id: bank, file_name: "bank.csv",
        csv: "Date,Narration,Amount\n10-09-2026,ZZ CARD BILL PAYMENT,-5000.00",
      });
      const bankRow = listStaged(db)[0]!;
      const res = await app.post("/review/approve", { staged_id: bankRow.id, category_id: `transfer:${card}` });
      assert.equal(res.status, 303);
      const cardLeg = queryOne<{ amount: number; cleared: number }>(db,
        `SELECT amount, cleared FROM transactions WHERE account_id = ? AND transfer_pair_id IS NOT NULL`, card)!;
      assert.deepEqual({ ...cardLeg }, { amount: 500_000, cleared: 0 });

      // The row's own account is not a transfer target.
      await app.post("/import", {
        account_id: bank, file_name: "bank2.csv",
        csv: "Date,Narration,Amount\n12-09-2026,ZZ SWEEP,-100.00",
      });
      const again = listStaged(db)[0]!;
      assert.equal((await app.post("/review/approve", { staged_id: again.id, category_id: `transfer:${bank}` })).status, 422);
    } finally {
      await app.close();
    }
  });
});
