/**
 * F7 · Schedules, bills and the cashflow calendar.
 *
 * `05` §2 calls the cashflow calendar "the single most differentiating feature
 * versus YNAB and Actual". It answers one question the envelope model cannot:
 * *will I make it to the 30th?* Envelopes say whether money is allocated;
 * they say nothing about whether it is in the account on the day the standing
 * instruction fires.
 */

import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, registerUndoHandler, type Actor } from "../core/events.ts";
import {
  nowIST, todayIST, addDays, addMonths, monthOf, daysBetween, resolveDayOfMonth,
  formatDate, type IsoDate,
} from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import { accountBalances } from "../engine/repository.ts";
import { listLoans, projectLoan } from "./loans.ts";

export type Recurrence =
  | "daily" | "weekly" | "fortnightly" | "monthly" | "monthly-nth-weekday"
  | "quarterly" | "half-yearly" | "yearly";

export interface Schedule {
  id: string;
  name: string;
  account_id: string | null;
  payee_id: string | null;
  category_id: string | null;
  amount: Paise | null;
  amount_is_estimate: number;
  recurrence: Recurrence;
  next_due: IsoDate | null;
  short_month_policy: "last-day" | "skip" | "next-day";
  auto_post: number;
  is_subscription: number;
  /** F7.8: a detected schedule is distinguished from a confirmed one. */
  detected: number;
  confidence: string | null;
  enabled: number;
}

