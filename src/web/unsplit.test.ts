/**
 * Going back to one envelope.
 *
 * Splitting was the easy half. The way back was a dead end in both places:
 * reducing to a single line was refused as "not a split", and the category
 * field it pointed you at was disabled *because* the split existed. Clearing
 * every line escaped that — and left an outgoing schedule with no envelope at
 * all, posting itself every month into nothing.
 *
 * One line means one envelope. That is what somebody is saying when they delete
 * all but one, and it is now what happens.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, testConfig } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction, getSplits } from "../domain/transactions.ts";
import { createSchedule, setScheduleSplits, getScheduleSplits } from "../domain/schedules.ts";
import { rupees, type Paise } from "../core/money.ts";
import { queryOne } from "../db/db.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

async function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(100_000),
  }).id;
  const g = createGroup(db, actor, "Home");
  const rent = createCategory(db, actor, { groupId: g.id, name: "Rent" }).id;
  const upkeep = createCategory(db, actor, { groupId: g.id, name: "Upkeep" }).id;
  const app = await startTestApp(db, { memberId: "m-ravi", config: testConfig({}) });
  return { db, bank, rent, upkeep, app };
}

describe("a schedule going back to one envelope", () => {
  test("one line collapses into the schedule's own category", async () => {
    const { db, bank, rent, upkeep, app } = await setup();
    try {
      const sch = createSchedule(db, actor, {
        name: "Flat", accountId: bank, categoryId: rent,
        amount: -rupees(32_000) as Paise, recurrence: "monthly", nextDue: "2026-10-05",
      });
      setScheduleSplits(db, actor, sch.id, [
        { categoryId: rent, amount: -rupees(30_000) as Paise },
        { categoryId: upkeep, amount: -rupees(2_000) as Paise },
      ]);

      const res = await app.post(`/schedules/${sch.id}/splits`, {
        split_category_0: upkeep, split_amount_0: "32000",
      });
      assert.equal(res.status, 303);
      assert.equal(getScheduleSplits(db, sch.id).length, 0, "the split survived");
      assert.equal(
        queryOne<{ category_id: string }>(db, `SELECT category_id FROM schedules WHERE id = ?`, sch.id)!.category_id,
        upkeep,
        "the surviving line did not become the schedule's envelope",
      );
    } finally { await app.close(); }
  });

  test("a single line that is not the whole amount is refused", async () => {
    const { db, bank, rent, upkeep, app } = await setup();
    try {
      const sch = createSchedule(db, actor, {
        name: "Flat", accountId: bank, categoryId: rent,
        amount: -rupees(32_000) as Paise, recurrence: "monthly", nextDue: "2026-10-05",
      });
      setScheduleSplits(db, actor, sch.id, [
        { categoryId: rent, amount: -rupees(30_000) as Paise },
        { categoryId: upkeep, amount: -rupees(2_000) as Paise },
      ]);
      const res = await app.post(`/schedules/${sch.id}/splits`, {
        split_category_0: upkeep, split_amount_0: "2000",
      });
      assert.equal(res.status, 422, "₹2,000 of a ₹32,000 schedule was accepted as the whole");
      assert.equal(getScheduleSplits(db, sch.id).length, 2, "the split was destroyed anyway");
    } finally { await app.close(); }
  });

  test("clearing every line is refused when it would leave no envelope", async () => {
    const { db, bank, rent, upkeep, app } = await setup();
    try {
      const sch = createSchedule(db, actor, {
        name: "Flat", accountId: bank, splitsFollow: true, categoryId: null,
        amount: -rupees(32_000) as Paise, recurrence: "monthly", nextDue: "2026-10-05",
      });
      setScheduleSplits(db, actor, sch.id, [
        { categoryId: rent, amount: -rupees(30_000) as Paise },
        { categoryId: upkeep, amount: -rupees(2_000) as Paise },
      ]);

      const res = await app.post(`/schedules/${sch.id}/splits`, {});
      assert.equal(res.status, 422, "it would post every month into nothing");
      assert.equal(getScheduleSplits(db, sch.id).length, 2, "the lines went anyway");
    } finally { await app.close(); }
  });

  test("but is allowed when the schedule already has one", async () => {
    const { db, bank, rent, upkeep, app } = await setup();
    try {
      const sch = createSchedule(db, actor, {
        name: "Flat", accountId: bank, categoryId: rent,
        amount: -rupees(32_000) as Paise, recurrence: "monthly", nextDue: "2026-10-05",
      });
      setScheduleSplits(db, actor, sch.id, [
        { categoryId: rent, amount: -rupees(30_000) as Paise },
        { categoryId: upkeep, amount: -rupees(2_000) as Paise },
      ]);
      const res = await app.post(`/schedules/${sch.id}/splits`, {});
      assert.equal(res.status, 303);
      assert.equal(getScheduleSplits(db, sch.id).length, 0);
    } finally { await app.close(); }
  });

  test("the form's plain amounts are read with the schedule's own sign", async () => {
    /*
     * Nobody types a minus into "how much of the rent is maintenance". Read
     * literally, every line on an outgoing schedule was the wrong way round and
     * the totals could never match.
     */
    const { db, bank, rent, upkeep, app } = await setup();
    try {
      const sch = createSchedule(db, actor, {
        name: "Flat", accountId: bank, categoryId: rent,
        amount: -rupees(32_000) as Paise, recurrence: "monthly", nextDue: "2026-10-05",
      });
      const res = await app.post(`/schedules/${sch.id}/splits`, {
        split_category_0: rent, split_amount_0: "30000",
        split_category_1: upkeep, split_amount_1: "2000",
      });
      assert.equal(res.status, 303, "a split typed as plain numbers would not save");
      assert.equal(
        getScheduleSplits(db, sch.id).reduce((t, l) => t + l.amount, 0), -rupees(32_000),
        "the lines were stored the wrong way round",
      );
    } finally { await app.close(); }
  });
});

