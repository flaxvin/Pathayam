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
  const editBase = {
    name: "Flat", amount: "32000", direction: "out",
    recurrence: "monthly", next_due: "2026-10-05",
  };

  test("one line collapses into the schedule's own envelope", async () => {
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

      const res = await app.post(`/schedules/${sch.id}/edit`, {
        ...editBase, split_category_0: upkeep,
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

  test("the first line takes the remainder, so the lines always reconcile", async () => {
    const { db, bank, rent, upkeep, app } = await setup();
    try {
      const sch = createSchedule(db, actor, {
        name: "Flat", accountId: bank, categoryId: rent,
        amount: -rupees(32_000) as Paise, recurrence: "monthly", nextDue: "2026-10-05",
      });
      const res = await app.post(`/schedules/${sch.id}/edit`, {
        ...editBase,
        split_category_0: rent,
        split_category_1: upkeep, split_amount_1: "2000",
      });
      assert.equal(res.status, 303);
      const lines = getScheduleSplits(db, sch.id);
      assert.equal(lines.length, 2);
      assert.equal(lines.reduce((t, l) => t + l.amount, 0), -rupees(32_000));
      assert.equal(
        lines.find((l) => l.category_id === rent)!.amount, -rupees(30_000),
        "the first line did not absorb the remainder",
      );
    } finally { await app.close(); }
  });

  test("claiming more than the schedule is worth is refused", async () => {
    const { db, bank, rent, upkeep, app } = await setup();
    try {
      const sch = createSchedule(db, actor, {
        name: "Flat", accountId: bank, categoryId: rent,
        amount: -rupees(32_000) as Paise, recurrence: "monthly", nextDue: "2026-10-05",
      });
      const res = await app.post(`/schedules/${sch.id}/edit`, {
        ...editBase,
        split_category_0: rent,
        split_category_1: upkeep, split_amount_1: "40000",
      });
      assert.equal(res.status, 422, "the first line would have gone negative");
      assert.equal(getScheduleSplits(db, sch.id).length, 0, "lines were written anyway");
    } finally { await app.close(); }
  });

  test("an outgoing schedule cannot be left with no envelope at all", async () => {
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

      const res = await app.post(`/schedules/${sch.id}/edit`, {
        ...editBase, split_category_0: "",
      });
      assert.equal(res.status, 422, "it would post every month into nothing");
    } finally { await app.close(); }
  });
});

describe("clearing the envelope, where that is a legal thing to want", () => {
  /*
   * The refusal above only bites on money going out. Income filed into an
   * envelope by mistake has to be able to go back to ready-to-assign, and the
   * only way to say so on this form is to blank the first select. Once, that
   * was read as "no lines were sent" and skipped: the save reported success and
   * changed nothing, which is the worst of the three possible outcomes.
   */
  test("an income schedule can be put back to ready-to-assign", async () => {
    const { db, bank, rent, app } = await setup();
    try {
      const sch = createSchedule(db, actor, {
        name: "Salary", accountId: bank, categoryId: rent,
        amount: rupees(180_000) as Paise, recurrence: "monthly", nextDue: "2026-10-01",
      });

      const res = await app.post(`/schedules/${sch.id}/edit`, {
        name: "Salary", amount: "180000", direction: "in",
        recurrence: "monthly", next_due: "2026-10-01",
        split_category_0: "",
      });
      assert.equal(res.status, 303);
      assert.equal(
        queryOne<{ category_id: string | null }>(
          db, `SELECT category_id FROM schedules WHERE id = ?`, sch.id,
        )!.category_id,
        null,
        "the envelope survived a save that asked for it to go",
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

  test("the surviving line takes the whole amount, however it was typed", async () => {
    /*
     * "A single line has to be the whole of it" was the old rule. The first
     * line carries no amount now, so there is nothing to be short of — what a
     * person types in the remaining box is ignored and the line is simply the
     * transaction. Reducing to one envelope always works.
     */
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
        split_category_0: upkeep,
      });
      assert.equal(res.status, 303);
      assert.equal(getSplits(db, t.id).length, 0);
      const after = queryOne<{ category_id: string; amount: number }>(
        db, `SELECT category_id, amount FROM transactions WHERE id = ?`, t.id,
      )!;
      assert.equal(after.category_id, upkeep);
      assert.equal(after.amount, -rupees(2_400), "the amount moved when only the envelope changed");
    } finally { await app.close(); }
  });
});
