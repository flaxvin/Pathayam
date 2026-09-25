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
import {
  createSchedule, markPaid, setScheduleSplits, getScheduleSplits, updateSchedule, getSchedule,
} from "./schedules.ts";
import { historyFor, undoEvent } from "../core/events.ts";
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

  test("one line means one envelope, not an error", () => {
    /*
     * Reversed deliberately. Refusing this left no way back from a split: the
     * lines form would not take one line, and the envelope field was disabled
     * because a split existed. Deleting all but one line is somebody saying
     * "it is all this now", so that is what it does.
     */
    const h = household();
    setScheduleSplits(h.db, actor, h.schedule.id, [
      { categoryId: h.maint, amount: -rupees(32_000) as Paise },
    ]);
    assert.equal(getScheduleSplits(h.db, h.schedule.id).length, 0, "it stayed a split");
    assert.equal(
      queryOne<{ category_id: string }>(
        h.db, `SELECT category_id FROM schedules WHERE id = ?`, h.schedule.id,
      )!.category_id,
      h.maint,
      "the surviving line did not become the envelope",
    );
  });

  test("but a single line has to be the whole amount", () => {
    const h = household();
    assert.throws(
      () => setScheduleSplits(h.db, actor, h.schedule.id, [
        { categoryId: h.maint, amount: -rupees(2_000) as Paise },
      ]),
      Refusal,
      "a fraction was accepted as the whole",
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

describe("the envelope on a split schedule", () => {
  test("editing a split schedule does not wipe its stored category", async () => {
    /*
     * The edit form disables the envelope while a schedule is split, and a
     * disabled select submits nothing. If the route read that absence as
     * "clear it", the category would be gone — and gone for good the moment
     * somebody removed the split.
     */
    const h = household();
    const { startTestApp, testConfig } = await import("../web/harness.test-data.ts");
    setScheduleSplits(h.db, actor, h.schedule.id, [
      { categoryId: h.rent, amount: -rupees(30_000) as Paise },
      { categoryId: h.maint, amount: -rupees(2_000) as Paise },
    ]);

    const app = await startTestApp(h.db, { memberId: "m", config: testConfig({}) });
    try {
      // The form as a browser would send it: no category_id, because disabled.
      const res = await app.post(`/schedules/${h.schedule.id}/edit`, {
        name: "Flat", amount: "32000", direction: "out",
        recurrence: "monthly", next_due: "2026-10-05",
      });
      assert.equal(res.status, 303);

      const after = queryOne<{ category_id: string | null }>(
        h.db, `SELECT category_id FROM schedules WHERE id = ?`, h.schedule.id,
      )!;
      assert.equal(
        after.category_id, h.rent,
        "the stored envelope was wiped by a form that never carried it",
      );
    } finally { await app.close(); }
  });

  test("an empty value that is sent is a real attempt to clear, and is refused here", async () => {
    /*
     * Absence means "leave alone"; an empty value means "clear it". On an
     * outgoing schedule clearing is refused outright — it would post every
     * month with nothing recording where the money went — so what this checks
     * is that the empty value reached the rule rather than being ignored.
     */
    const h = household();
    const { startTestApp, testConfig } = await import("../web/harness.test-data.ts");
    const app = await startTestApp(h.db, { memberId: "m", config: testConfig({}) });
    try {
      const res = await app.post(`/schedules/${h.schedule.id}/edit`, {
        name: "Flat", amount: "32000", direction: "out",
        recurrence: "monthly", next_due: "2026-10-05", category_id: "",
      });
      assert.equal(res.status, 422, "an outgoing schedule was left with no envelope");
      const after = queryOne<{ category_id: string | null }>(
        h.db, `SELECT category_id FROM schedules WHERE id = ?`, h.schedule.id,
      )!;
      assert.ok(after.category_id, "the envelope was cleared despite the refusal");
    } finally { await app.close(); }
  });
});

/*
 * S6 · Changing a split schedule's amount left its lines at the old total.
 * ₹1,000.01 split ₹666.68 (Rent) / ₹333.33 (Maintenance), changed to ₹500 —
 * by updateSchedule or by the edit form with no line fields (303 "updated") —
 * kept both lines, and every markPaid after that was refused: "The lines add
 * up to −₹1,000.01, but the transaction is −₹500". The schedule could never be
 * paid again until somebody re-entered its lines.
 */
describe("S6 · a new amount re-files the lines", () => {
  function split() {
    const h = household();
    const s = createSchedule(h.db, actor, {
      name: "Odd", accountId: h.bank, categoryId: h.rent,
      amount: -100_001 as Paise, recurrence: "monthly", nextDue: "2026-09-10",
    });
    setScheduleSplits(h.db, actor, s.id, [
      { categoryId: h.rent, amount: -66_668 as Paise },
      { categoryId: h.maint, amount: -33_333 as Paise },
    ]);
    return { ...h, id: s.id };
  }
  const amounts = (h: ReturnType<typeof split>) => getScheduleSplits(h.db, h.id).map((l) => l.amount);

  test("the first line takes what the others leave, and it can still be paid", () => {
    const h = split();
    updateSchedule(h.db, actor, h.id, { amount: -50_000 as Paise });
    assert.deepEqual(amounts(h), [-16_667, -33_333], "the lines stayed at −₹1,000.01");
    markPaid(h.db, actor, h.id, "2026-09-10");
    const posted = queryAll<{ amount: number }>(
      h.db,
      `SELECT ts.amount FROM transaction_splits ts JOIN transactions t ON t.id = ts.transaction_id
        WHERE t.date = '2026-09-10' ORDER BY ts.amount`,
    ).map((r) => r.amount);
    assert.deepEqual(posted, [-33_333, -16_667]);
  });

  test("over the edit form, with no line fields, and then marked paid", async () => {
    const h = split();
    const { startTestApp, testConfig } = await import("../web/harness.test-data.ts");
    const app = await startTestApp(h.db, { memberId: "m", config: testConfig({}) });
    try {
      const res = await app.post(`/schedules/${h.id}/edit`, {
        name: "Odd", amount: "500", direction: "out", recurrence: "monthly", next_due: "2026-09-10",
      });
      assert.equal(res.status, 303);
      assert.deepEqual(amounts(h), [-16_667, -33_333]);
      const paid = await app.post(`/schedules/${h.id}/paid`, {});
      assert.equal(paid.status, 303, "markPaid was refused for ever after the edit");
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });

  test("an amount the other lines already use up is refused, with the numbers", () => {
    const h = split();
    assert.throws(
      () => updateSchedule(h.db, actor, h.id, { amount: -30_000 as Paise }),
      (e: unknown) => e instanceof Refusal && /come to ₹333\.33/.test(e.message),
    );
    assert.equal(getSchedule(h.db, h.id)!.amount, -100_001, "the amount changed anyway");
    assert.deepEqual(amounts(h), [-66_668, -33_333]);
  });

  test("undoing the change puts the lines back with the amount", () => {
    const h = split();
    updateSchedule(h.db, actor, h.id, { amount: -50_000 as Paise });
    const edit = historyFor(h.db, "schedule", h.id).find((e) => e.summary.startsWith("Edited"))!;
    assert.ok(undoEvent(h.db, edit.id, actor).ok);
    assert.equal(getSchedule(h.db, h.id)!.amount, -100_001);
    assert.deepEqual(amounts(h), [-66_668, -33_333], "undo left lines adding up to −₹500");
  });
});
