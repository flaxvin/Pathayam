/**
 * A schedule that lands in more than one envelope.
 *
 * The two most regular things a household has are both splits. A salary
 * arrives and is immediately three things — provident fund, tax deducted, and
 * what actually landed. Rent is rent plus maintenance plus parking, one payment
 * on one date every month. Both had to be entered and split by hand every
 * month, which is the work a schedule exists to remove.
 *
 * What the tests are really guarding: a split that does not add up is money the
 * ledger cannot account for, and a *recurring* one is that mistake repeated
 * every month until somebody notices.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryAll, queryOne } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, formatPaise, type Paise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createSchedule, markPaid, setScheduleSplits, getScheduleSplits } from "./schedules.ts";
import { getSplits } from "./transactions.ts";
import { Refusal } from "../core/refusal.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function household() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(100_000),
  }).id;
  const g = createGroup(db, actor, "Home");
  const rent = createCategory(db, actor, { groupId: g.id, name: "Rent" }).id;
  const maint = createCategory(db, actor, { groupId: g.id, name: "Maintenance" }).id;
  const parking = createCategory(db, actor, { groupId: g.id, name: "Parking" }).id;

  const schedule = createSchedule(db, actor, {
    name: "Flat", accountId: bank, categoryId: rent,
    amount: -rupees(32_000) as Paise,
    recurrence: "monthly", nextDue: "2026-09-05",
  });
  return { db, bank, rent, maint, parking, schedule };
}

describe("setting the lines", () => {
  test("lines that add up to the schedule are accepted", () => {
    const h = household();
    setScheduleSplits(h.db, actor, h.schedule.id, [
      { categoryId: h.rent, amount: -rupees(28_000) as Paise },
      { categoryId: h.maint, amount: -rupees(3_000) as Paise },
      { categoryId: h.parking, amount: -rupees(1_000) as Paise },
    ]);
    assert.equal(getScheduleSplits(h.db, h.schedule.id).length, 3);
  });

  test("lines that do not add up are refused", () => {
    const h = household();
    assert.throws(
      () => setScheduleSplits(h.db, actor, h.schedule.id, [
        { categoryId: h.rent, amount: -rupees(28_000) as Paise },
        { categoryId: h.maint, amount: -rupees(3_000) as Paise },
      ]),
      Refusal,
      "a split that is ₹1,000 short was stored, and would be wrong every month",
    );
    assert.equal(getScheduleSplits(h.db, h.schedule.id).length, 0, "it was stored anyway");
  });

  test("one line is not a split", () => {
    const h = household();
    assert.throws(
      () => setScheduleSplits(h.db, actor, h.schedule.id, [
        { categoryId: h.rent, amount: -rupees(32_000) as Paise },
      ]),
      Refusal,
    );
  });

  test("a card's payment envelope cannot be a line", () => {
    const h = household();
    const card = createAccount(h.db, actor, {
      name: "Atlas", kind: "credit", subtype: "credit-card",
      openingDate: "2026-08-01", openingBalance: 0,
    }).id;
    const payment = queryOne<{ id: string }>(
      h.db, `SELECT id FROM categories WHERE payment_account_id = ?`, card,
    )!.id;
    assert.throws(
      () => setScheduleSplits(h.db, actor, h.schedule.id, [
        { categoryId: payment, amount: -rupees(30_000) as Paise },
        { categoryId: h.maint, amount: -rupees(2_000) as Paise },
      ]),
      Refusal,
    );
  });

  test("passing none clears them", () => {
    const h = household();
    setScheduleSplits(h.db, actor, h.schedule.id, [
      { categoryId: h.rent, amount: -rupees(30_000) as Paise },
      { categoryId: h.maint, amount: -rupees(2_000) as Paise },
    ]);
    setScheduleSplits(h.db, actor, h.schedule.id, []);
    assert.equal(getScheduleSplits(h.db, h.schedule.id).length, 0);
  });

  test("replacing does not accumulate", () => {
    const h = household();
    const two = [
      { categoryId: h.rent, amount: -rupees(30_000) as Paise },
      { categoryId: h.maint, amount: -rupees(2_000) as Paise },
    ];
    setScheduleSplits(h.db, actor, h.schedule.id, two);
    setScheduleSplits(h.db, actor, h.schedule.id, two);
    assert.equal(getScheduleSplits(h.db, h.schedule.id).length, 2, "the lines were appended");
  });
});

describe("posting it", () => {
  test("a split schedule posts a split transaction", () => {
    const h = household();
    setScheduleSplits(h.db, actor, h.schedule.id, [
      { categoryId: h.rent, amount: -rupees(28_000) as Paise },
      { categoryId: h.maint, amount: -rupees(3_000) as Paise },
      { categoryId: h.parking, amount: -rupees(1_000) as Paise },
    ]);

    markPaid(h.db, actor, h.schedule.id, "2026-09-05");

    const txn = queryOne<{ id: string; amount: number; category_id: string | null }>(
      h.db, `SELECT id, amount, category_id FROM transactions ORDER BY created_at DESC LIMIT 1`,
    )!;
    assert.equal(txn.amount, -rupees(32_000));
    assert.equal(
      txn.category_id, null,
      "both a category and split lines were set, which files the amount twice",
    );

    const lines = getSplits(h.db, txn.id);
    assert.equal(lines.length, 3);
    assert.equal(
      lines.reduce((t, l) => t + l.amount, 0), -rupees(32_000),
      "the posted lines do not add up to the transaction",
    );
  });

  test("a schedule with no lines still posts as it always did", () => {
    const h = household();
    markPaid(h.db, actor, h.schedule.id, "2026-09-05");
    const txn = queryOne<{ category_id: string | null }>(
      h.db, `SELECT category_id FROM transactions ORDER BY created_at DESC LIMIT 1`,
    )!;
    assert.equal(txn.category_id, h.rent, "an unsplit schedule lost its category");
  });

  test("posting twice produces two split transactions, not one", () => {
    const h = household();
    setScheduleSplits(h.db, actor, h.schedule.id, [
      { categoryId: h.rent, amount: -rupees(30_000) as Paise },
      { categoryId: h.maint, amount: -rupees(2_000) as Paise },
    ]);
    markPaid(h.db, actor, h.schedule.id, "2026-09-05");
    markPaid(h.db, actor, h.schedule.id, "2026-10-05");
    assert.equal(
      queryAll(h.db, `SELECT id FROM transaction_splits`).length, 4,
      "the second month did not carry the split",
    );
  });

  test("deleting the schedule takes its lines with it", () => {
    const h = household();
    setScheduleSplits(h.db, actor, h.schedule.id, [
      { categoryId: h.rent, amount: -rupees(30_000) as Paise },
      { categoryId: h.maint, amount: -rupees(2_000) as Paise },
    ]);
    execute(h.db, `DELETE FROM schedules WHERE id = ?`, h.schedule.id);
    assert.equal(
      getScheduleSplits(h.db, h.schedule.id).length, 0,
      "orphaned split lines were left behind",
    );
  });
});