describe("a transaction going back to one envelope", () => {
  test("one line collapses into the transaction's category", async () => {
    const { db, bank, rent, upkeep, app } = await setup();
    try {
      const t = createTransaction(db, actor, {
        accountId: bank, amount: -rupees(2_400) as Paise, date: "2026-09-10",
        categoryId: null,
        splits: [
          { categoryId: rent, amount: -rupees(1_500) as Paise },
          { categoryId: upkeep, amount: -rupees(900) as Paise },
        ],
      });

      const res = await app.post(`/transaction/${t.id}`, {
        amount: "2400", direction: "out", date: "2026-09-10", account_id: bank,
        split_category_0: upkeep, split_amount_0: "2400",
      });
      assert.equal(res.status, 303);
      assert.equal(getSplits(db, t.id).length, 0, "the split survived");
      const after = queryOne<{ category_id: string; is_split: number }>(
        db, `SELECT category_id, is_split FROM transactions WHERE id = ?`, t.id,
      )!;
      assert.equal(after.category_id, upkeep);
      assert.equal(after.is_split, 0, "it still claims to be split");
    } finally { await app.close(); }
  });

  test("a single line short of the amount is refused", async () => {
    const { db, bank, rent, upkeep, app } = await setup();
    try {
      const t = createTransaction(db, actor, {
        accountId: bank, amount: -rupees(2_400) as Paise, date: "2026-09-10",
        categoryId: null,
        splits: [
          { categoryId: rent, amount: -rupees(1_500) as Paise },
          { categoryId: upkeep, amount: -rupees(900) as Paise },
        ],
      });
      const res = await app.post(`/transaction/${t.id}`, {
        amount: "2400", direction: "out", date: "2026-09-10", account_id: bank,
        split_category_0: upkeep, split_amount_0: "900",
      });
      assert.ok(res.status >= 400, "₹900 was accepted as the whole of ₹2,400");
      assert.equal(getSplits(db, t.id).length, 2, "the split was destroyed anyway");
    } finally { await app.close(); }
  });
});
