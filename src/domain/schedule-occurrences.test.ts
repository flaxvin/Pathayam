/**
 * Where a schedule goes after this occurrence.
 *
 * S1 · The "skip" short-month policy ended a schedule at the first short month.
 * A rent on the 31st from 31 Jan 2026 was "next due never" once February came
 * round: resolveDayOfMonth answers null for a month without the day, and that
 * null was stored as next_due. The same for the 29th, quarterly from 30 Nov and
 * yearly on 29 Feb — and the cashflow projection then showed the schedule once
 * a year. "Skip" means skip that month and carry on.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import {
  createSchedule, getSchedule, updateSchedule, skipOccurrence, markPaid, projectCashflow,
  nextOccurrence, detectSchedules,
  type Recurrence, type Schedule,
} from "./schedules.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { IsoDate } from "../core/dates.ts";
import { execute } from "../db/db.ts";
import { historyFor, undoEvent } from "../core/events.ts";
import { createTransaction } from "./transactions.ts";
import { ensurePersonalBudget, householdBudgetId } from "./budgets.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(100_000),
  }).id;
  const g = createGroup(db, actor, "Home");
  const rent = createCategory(db, actor, { groupId: g.id, name: "Rent" }).id;
  return { db, bank, rent };
}

function schedule(
  ctx: ReturnType<typeof setup>, recurrence: Recurrence, nextDue: string,
  policy: Schedule["short_month_policy"],
) {
  return createSchedule(ctx.db, actor, {
    name: "Rent", accountId: ctx.bank, categoryId: ctx.rent,
    amount: -rupees(100) as Paise, recurrence, nextDue: nextDue as IsoDate,
    shortMonthPolicy: policy,
  });
}

/** Skip `count` occurrences in a row and return every next_due seen. */
function walk(ctx: ReturnType<typeof setup>, id: string, count: number): (string | null)[] {
  const seen: (string | null)[] = [getSchedule(ctx.db, id)!.next_due];
  for (let i = 0; i < count; i++) {
    skipOccurrence(ctx.db, actor, id);
    seen.push(getSchedule(ctx.db, id)!.next_due);
  }
  return seen;
}

describe("S1 · 'skip' skips the short month and carries on", () => {
  test("monthly on the 31st: February and the 30-day months are skipped, not the schedule", () => {
    const ctx = setup();
    const s = schedule(ctx, "monthly", "2026-01-31", "skip");
    assert.deepEqual(
      walk(ctx, s.id, 5),
      ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31", "2026-08-31", "2026-10-31"],
      "the schedule ended at February (next due never)",
    );
  });

  test("monthly on the 29th skips February 2026 only", () => {
    const ctx = setup();
    const s = schedule(ctx, "monthly", "2026-01-29", "skip");
    assert.deepEqual(walk(ctx, s.id, 2), ["2026-01-29", "2026-03-29", "2026-04-29"]);
  });

  test("quarterly from 30 Nov skips the February occurrence", () => {
    const ctx = setup();
    const s = schedule(ctx, "quarterly", "2025-11-30", "skip");
    assert.deepEqual(walk(ctx, s.id, 2), ["2025-11-30", "2026-05-30", "2026-08-30"]);
  });

  test("yearly on 29 Feb comes back in the next leap year", () => {
    const ctx = setup();
    const s = schedule(ctx, "yearly", "2028-02-29", "skip");
    assert.deepEqual(walk(ctx, s.id, 1), ["2028-02-29", "2032-02-29"]);
  });

  test("marking it paid on the due date moves on the same way", () => {
    const ctx = setup();
    const s = schedule(ctx, "monthly", "2026-01-31", "skip");
    markPaid(ctx.db, actor, s.id, "2026-01-31" as IsoDate);
    assert.equal(getSchedule(ctx.db, s.id)!.next_due, "2026-03-31");
  });

  test("the projection shows it every month that has the day, not once", () => {
    const ctx = setup();
    schedule(ctx, "monthly", "2027-01-31", "skip");
    const cash = projectCashflow(ctx.db, { today: "2027-01-01" as IsoDate, days: 365 });
    const dates = cash.days.filter((d) => d.outflows.some((o) => o.label === "Rent")).map((d) => d.date);
    assert.deepEqual(dates, [
      "2027-01-31", "2027-03-31", "2027-05-31", "2027-07-31", "2027-08-31",
      "2027-10-31", "2027-12-31",
    ]);
  });
});

