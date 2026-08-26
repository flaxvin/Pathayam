/**
 * R7.g · Forward recompute (`10` §3.1).
 *
 * R7.g.4 makes both overspend models' recompute paths P0 test cases, sitting
 * beside the R2 and R4 worked examples. These are those.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { queryEvents } from "../core/events.ts";
import { nowIST, monthOf, todayIST, addMonths } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import {
  snapshotDerived, diffDerived, withForwardRecompute, setOverspendModel,
} from "./recompute.ts";
import { computeBudget } from "./engine.ts";
import { loadEngineInput } from "./repository.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

// Anchored relative to today, because a "past month" edit is what is under
// test and a hard-coded month would stop being past.
const THIS_MONTH = monthOf(todayIST());
const LAST_MONTH = addMonths(THIS_MONTH, -1);
const TWO_MONTHS_AGO = addMonths(THIS_MONTH, -2);

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());

  const account = createAccount(db, actor, {
    name: "HDFC Savings", kind: "budget", subtype: "savings",
    openingBalance: rupees(200_000), openingDate: `${TWO_MONTHS_AGO}-01`,
  });
  const group = createGroup(db, actor, "Flexible");
  const groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" });
  return { db, account, groceries };
}

function rtaOf(db: DB, month: string): number {
  return computeBudget(loadEngineInput(db, { through: month })).get(month)!.readyToAssign;
}

describe("R7.g.1, R7.g.2 · derived figures recompute themselves", () => {
  test("a past-month edit changes the present without any recompute step", () => {
    const { db, account, groceries } = setup();
    setAssigned(db, actor, TWO_MONTHS_AGO, groceries.id, rupees(10_000));

    const before = rtaOf(db, THIS_MONTH);
    setAssigned(db, actor, TWO_MONTHS_AGO, groceries.id, rupees(30_000));

    // Nothing derived is stored, so the current month is already correct.
    assert.equal(rtaOf(db, THIS_MONTH), before - rupees(20_000));
    void account;
    db.close();
  });

  test("R7.g.5 — nothing recorded is altered, only derived figures", () => {
    const { db, account, groceries } = setup();
    createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-4_000),
      date: `${TWO_MONTHS_AGO}-15`, categoryId: groceries.id,
    });
    setAssigned(db, actor, TWO_MONTHS_AGO, groceries.id, rupees(10_000));

    const transactionsBefore = db.prepare(`SELECT * FROM transactions`).all();
    const assignmentsBefore = db.prepare(`SELECT * FROM assignments`).all();

    snapshotDerived(db, TWO_MONTHS_AGO);

    assert.deepEqual(db.prepare(`SELECT * FROM transactions`).all(), transactionsBefore);
    assert.deepEqual(db.prepare(`SELECT * FROM assignments`).all(), assignmentsBefore);
    db.close();
  });
});

describe("R7.g.3 · the ripple is logged and attributed", () => {
  test("names the cause, the month edited, and the later month that moved", () => {
    const { db, account, groceries } = setup();
    setAssigned(db, actor, TWO_MONTHS_AGO, groceries.id, rupees(10_000));

    const { recompute } = withForwardRecompute(
      db, actor,
      { month: TWO_MONTHS_AGO, cause: "Changed what Groceries was assigned" },
      () => setAssigned(db, actor, TWO_MONTHS_AGO, groceries.id, rupees(40_000)),
    );

    assert.ok(recompute.eventId, "a ripple into later months must be logged");
    const event = queryEvents(db, { entity: "recompute" })[0]!;

    // "August's RTA changed because a June assignment did" — 10 §3.1's example.
    assert.match(event.summary!, /Changed what Groceries was assigned/);
    assert.match(event.summary!, /which changed \d+ later month/);
    assert.match(event.summary!, /Ready to Assign moved by/);
    assert.equal(event.actorMemberId, RAVI);
    void account;
    db.close();
  });

  test("is one batch, not an event per month", () => {
    const { db, groceries } = setup();
    setAssigned(db, actor, TWO_MONTHS_AGO, groceries.id, rupees(10_000));

    withForwardRecompute(
      db, actor, { month: TWO_MONTHS_AGO, cause: "Edited" },
      () => setAssigned(db, actor, TWO_MONTHS_AGO, groceries.id, rupees(50_000)),
    );

    assert.equal(queryEvents(db, { entity: "recompute" }).length, 1);
    db.close();
  });

  test("logs nothing when an edit does not reach beyond its own month", () => {
    const { db, groceries } = setup();

    // A current-month edit has no later months to disturb.
    const { recompute } = withForwardRecompute(
      db, actor, { month: THIS_MONTH, cause: "Edited this month" },
      () => setAssigned(db, actor, THIS_MONTH, groceries.id, rupees(5_000)),
    );

    assert.equal(recompute.eventId, null);
    assert.equal(queryEvents(db, { entity: "recompute" }).length, 0);
    db.close();
  });

  test("reports which category openings moved", () => {
    const { db, account, groceries } = setup();
    setAssigned(db, actor, TWO_MONTHS_AGO, groceries.id, rupees(10_000));

    const before = snapshotDerived(db, TWO_MONTHS_AGO);
    setAssigned(db, actor, TWO_MONTHS_AGO, groceries.id, rupees(18_000));
    const changes = diffDerived(before, snapshotDerived(db, TWO_MONTHS_AGO));

    const nextMonth = changes.find((c) => c.month === LAST_MONTH)!;
    const opening = nextMonth.openingChanges.find((o) => o.categoryId === groceries.id)!;
    assert.equal(opening.before, rupees(10_000));
    assert.equal(opening.after, rupees(18_000));
    void account;
    db.close();
  });
});

describe("R7.g.4 · both overspend models recompute", () => {
  /** A cash overspend two months back, so its carry has somewhere to ripple. */
  function withOverspend(db: DB, accountId: string, categoryId: string) {
    setAssigned(db, actor, TWO_MONTHS_AGO, categoryId, rupees(12_000));
    createTransaction(db, actor, {
      accountId, amount: rupees(-13_400),
      date: `${TWO_MONTHS_AGO}-20`, categoryId,
    });
  }

  test("reduce-rta — deepening a past overspend reduces every later RTA", () => {
    const { db, account, groceries } = setup();
    withOverspend(db, account.id, groceries.id);

    const before = rtaOf(db, THIS_MONTH);
    const beforeSnapshot = snapshotDerived(db, TWO_MONTHS_AGO);

    // Overspend by ₹1,000 more.
    createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-1_000),
      date: `${TWO_MONTHS_AGO}-21`, categoryId: groceries.id,
    });

    assert.equal(rtaOf(db, THIS_MONTH), before - rupees(1_000));

    const changes = diffDerived(beforeSnapshot, snapshotDerived(db, TWO_MONTHS_AGO));
    const lastMonth = changes.find((c) => c.month === LAST_MONTH)!;
    // R4: the carry lands in the month after the overspend.
    assert.equal(lastMonth.cashCarryAfter - lastMonth.cashCarryBefore, rupees(1_000));
    db.close();
  });

  test("carry-negative — the same edit rides on the category, not on RTA", () => {
    const { db, account, groceries } = setup();
    execute(db, `UPDATE household SET overspend_model = 'carry-negative' WHERE id = 1`);
    withOverspend(db, account.id, groceries.id);

    const beforeSnapshot = snapshotDerived(db, TWO_MONTHS_AGO);
    createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-1_000),
      date: `${TWO_MONTHS_AGO}-21`, categoryId: groceries.id,
    });

    const changes = diffDerived(beforeSnapshot, snapshotDerived(db, TWO_MONTHS_AGO));
    const lastMonth = changes.find((c) => c.month === LAST_MONTH)!;

    assert.equal(lastMonth.cashCarryAfter, 0, "RTA is untouched under this model");
    const opening = lastMonth.openingChanges.find((o) => o.categoryId === groceries.id)!;
    assert.equal(opening.after - opening.before, rupees(-1_000), "the category carries it instead");
    db.close();
  });

  test("switching the model is itself a full-history recompute", () => {
    const { db, account, groceries } = setup();
    withOverspend(db, account.id, groceries.id);

    const rtaBefore = rtaOf(db, THIS_MONTH);
    const result = setOverspendModel(db, actor, "carry-negative");

    assert.ok(result.changed.length > 0, "every month from the first with data is reconsidered");

    // Under carry-negative the overspend stays on the category, so RTA is
    // ₹1,400 higher — the same money, a different term absorbing it.
    assert.equal(rtaOf(db, THIS_MONTH), rtaBefore + rupees(1_400));

    const events = queryEvents(db, { descending: false });
    assert.ok(events.some((e) => e.action === "set-overspend-model"));
    assert.ok(
      events.some(
        (e) => e.entity === "recompute" && /Changing the overspend model recomputed/.test(e.summary ?? ""),
      ),
      "the recompute is logged as its own batch",
    );
    db.close();
  });

  test("switching to the model already in use does nothing", () => {
    const { db } = setup();
    const result = setOverspendModel(db, actor, "reduce-rta");
    assert.equal(result.changed.length, 0);
    assert.equal(queryEvents(db, { action: "set-overspend-model" }).length, 0);
    db.close();
  });

  test("switching back restores the original figures exactly", () => {
    const { db, account, groceries } = setup();
    withOverspend(db, account.id, groceries.id);

    const original = rtaOf(db, THIS_MONTH);
    setOverspendModel(db, actor, "carry-negative");
    setOverspendModel(db, actor, "reduce-rta");

    // Both models are complete implementations, so the round trip is lossless.
    assert.equal(rtaOf(db, THIS_MONTH), original);
    db.close();
  });
});
