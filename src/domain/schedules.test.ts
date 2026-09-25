/**
 * F7 · Schedules that can be changed, removed, and point either way.
 *
 * A schedule was permanent from the moment it was created — neither an update nor
 * a delete was ever written — so a typo in the amount or a cancelled subscription
 * stayed in the cashflow projection for good. And the create route forced
 * `-Math.abs()` on every amount, so a salary could not be scheduled at all, even
 * though the projection has always had an inflows side and "will I make it to the
 * 30th" depends on knowing when money arrives.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, addDays, todayIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { historyFor, undoEvent } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import {
  createSchedule, updateSchedule, deleteSchedule, listSchedules, getSchedule,
  projectCashflow,
} from "./schedules.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "F", nowIST());
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(50_000),
  });
  // Money out needs an envelope, so the fixtures have one.
  const group = createGroup(db, actor, "Fixed");
  const bills = createCategory(db, actor, { groupId: group.id, name: "Bills" });
  return { db, bank: bank.id, bills: bills.id };
}

describe("F7 · a schedule can be changed", () => {
  test("the amount, the day and how often — and it undoes", () => {
    const { db, bank, bills } = setup();
    const schedule = createSchedule(db, actor, {
      name: "Rnt", amount: -rupees(38_000), recurrence: "monthly",
      nextDue: "2026-03-03", accountId: bank, categoryId: bills,
    });

    updateSchedule(db, actor, schedule.id, {
      name: "Rent", amount: -rupees(41_000) as never, next_due: "2026-03-05",
      recurrence: "monthly",
    });

    const after = getSchedule(db, schedule.id)!;
    assert.equal(after.name, "Rent");
    assert.equal(after.amount, -rupees(41_000), "the rent went up");
    assert.equal(after.next_due, "2026-03-05");

    const event = historyFor(db, "schedule", schedule.id).at(-1)!;
    undoEvent(db, event.id, actor);
    const back = getSchedule(db, schedule.id)!;
    assert.equal(back.name, "Rnt");
    assert.equal(back.amount, -rupees(38_000), "all of it, not only the date");
  });

  test("an unmentioned field keeps its value (B107)", () => {
    const { db, bank, bills } = setup();
    const schedule = createSchedule(db, actor, {
      name: "Netflix", amount: -rupees(649), recurrence: "monthly",
      nextDue: "2026-03-14", accountId: bank, categoryId: bills, isSubscription: true,
    });
    updateSchedule(db, actor, schedule.id, { name: "Netflix Premium", amount: undefined });
    const after = getSchedule(db, schedule.id)!;
    assert.equal(after.amount, -rupees(649));
    assert.equal(after.account_id, bank);
  });
});

describe("F7 · a schedule can be removed", () => {
  test("removing it leaves what it already recorded, and undoes whole", () => {
    const { db, bills } = setup();
    const schedule = createSchedule(db, actor, {
      name: "Gym", amount: -rupees(1_500), recurrence: "monthly", nextDue: "2026-03-01",
      categoryId: bills,
    });

    deleteSchedule(db, actor, schedule.id);
    assert.equal(listSchedules(db).some((s) => s.id === schedule.id), false);

    const event = historyFor(db, "schedule", schedule.id).at(-1)!;
    undoEvent(db, event.id, actor);

    const back = getSchedule(db, schedule.id)!;
    assert.equal(back.name, "Gym", "put back, not merely un-deleted");
    assert.equal(back.amount, -rupees(1_500));
    assert.equal(back.recurrence, "monthly");
  });
});

describe("F7 · money coming in is a schedule too", () => {
  test("a salary raises the projected balance instead of lowering it", () => {
    const { db, bank, bills } = setup();
    createSchedule(db, actor, {
      name: "Salary", amount: rupees(78_000), recurrence: "monthly",
      nextDue: addDays(todayIST(), 5), accountId: bank,
    });

    const flow = projectCashflow(db, { days: 40 });
    const day = flow.days.find((d) => d.inflows.some((i) => i.label.includes("Salary")));
    assert.ok(day, "it is an inflow, not an outflow");
    assert.ok(
      day!.projectedBalance > flow.openingBalance,
      "and the projection goes up on the day it lands",
    );
  });

  test("an outgoing still lowers it", () => {
    const { db, bank, bills } = setup();
    createSchedule(db, actor, {
      name: "Rent", amount: -rupees(38_000), recurrence: "monthly",
      nextDue: addDays(todayIST(), 5), accountId: bank, categoryId: bills,
    });
    const flow = projectCashflow(db, { days: 40 });
    const day = flow.days.find((d) => d.outflows.some((o) => o.label.includes("Rent")))!;
    assert.ok(day, "an outflow");
    assert.ok(day.projectedBalance < flow.openingBalance);
  });
});

describe("A card due on the 31st, in a month that has no 31st", () => {
  test("the projection puts it on the last day of February", () => {
    const { db, bills } = setup();
    createAccount(db, actor, {
      name: "Joint current", kind: "budget", subtype: "savings",
      openingBalance: rupees(1_00_000), openingDate: "2026-01-01",
    });
    const card = createAccount(db, actor, {
      name: "HDFC Regalia", kind: "credit", subtype: "credit-card",
      openingBalance: -rupees(12_000), openingDate: "2026-01-01",
      dueDay: 31,
    });
    // Something charged to the card after February's due date is paid at
    // March's. (The ₹12,000 owed today is paid once — S5: it used to be
    // charged again on 31 March, which this test once asserted.)
    createSchedule(db, actor, {
      name: "Insurance", amount: -rupees(2_000), recurrence: "yearly",
      nextDue: "2026-03-05", accountId: card.id, categoryId: bills,
    });

    // Standing on 1 February, looking far enough ahead to see March too.
    const flow = projectCashflow(db, { days: 60, today: "2026-02-01" });
    const dues = flow.days
      .filter((d) => d.outflows.some((o) => o.label.includes("HDFC Regalia")))
      .map((d) => d.date);

    assert.deepEqual(dues, ["2026-02-28", "2026-03-31"], "28 Feb, and the 31st where the month has one");
    db.close();
  });

  test("in a leap year it is the 29th", () => {
    const { db } = setup();
    createAccount(db, actor, {
      name: "Joint current", kind: "budget", subtype: "savings",
      openingBalance: rupees(1_00_000), openingDate: "2024-01-01",
    });
    createAccount(db, actor, {
      name: "HDFC Regalia", kind: "credit", subtype: "credit-card",
      openingBalance: -rupees(12_000), openingDate: "2024-01-01", dueDay: 31,
    });

    const flow = projectCashflow(db, { days: 40, today: "2024-02-01" });
    const dues = flow.days
      .filter((d) => d.outflows.some((o) => o.label.includes("HDFC Regalia")))
      .map((d) => d.date);
    assert.ok(dues.includes("2024-02-29"), `expected 29 Feb, got ${dues.join(", ")}`);
    db.close();
  });
});