/*
 * S2 · Month-based schedules lost their anchor day. The day was read from the
 * current next_due, which is where the last occurrence *landed*: 31 Jan went to
 * 28 Feb, then 28 Mar, 28 Apr and the 28th for ever. Quarterly from 30 Nov sat
 * on the 28th after February; yearly 29 Feb 2028 was 28 Feb even in 2032; and
 * "next-day" put a 31st on the 1st of every month. The anchor day is now kept
 * in its own column (recurrence_day). The migration is added separately, so
 * these tests add the column themselves — exactly the ALTER the lead applies.
 */
function anchored() {
  const ctx = setup();
  execute(ctx.db, `ALTER TABLE schedules ADD COLUMN recurrence_day INTEGER`);
  return ctx;
}

describe("S2 · a month-based schedule keeps the day it was set to", () => {
  test("monthly on the 31st goes back to the 31st after February", () => {
    const ctx = anchored();
    const s = schedule(ctx, "monthly", "2026-01-31", "last-day");
    assert.deepEqual(
      walk(ctx, s.id, 4),
      ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"],
      "it stayed on the 28th after February",
    );
  });

  test("monthly on the 30th", () => {
    const ctx = anchored();
    const s = schedule(ctx, "monthly", "2026-01-30", "last-day");
    assert.deepEqual(walk(ctx, s.id, 2), ["2026-01-30", "2026-02-28", "2026-03-30"]);
  });

  test("quarterly from 30 Nov and half-yearly from 31 Aug", () => {
    const ctx = anchored();
    const q = schedule(ctx, "quarterly", "2025-11-30", "last-day");
    assert.deepEqual(walk(ctx, q.id, 3), ["2025-11-30", "2026-02-28", "2026-05-30", "2026-08-30"]);
    const h = schedule(ctx, "half-yearly", "2025-08-31", "last-day");
    assert.deepEqual(walk(ctx, h.id, 2), ["2025-08-31", "2026-02-28", "2026-08-31"]);
  });

  test("yearly on 29 Feb is 29 Feb again in 2032", () => {
    const ctx = anchored();
    const s = schedule(ctx, "yearly", "2028-02-29", "last-day");
    assert.deepEqual(
      walk(ctx, s.id, 4),
      ["2028-02-29", "2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29"],
    );
  });

  test("'next-day' spills into the 1st only in the month that needs it", () => {
    const ctx = anchored();
    const s = schedule(ctx, "monthly", "2026-01-31", "next-day");
    assert.deepEqual(
      walk(ctx, s.id, 7),
      ["2026-01-31", "2026-03-01", "2026-03-31", "2026-05-01", "2026-05-31",
        "2026-07-01", "2026-07-31", "2026-08-31"],
      "it moved to the 1st for good (or skipped March's own 31st)",
    );
    const y = schedule(ctx, "yearly", "2028-02-29", "next-day");
    assert.deepEqual(
      walk(ctx, y.id, 4),
      ["2028-02-29", "2029-03-01", "2030-03-01", "2031-03-01", "2032-02-29"],
    );
  });

  test("the projection follows the anchor too", () => {
    const ctx = anchored();
    schedule(ctx, "monthly", "2027-01-31", "last-day");
    const cash = projectCashflow(ctx.db, { today: "2027-01-01" as IsoDate, days: 120 });
    const dates = cash.days.filter((d) => d.outflows.some((o) => o.label === "Rent")).map((d) => d.date);
    assert.deepEqual(dates, ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
  });

  test("editing the amount does not re-anchor the rent on the 28th", () => {
    // The edit form posts next_due back as it stands — 28 Feb for a 31st rent.
    const ctx = anchored();
    const s = schedule(ctx, "monthly", "2026-01-31", "last-day");
    skipOccurrence(ctx.db, actor, s.id);
    updateSchedule(ctx.db, actor, s.id, {
      amount: -rupees(200) as Paise, next_due: "2026-02-28" as IsoDate,
    });
    skipOccurrence(ctx.db, actor, s.id);
    assert.equal(getSchedule(ctx.db, s.id)!.next_due, "2026-03-31");
  });

  test("moving the due date moves the anchor, and undoing the move puts it back", () => {
    const ctx = anchored();
    const s = schedule(ctx, "monthly", "2026-01-31", "last-day");
    updateSchedule(ctx.db, actor, s.id, { next_due: "2026-03-15" as IsoDate });
    assert.equal(getSchedule(ctx.db, s.id)!.recurrence_day, 15);
    const edit = historyFor(ctx.db, "schedule", s.id).find((e) => e.action === "update")!;
    assert.ok(undoEvent(ctx.db, edit.id, actor).ok);
    assert.equal(getSchedule(ctx.db, s.id)!.recurrence_day, 31);
  });

  test("without the column it still advances, reading the day from next_due", () => {
    const ctx = setup();
    const s = schedule(ctx, "monthly", "2026-01-15", "last-day");
    assert.equal(getSchedule(ctx.db, s.id)!.recurrence_day, undefined);
    assert.deepEqual(walk(ctx, s.id, 2), ["2026-01-15", "2026-02-15", "2026-03-15"]);
  });
});

/*
 * S3 · Marking an occurrence paid late re-based the schedule on the payment
 * date. Quarterly due 15 Mar paid 2 Apr went to 15 Jul — the Mar/Jun/Sep/Dec
 * cycle became Apr/Jul/Oct/Jan for good; monthly due 31 Jan paid 2 Feb went to
 * 31 Mar and February's occurrence vanished; due 15 Mar paid 20 Apr went to
 * 15 May and April's never came due; a weekly Monday paid on Wednesday became a
 * Wednesday schedule.
 */
describe("S3 · paying late settles the occurrence that was due", () => {
  function paidOn(
    ctx: ReturnType<typeof setup>, recurrence: Recurrence, due: string, on: string,
  ): string | null {
    const s = schedule(ctx, recurrence, due, "last-day");
    markPaid(ctx.db, actor, s.id, on as IsoDate);
    return getSchedule(ctx.db, s.id)!.next_due;
  }

  test("quarterly due 15 Mar paid 2 Apr is next due 15 Jun, not 15 Jul", () => {
    assert.equal(paidOn(setup(), "quarterly", "2026-03-15", "2026-04-02"), "2026-06-15");
  });

  test("monthly due 31 Jan paid 2 Feb keeps February's occurrence", () => {
    assert.equal(paidOn(anchored(), "monthly", "2026-01-31", "2026-02-02"), "2026-02-28");
  });

  test("monthly due 15 Mar paid 20 Apr leaves April's 15th due", () => {
    assert.equal(paidOn(setup(), "monthly", "2026-03-15", "2026-04-20"), "2026-04-15");
  });

  test("a weekly Monday paid on Wednesday is still a Monday schedule", () => {
    // 1 June 2026 is a Monday.
    assert.equal(paidOn(setup(), "weekly", "2026-06-01", "2026-06-03"), "2026-06-08");
  });

  test("paying early still moves on from the due date", () => {
    assert.equal(paidOn(setup(), "monthly", "2026-03-15", "2026-03-10"), "2026-04-15");
  });

  test("the transaction is still dated the day it was paid", () => {
    const ctx = setup();
    const s = schedule(ctx, "monthly", "2026-03-15", "last-day");
    markPaid(ctx.db, actor, s.id, "2026-04-02" as IsoDate);
    const posted = historyFor(ctx.db, "schedule", s.id).find((e) => e.action === "mark-paid")!;
    const txnId = (posted.after as { transactionId: string }).transactionId;
    const row = ctx.db.prepare(`SELECT date FROM transactions WHERE id = ?`).get(txnId) as { date: string };
    assert.equal(row.date, "2026-04-02");
  });

  test("an overdue schedule rolls forward along its own days", () => {
    // Salary on the 26th, last ticked off 26 Aug; asked on 25 Sep. September's
    // payday is still ahead — it used to answer 26 Oct.
    const ctx = setup();
    const s = schedule(ctx, "monthly", "2026-08-26", "last-day");
    assert.equal(nextOccurrence(s, "2026-09-25" as IsoDate), "2026-09-26");
    const w = schedule(ctx, "weekly", "2026-06-01", "last-day");
    assert.equal(nextOccurrence(w, "2026-06-10" as IsoDate), "2026-06-15", "a Monday, not a Wednesday");
  });
});

/*
 * S4 · detectSchedules proposed every recurring payee as money going out. Five
 * ₹85,000 credits from "Employer Pvt Ltd" on the 1st of May–Sep 2026 came back
 * as amount −₹85,000 — accept it and markPaid posts an ₹85,000 expense every
 * month. Its next due was 2 Oct (last + the 30.75-day average gap), not 1 Oct.
 */
describe("S4 · a detected schedule keeps the direction it was seen in", () => {
  function seed(ctx: ReturnType<typeof setup>, payee: string, rows: [string, number][]) {
    for (const [date, amount] of rows) {
      createTransaction(ctx.db, actor, {
        accountId: ctx.bank, amount: amount as Paise, date: date as IsoDate,
        payeeName: payee, categoryId: amount < 0 ? ctx.rent : null,
      });
    }
  }

  test("a salary is proposed as money coming in, on the 1st", () => {
    const ctx = setup();
    seed(ctx, "Employer Pvt Ltd", [
      ["2026-05-01", 8_500_000], ["2026-06-01", 8_500_000], ["2026-07-01", 8_500_000],
      ["2026-08-01", 8_500_000], ["2026-09-01", 8_500_000],
    ]);
    const [salary] = detectSchedules(ctx.db, "2026-09-25" as IsoDate);
    assert.ok(salary);
    assert.equal(salary.amount, 8_500_000, "an ₹85,000 salary was proposed as an ₹85,000 expense");
    assert.equal(salary.recurrence, "monthly");
    assert.equal(salary.nextDue, "2026-10-01");

    // Accepted and marked arrived, it is income.
    const s = createSchedule(ctx.db, actor, {
      name: salary.payeeName, payeeId: salary.payeeId, accountId: salary.accountId,
      amount: salary.amount, recurrence: salary.recurrence, nextDue: salary.nextDue,
    });
    markPaid(ctx.db, actor, s.id, "2026-10-01" as IsoDate);
    const row = ctx.db.prepare(
      `SELECT amount FROM transactions WHERE date = '2026-10-01' AND deleted_at IS NULL`,
    ).get() as { amount: number };
    assert.equal(row.amount, 8_500_000);
  });

  test("a bill is still money going out", () => {
    const ctx = setup();
    seed(ctx, "Broadband", [
      ["2026-06-10", -99_900], ["2026-07-10", -99_900], ["2026-08-10", -99_900], ["2026-09-10", -99_900],
    ]);
    const [bill] = detectSchedules(ctx.db, "2026-09-25" as IsoDate);
    assert.equal(bill!.amount, -99_900);
    assert.equal(bill!.nextDue, "2026-10-10");
  });

  test("an odd refund is not averaged in as a payment", () => {
    const ctx = setup();
    seed(ctx, "Milk Co", [
      ["2026-06-05", -300_000], ["2026-07-05", -300_000], ["2026-07-20", 50_000],
      ["2026-08-05", -300_000], ["2026-09-05", -300_000],
    ]);
    const [milk] = detectSchedules(ctx.db, "2026-09-25" as IsoDate);
    assert.ok(milk, "the refund broke the monthly rhythm");
    assert.equal(milk.amount, -300_000);
    assert.equal(milk.confidence, "high");
  });
});

/*
 * S5 · projectCashflow charged a card's whole current balance again on every due
 * date in the horizon: a card owing ₹10,000, due on the 5th, projected ₹10,000
 * out on 5 Oct, 5 Nov and 5 Dec — lowest ₹70,000 from ₹1,00,000 instead of
 * ₹90,000. And a ₹649 subscription billed to the card cost cash on its own
 * date in the combined projection (lowest ₹89,351) and nothing at all in the
 * household one (₹90,000).
 */
describe("S5 · a card is paid once, on its due date, in every scope", () => {
  function withCard(ctx: ReturnType<typeof setup>, budgetId?: string) {
    const card = createAccount(ctx.db, actor, {
      name: "Card", kind: "credit", subtype: "credit-card", openingDate: "2025-01-01",
      statementDay: 20, dueDay: 5, ...(budgetId ? { budgetId } : {}),
    }).id;
    createTransaction(ctx.db, actor, {
      accountId: card, amount: -rupees(10_000) as Paise, date: "2026-09-10" as IsoDate, categoryId: ctx.rent,
    });
    return card;
  }
  const outflows = (cf: ReturnType<typeof projectCashflow>) =>
    cf.days.flatMap((d) => d.outflows.map((o) => `${d.date} ${o.label} ${o.amount}`));

  test("what the card owes today leaves once, at the next due date", () => {
    const ctx = setup();
    withCard(ctx);
    const cf = projectCashflow(ctx.db, { today: "2026-09-25" as IsoDate, days: 90 });
    assert.deepEqual(outflows(cf), ["2026-10-05 Card due 1000000"], "charged on 5 Oct, 5 Nov and 5 Dec");
    assert.equal(cf.lowestBalance, rupees(90_000));
  });

  test("a subscription on the card leaves cash on the due date its statement falls into", () => {
    const ctx = setup();
    const card = withCard(ctx);
    createSchedule(ctx.db, actor, {
      name: "StreamCo", accountId: card, categoryId: ctx.rent,
      amount: -64_900 as Paise, recurrence: "monthly", nextDue: "2026-10-12" as IsoDate,
    });
    const all = projectCashflow(ctx.db, { today: "2026-09-25" as IsoDate, days: 60 });
    // 12 Oct is on the statement of 20 Oct, due 5 Nov; 12 Nov on 20 Nov's, due 5 Dec.
    assert.deepEqual(outflows(all), [
      "2026-10-05 Card due 1000000",
      "2026-11-05 StreamCo (Card) 64900",
    ]);
    const household = projectCashflow(ctx.db, {
      today: "2026-09-25" as IsoDate, days: 60, budgetId: householdBudgetId(ctx.db),
    });
    assert.equal(household.lowestBalance, all.lowestBalance, "the household view ignored the card schedule");
    assert.equal(all.lowestBalance, rupees(90_000) - 64_900);
  });

  test("another budget's card is not paid out of the household's cash", () => {
    const ctx = setup();
    const mine = ensurePersonalBudget(ctx.db, "m-ravi", "Ravi");
    withCard(ctx, mine.id);
    const household = projectCashflow(ctx.db, {
      today: "2026-09-25" as IsoDate, days: 60, budgetId: householdBudgetId(ctx.db),
    });
    assert.deepEqual(outflows(household), []);
  });
});