export function createSchedule(
  db: DB, actor: Actor,
  input: {
    name: string;
    accountId?: string | null;
    payeeId?: string | null;
    categoryId?: string | null;
    amount?: Paise | null;
    amountIsEstimate?: boolean;
    recurrence: Recurrence;
    nextDue: IsoDate;
    shortMonthPolicy?: Schedule["short_month_policy"];
    isSubscription?: boolean;
    detected?: boolean;
    confidence?: string | null;
  },
): Schedule {
  return transact(db, () => {
    const id = newId();
    execute(
      db,
      `INSERT INTO schedules
         (id,name,account_id,payee_id,category_id,amount,amount_is_estimate,recurrence,
          next_due,short_month_policy,is_subscription,detected,confidence,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, input.name, input.accountId ?? null, input.payeeId ?? null, input.categoryId ?? null,
      input.amount ?? null, input.amountIsEstimate ? 1 : 0, input.recurrence,
      input.nextDue, input.shortMonthPolicy ?? "last-day",
      input.isSubscription ? 1 : 0, input.detected ? 1 : 0, input.confidence ?? null,
      nowIST(),
    );

    const schedule = getSchedule(db, id)!;
    appendEvent(db, actor, {
      entity: "schedule", entityId: id, action: "create", after: schedule,
      summary: `Added a ${input.recurrence} schedule for ${input.name}`,
    });
    return schedule;
  });
}

export function getSchedule(db: DB, id: string): Schedule | null {
  return queryOne<Schedule>(db, `SELECT * FROM schedules WHERE id = ?`, id);
}

export function listSchedules(db: DB, opts: { includeDisabled?: boolean } = {}): Schedule[] {
  return queryAll<Schedule>(
    db,
    `SELECT * FROM schedules ${opts.includeDisabled ? "" : "WHERE enabled = 1"}
      ORDER BY next_due IS NULL, next_due`,
  );
}

/** F7.2 · Advance a schedule to its next occurrence. */
export function nextOccurrence(schedule: Schedule, after: IsoDate): IsoDate | null {
  const from = schedule.next_due && schedule.next_due > after ? schedule.next_due : after;

  switch (schedule.recurrence) {
    case "daily": return addDays(from, 1);
    case "weekly": return addDays(from, 7);
    case "fortnightly": return addDays(from, 14);
    case "quarterly": return shiftMonthsKeepingDay(schedule, from, 3);
    case "half-yearly": return shiftMonthsKeepingDay(schedule, from, 6);
    case "yearly": return shiftMonthsKeepingDay(schedule, from, 12);
    default: return shiftMonthsKeepingDay(schedule, from, 1);
  }
}

/**
 * F7.3 · The 29th–31st on a short month resolves by the schedule's own policy,
 * rather than silently sliding to a date the household did not choose.
 */
function shiftMonthsKeepingDay(schedule: Schedule, from: IsoDate, months: number): IsoDate | null {
  const day = Number((schedule.next_due ?? from).slice(8, 10));
  return resolveDayOfMonth(addMonths(monthOf(from), months), day, schedule.short_month_policy);
}

/** F7.5 · Mark an occurrence paid, and move the schedule on. */
export function markPaid(db: DB, actor: Actor, scheduleId: string, on: IsoDate = todayIST()): void {
  transact(db, () => {
    const schedule = getSchedule(db, scheduleId);
    if (!schedule) throw new Error("That schedule does not exist.");
    const next = nextOccurrence(schedule, on);
    execute(db, `UPDATE schedules SET next_due = ? WHERE id = ?`, next, scheduleId);
    appendEvent(db, actor, {
      entity: "schedule", entityId: scheduleId, action: "mark-paid",
      before: { nextDue: schedule.next_due }, after: { nextDue: next },
      summary: `Marked ${schedule.name} paid; next due ${next ? formatDate(next) : "never"}`,
    });
  });
}

/** F7.5 · Skip this occurrence without altering the schedule itself. */
export function skipOccurrence(db: DB, actor: Actor, scheduleId: string): void {
  transact(db, () => {
    const schedule = getSchedule(db, scheduleId);
    if (!schedule?.next_due) throw new Error("That schedule has nothing due.");
    const next = nextOccurrence(schedule, schedule.next_due);
    execute(db, `UPDATE schedules SET next_due = ? WHERE id = ?`, next, scheduleId);
    appendEvent(db, actor, {
      entity: "schedule", entityId: scheduleId, action: "skip",
      before: { nextDue: schedule.next_due }, after: { nextDue: next },
      summary: `Skipped one ${schedule.name} occurrence`,
    });
  });
}

// ---------------------------------------------------------------------------
// F7.6 · Detecting a recurring transaction from history
// ---------------------------------------------------------------------------

export interface DetectedSchedule {
  payeeId: string;
  payeeName: string;
  categoryId: string | null;
  accountId: string;
  amount: Paise;
  recurrence: Recurrence;
  nextDue: IsoDate;
  /** F7.6: shown so the user can judge, never hidden behind a number. */
  confidence: "high" | "medium" | "low";
  occurrences: number;
}

/**
 * Propose schedules from what has actually happened.
 *
 * Frequency heuristics over the household's own history, not a model — the
 * same reasoning as `04` §7: explainable, needs no training data, and more
 * accurate at this scale.
 */
export function detectSchedules(db: DB, today = todayIST()): DetectedSchedule[] {
  const rows = queryAll<{
    payee_id: string; payee: string; account_id: string; category_id: string | null;
    date: string; amount: number;
  }>(
    db,
    `SELECT t.payee_id, p.name AS payee, t.account_id, t.category_id, t.date, t.amount
       FROM transactions t JOIN payees p ON p.id = t.payee_id
      WHERE t.deleted_at IS NULL AND t.transfer_pair_id IS NULL
        AND t.payee_id IS NOT NULL AND t.date >= ?
      ORDER BY t.payee_id, t.date`,
    addDays(today, -400),
  );

  const byPayee = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byPayee.get(row.payee_id) ?? [];
    list.push(row);
    byPayee.set(row.payee_id, list);
  }

  const existing = new Set(
    listSchedules(db, { includeDisabled: true }).map((s) => s.payee_id).filter(Boolean),
  );

  const detected: DetectedSchedule[] = [];

  for (const [payeeId, occurrences] of byPayee) {
    if (occurrences.length < 3 || existing.has(payeeId)) continue;

    const gaps: number[] = [];
    for (let i = 1; i < occurrences.length; i++) {
      gaps.push(daysBetween(occurrences[i - 1]!.date, occurrences[i]!.date));
    }

    const average = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const spread = Math.max(...gaps) - Math.min(...gaps);
    const recurrence = recurrenceForGap(average);
    if (!recurrence) continue;

    const amounts = occurrences.map((o) => Math.abs(o.amount));
    const amountSpread = Math.max(...amounts) - Math.min(...amounts);
    const typical = Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length);

    // A tight gap and a steady amount is a standing instruction; a loose one
    // is a habit, and saying so is more useful than pretending to be sure.
    const confidence: DetectedSchedule["confidence"] =
      spread <= 3 && amountSpread <= typical * 0.02 ? "high"
      : spread <= 8 ? "medium"
      : "low";

    const last = occurrences.at(-1)!;
    detected.push({
      payeeId,
      payeeName: last.payee,
      categoryId: last.category_id,
      accountId: last.account_id,
      amount: -typical,
      recurrence,
      nextDue: addDays(last.date, Math.round(average)),
      confidence,
      occurrences: occurrences.length,
    });
  }

  return detected.sort((a, b) => b.occurrences - a.occurrences);
}

function recurrenceForGap(days: number): Recurrence | null {
  if (days >= 6 && days <= 8) return "weekly";
  if (days >= 13 && days <= 16) return "fortnightly";
  if (days >= 27 && days <= 32) return "monthly";
  if (days >= 88 && days <= 95) return "quarterly";
  if (days >= 178 && days <= 190) return "half-yearly";
  if (days >= 358 && days <= 372) return "yearly";
  return null;
}

// ---------------------------------------------------------------------------
// F7.7 · The cashflow calendar
// ---------------------------------------------------------------------------

export interface CalendarDay {
  date: IsoDate;
  inflows: { label: string; amount: Paise; confirmed: boolean }[];
  outflows: { label: string; amount: Paise; confirmed: boolean }[];
  /** Projected Budget-account balance at the end of this day. */
  projectedBalance: Paise;
  /** F7.7: flagged when the projection dips below the configured floor. */
  belowFloor: boolean;
  negative: boolean;
}

export interface Cashflow {
  days: CalendarDay[];
  openingBalance: Paise;
  floor: Paise;
  /** The first day the projection goes under. The answer to "will I make it?" */
  firstShortfall: IsoDate | null;
  lowestBalance: Paise;
  lowestOn: IsoDate | null;
}

/**
 * F7.7 · A forward view of Budget-account balances against what is due.
 *
 * Loan instalments and card due dates are included, because a calendar that
 * omits the largest outgoings answers the wrong question.
 */
export function projectCashflow(
  db: DB, opts: { days?: number; floor?: Paise; today?: IsoDate } = {},
): Cashflow {
  const today = opts.today ?? todayIST();
  const horizon = opts.days ?? 60;
  const floor = opts.floor ?? 0;

  // Only Budget accounts: a card's balance is a liability, and a loan's is
  // not spendable either. The calendar is about cash on hand (R1).
  const balances = accountBalances(db);
  const budgetAccounts = queryAll<{ id: string }>(
    db, `SELECT id FROM accounts WHERE kind = 'budget' AND closed_at IS NULL`,
  );
  let balance = budgetAccounts.reduce((sum, a) => sum + (balances.get(a.id)?.working ?? 0), 0);

  const opening = balance;
  const byDate = new Map<IsoDate, CalendarDay>();
  const dayFor = (date: IsoDate): CalendarDay => {
    let day = byDate.get(date);
    if (!day) {
      day = { date, inflows: [], outflows: [], projectedBalance: 0, belowFloor: false, negative: false };
      byDate.set(date, day);
    }
    return day;
  };

  const end = addDays(today, horizon);

  // Confirmed and detected schedules, distinguished (F7.8).
  for (const schedule of listSchedules(db)) {
    if (!schedule.next_due || schedule.amount === null) continue;
    let due: IsoDate | null = schedule.next_due;
    for (let guard = 0; due && due <= end && guard < 400; guard++) {
      if (due >= today) {
        const day = dayFor(due);
        const entry = {
          label: schedule.name,
          amount: Math.abs(schedule.amount),
          confirmed: schedule.detected === 0,
        };
        if (schedule.amount > 0) day.inflows.push(entry);
        else day.outflows.push(entry);
      }
      due = nextOccurrence(schedule, due);
    }
  }

  // Loan instalments — usually the largest single outgoing in the month.
  for (const loan of listLoans(db)) {
    const projection = projectLoan(db, loan.id);
    if (!projection) continue;
    for (const instalment of projection.schedule.instalments) {
      if (!instalment.dueDate || instalment.dueDate < today || instalment.dueDate > end) continue;
      dayFor(instalment.dueDate).outflows.push({
        label: `${loan.nickname || loan.lender} instalment`,
        amount: instalment.payment,
        confirmed: true,
      });
    }
  }

  // Card due dates, with the statement balance as the expected payment.
  for (const card of queryAll<{ id: string; name: string; due_day: number | null }>(
    db, `SELECT id, name, due_day FROM accounts WHERE kind = 'credit' AND closed_at IS NULL`,
  )) {
    if (!card.due_day) continue;
    const owed = Math.max(0, -(balances.get(card.id)?.working ?? 0));
    if (owed === 0) continue;
    for (let m = 0; m < Math.ceil(horizon / 28) + 1; m++) {
      const due = resolveDayOfMonth(addMonths(monthOf(today), m), card.due_day, "last-day");
      if (!due || due < today || due > end) continue;
      dayFor(due).outflows.push({ label: `${card.name} due`, amount: owed, confirmed: true });
    }
  }

  const days: CalendarDay[] = [];
  let firstShortfall: IsoDate | null = null;
  let lowest = balance;
  let lowestOn: IsoDate | null = null;

  for (let i = 0; i <= horizon; i++) {
    const date = addDays(today, i);
    const day = byDate.get(date) ?? {
      date, inflows: [], outflows: [], projectedBalance: 0, belowFloor: false, negative: false,
    };

    balance += day.inflows.reduce((sum, f) => sum + f.amount, 0);
    balance -= day.outflows.reduce((sum, f) => sum + f.amount, 0);

    day.projectedBalance = balance;
    day.belowFloor = balance < floor;
    day.negative = balance < 0;

    if (day.belowFloor && !firstShortfall) firstShortfall = date;
    if (balance < lowest) { lowest = balance; lowestOn = date; }

    days.push(day);
  }

  return { days, openingBalance: opening, floor, firstShortfall, lowestBalance: lowest, lowestOn };
}

/** F7.9 · Subscriptions, with what they actually cost per year. */
export function subscriptions(db: DB): { schedule: Schedule; annualised: Paise }[] {
  return listSchedules(db)
    .filter((s) => s.is_subscription === 1 && s.amount !== null)
    .map((s) => ({ schedule: s, annualised: annualise(s.amount!, s.recurrence) }))
    .sort((a, b) => b.annualised - a.annualised);
}

function annualise(amount: Paise, recurrence: Recurrence): Paise {
  const perYear: Record<Recurrence, number> = {
    daily: 365, weekly: 52, fortnightly: 26, monthly: 12,
    "monthly-nth-weekday": 12, quarterly: 4, "half-yearly": 2, yearly: 1,
  };
  return Math.abs(amount) * perYear[recurrence];
}

export function describeCashflow(cashflow: Cashflow): string {
  if (!cashflow.firstShortfall) {
    return (
      `Nothing due in the next ${cashflow.days.length - 1} days takes you below ` +
      `${formatPaise(cashflow.floor)}. The lowest you get is ` +
      `${formatPaise(cashflow.lowestBalance)}` +
      (cashflow.lowestOn ? ` on ${formatDate(cashflow.lowestOn)}` : "") + "."
    );
  }
  return (
    `On ${formatDate(cashflow.firstShortfall)} your projected balance drops below ` +
    `${formatPaise(cashflow.floor)}. The lowest point is ` +
    `${formatPaise(cashflow.lowestBalance)}` +
    (cashflow.lowestOn ? ` on ${formatDate(cashflow.lowestOn)}` : "") + "."
  );
}

registerUndoHandler("schedule", (db, event) => {
  const before = event.before as Schedule | undefined;
  if (!before) {
    execute(db, `DELETE FROM schedules WHERE id = ?`, event.entityId!);
    return `Removed the schedule that was added`;
  }
  execute(db, `UPDATE schedules SET next_due = ? WHERE id = ?`, before.next_due, event.entityId!);
  return `Set the schedule back to ${before.next_due}`;
});
