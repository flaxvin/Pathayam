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
import { Refusal } from "../core/refusal.ts";
import { createTransaction, refusePaymentCategories } from "./transactions.ts";

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

/**
 * B99, applied to schedules · Money going out names the envelope it comes from.
 *
 * The rule already held for a hand-entered transaction, and a schedule is a
 * transaction the app will post on your behalf — so letting one through without a
 * category is a way to manufacture exactly the uncategorised expenses B99 exists
 * to stop, one a month, for ever. It also makes F7.4 impossible: an upcoming
 * schedule cannot appear "against its category" on the budget screen when it has
 * none.
 *
 * Money coming in is exempt for B99's own reason: its job is to land in Ready to
 * Assign and wait to be given a job.
 */
/**
 * An outgoing schedule has to name where the money comes from — as one
 * envelope, or as the split lines that replace it.
 *
 * `hasSplits` is the second half of that and was missing: a schedule split
 * across envelopes carries no category of its own, by design, because the lines
 * carry them. Demanding one anyway meant a split schedule had to name an
 * envelope it would never post to.
 */
function requireEnvelopeForOutgoing(
  amount: Paise | null | undefined,
  categoryId: string | null | undefined,
  hasSplits = false,
): void {
  if ((amount ?? 0) < 0 && !categoryId && !hasSplits) {
    throw new Refusal(
      "Which envelope does this come out of? A scheduled payment posts itself " +
      "every month, so without one it would quietly build a queue of spending " +
      "with nothing recording where it went. Split it across envelopes instead " +
      "if it is more than one thing. Money coming in does not need any of this.",
    );
  }
}

export function createSchedule(
  db: DB, actor: Actor,
  input: {
    name: string;
    /** Set when split lines are about to be written in the same transaction. */
    splitsFollow?: boolean;
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
  /*
   * `splitsFollow` is the caller promising to set split lines in the same
   * transaction. A schedule cannot have lines before it exists, so the check
   * has to take the promise — and the route that makes it wraps both in one
   * transaction, so a refused split takes the schedule with it.
   */
  requireEnvelopeForOutgoing(input.amount, input.categoryId, input.splitsFollow === true);
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

/**
 * Change a schedule.
 *
 * There was no way to: a schedule was permanent from the moment it was created,
 * so a typo in the amount, a rent rise, or a subscription moving to a different
 * day all meant living with the wrong figure in the cashflow projection — the one
 * screen whose whole job is answering "will I make it to the 30th".
 */
export function updateSchedule(
  db: DB, actor: Actor, id: string,
  patch: Partial<Pick<Schedule,
    "name" | "amount" | "recurrence" | "next_due" | "category_id" | "account_id"
    | "short_month_policy" | "is_subscription" | "amount_is_estimate">>,
  /**
   * `splitsFollow` is the caller promising to write split lines in the same
   * transaction. Without it, an edit that turns a single-envelope schedule into
   * a split is refused halfway: the category is cleared before the lines that
   * replace it exist, so the envelope rule sees a schedule with neither.
   */
  opts: { splitsFollow?: boolean } = {},
): Schedule {
  return transact(db, () => {
    const before = getSchedule(db, id);
    if (!before) throw new Refusal("That schedule does not exist.");
    requireEnvelopeForOutgoing(
      patch.amount !== undefined ? patch.amount : before.amount,
      patch.category_id !== undefined ? patch.category_id : before.category_id,
      opts.splitsFollow === true || getScheduleSplits(db, id).length > 0,
    );

    // A key present but undefined means "not mentioned", not "set to null" — the
    // same trap that wrote NULLs into accounts (B107).
    const fields = (Object.keys(patch) as (keyof typeof patch)[])
      .filter((f) => patch[f] !== undefined);
    if (fields.length > 0) {
      execute(
        db,
        `UPDATE schedules SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`,
        ...fields.map((f) => patch[f] as never),
        id,
      );
    }

    const after = getSchedule(db, id)!;
    appendEvent(db, actor, {
      entity: "schedule", entityId: id, action: "update", before, after,
      summary: `Edited the schedule for ${after.name}`,
    });
    return after;
  });
}

/**
 * Remove a schedule.
 *
 * Nothing it ever did is touched: `markPaid` records real transactions, and those
 * are the household's history. This removes only the expectation of the next one,
 * which is what a cancelled subscription or a closed standing instruction means.
 */
export function deleteSchedule(db: DB, actor: Actor, id: string): void {
  transact(db, () => {
    const before = getSchedule(db, id);
    if (!before) throw new Refusal("That schedule does not exist.");
    execute(db, `DELETE FROM schedules WHERE id = ?`, id);
    appendEvent(db, actor, {
      entity: "schedule", entityId: id, action: "delete", before,
      summary: `Removed the schedule for ${before.name}`,
    });
  });
}

export function getSchedule(db: DB, id: string): Schedule | null {
  return queryOne<Schedule>(db, `SELECT * FROM schedules WHERE id = ?`, id);
}

export interface ScheduleSplit {
  id: string;
  category_id: string | null;
  amount: Paise;
  memo: string | null;
}

export function getScheduleSplits(db: DB, scheduleId: string): ScheduleSplit[] {
  return queryAll<ScheduleSplit>(
    db,
    `SELECT id, category_id, amount, memo FROM schedule_splits
      WHERE schedule_id = ? ORDER BY sort, rowid`,
    scheduleId,
  );
}

/**
 * Replace a schedule's split lines, or clear them by passing none.
 *
 * The lines must add up to the schedule's amount, for the same reason a
 * transaction's must: a split that does not reconcile is money the ledger
 * cannot account for, and a *recurring* one is that mistake made every month
 * until somebody notices.
 *
 * A schedule with no amount cannot be split at all — there is nothing to split.
 */
export function setScheduleSplits(
  db: DB, actor: Actor, scheduleId: string, lines: { categoryId: string | null; amount: Paise; memo?: string | null }[],
): void {
  transact(db, () => {
    const schedule = getSchedule(db, scheduleId);
    if (!schedule) throw new Refusal("That schedule does not exist.");

    const kept = lines.filter((l) => l.amount !== 0);

    /*
     * One line is not a split — it is a plain single-envelope schedule, and
     * saying so is what somebody means when they delete all but one line. It
     * used to be refused, which left them stuck: the lines form would not
     * accept one, and the envelope above was disabled because a split existed.
     * The only way back was to clear every line, which left an outgoing
     * schedule with no envelope at all.
     */
    if (kept.length === 1) {
      const only = kept[0]!;
      if (schedule.amount !== null && only.amount !== schedule.amount) {
        throw new Refusal(
          `That line is ${formatPaise(only.amount)}, but the schedule is ` +
          `${formatPaise(schedule.amount as Paise)}. A single line has to be the whole of it.`,
        );
      }
      refusePaymentCategories(db, [only.categoryId]);
      execute(db, `DELETE FROM schedule_splits WHERE schedule_id = ?`, scheduleId);
      execute(db, `UPDATE schedules SET category_id = ? WHERE id = ?`, only.categoryId, scheduleId);
      appendEvent(db, actor, {
        entity: "schedule", entityId: scheduleId, action: "update",
        after: { splits: 0, categoryId: only.categoryId },
        summary: `${schedule.name} is one envelope again`,
      });
      return;
    }

    /*
     * No lines at all, on an outgoing schedule with no envelope either. It
     * would post every month into nothing — which is precisely the queue of
     * unrecorded spending the envelope rule exists to prevent — so it is
     * refused rather than saved.
     */
    if (kept.length === 0 && (schedule.amount ?? 0) < 0 && !schedule.category_id) {
      throw new Refusal(
        "Removing the split would leave this schedule with no envelope at all, and it " +
        "posts itself every month. Either keep the lines, or leave one line for the " +
        "whole amount to make it a single envelope again.",
      );
    }

    if (kept.length > 0) {
      if (schedule.amount === null) {
        throw new Refusal(
          "This schedule has no amount, so there is nothing to split. Give it one first.",
        );
      }
      const total = kept.reduce((sum, l) => sum + l.amount, 0);
      if (total !== schedule.amount) {
        throw new Refusal(
          `The lines add up to ${formatPaise(total as Paise)}, but the schedule is ${formatPaise(schedule.amount as Paise)}.`,
        );
      }
      refusePaymentCategories(db, kept.map((l) => l.categoryId));
    }

    execute(db, `DELETE FROM schedule_splits WHERE schedule_id = ?`, scheduleId);
    kept.forEach((line, i) => {
      execute(
        db,
        `INSERT INTO schedule_splits (id, schedule_id, category_id, amount, memo, sort)
         VALUES (?,?,?,?,?,?)`,
        newId(), scheduleId, line.categoryId, line.amount, line.memo ?? null, i,
      );
    });

    appendEvent(db, actor, {
      entity: "schedule", entityId: scheduleId, action: "update",
      after: { splits: kept.length },
      summary: kept.length
        ? `Set ${schedule.name} to split across ${kept.length} envelopes`
        : `Removed the split from ${schedule.name}`,
    });
  });
}

export function listSchedules(db: DB, opts: { includeDisabled?: boolean } = {}): Schedule[] {
  return queryAll<Schedule>(
    db,
    `SELECT * FROM schedules ${opts.includeDisabled ? "" : "WHERE enabled = 1"}
      ORDER BY next_due IS NULL, next_due`,
  );
}

/**
 * N5 · When the next money arrives.
 *
 * A month can be fully assigned and still read as an emergency. On the 14th,
 * Ready to Assign says zero — "every rupee has a job", the app's own definition
 * of success — and directly under it eleven envelopes say "Not funded", because
 * the money for them arrives on the 26th. Both statements are true and together
 * they read as a contradiction: everything is assigned, and nothing is funded.
 *
 * The difference between an alarm and a schedule is a date. This is the date.
 *
 * Only money coming in, only into accounts this member may see, and only in
 * this budget: "your next income is on the 26th" is a promise about the cash
 * that will land in *this* Ready to Assign, and a salary paid into somebody
 * else's private account is neither visible nor available.
 */
export interface NextIncome {
  date: IsoDate;
  label: string;
  /** Null when the schedule is a reminder rather than a known amount. */
  amount: Paise | null;
}

export function nextIncome(
  db: DB,
  opts: { today?: IsoDate; budgetId?: string; viewerMemberId?: string | null } = {},
): NextIncome | null {
  const today = opts.today ?? todayIST();
  const candidates = queryAll<Schedule>(
    db,
    `SELECT s.*
       FROM schedules s
       JOIN accounts a ON a.id = s.account_id
      WHERE s.enabled = 1
        AND s.amount > 0
        AND s.next_due IS NOT NULL
        AND a.closed_at IS NULL
        AND a.kind = 'budget'
        AND (a.visibility <> 'private' OR a.holder_member_id IS ?)
        ${opts.budgetId ? "AND a.budget_id = ?" : ""}`,
    opts.viewerMemberId ?? null,
    ...(opts.budgetId ? [opts.budgetId] : []),
  );

  let soonest: NextIncome | null = null;
  for (const schedule of candidates) {
    /*
     * A schedule whose date has passed without being marked is still a salary
     * that arrives every month — `next_due` moves when somebody ticks it off,
     * and a household that does not tick things off would be told nothing at
     * all. So a stale date rolls forward to the occurrence it implies.
     */
    const date = schedule.next_due! >= today
      ? schedule.next_due!
      : nextOccurrence(schedule, today);
    if (!date) continue;
    if (!soonest || date < soonest.date) {
      soonest = { date, label: schedule.name, amount: schedule.amount };
    }
  }
  return soonest;
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
/**
 * F7.5 · Mark an occurrence paid — or arrived, for money coming in.
 *
 * This used to move `next_due` and nothing else, so the button appeared to do
 * nothing: the rent was still unrecorded, the balance unchanged, and the only
 * visible effect a date shifting by a month. A schedule exists because the
 * payment happens; marking it paid is saying it happened, so it posts the
 * transaction and then advances.
 *
 * A schedule with no amount or no account cannot post one — it is a reminder
 * rather than an instruction — so it just advances, as it always did.
 */
export function markPaid(db: DB, actor: Actor, scheduleId: string, on: IsoDate = todayIST()): void {
  transact(db, () => {
    const schedule = getSchedule(db, scheduleId);
    if (!schedule) throw new Error("That schedule does not exist.");

    let posted: string | null = null;
    if (schedule.amount !== null && schedule.account_id) {
      /*
       * A split schedule posts a split transaction. `categoryId` goes null in
       * that case, exactly as it does for a hand-entered split — the lines are
       * where the categories live, and leaving both set would file the amount
       * twice.
       */
      const splits = getScheduleSplits(db, scheduleId);
      posted = createTransaction(db, actor, {
        accountId: schedule.account_id,
        amount: schedule.amount,
        date: on,
        categoryId: splits.length > 0 ? null : schedule.category_id,
        splits: splits.length > 0
          ? splits.map((sp) => ({ categoryId: sp.category_id, amount: sp.amount, memo: sp.memo }))
          : undefined,
        payeeId: schedule.payee_id,
        payeeName: schedule.payee_id ? null : schedule.name,
        memo: `${schedule.name} — scheduled`,
        cleared: false,
      }).id;
    }

    const next = nextOccurrence(schedule, on);
    execute(db, `UPDATE schedules SET next_due = ? WHERE id = ?`, next, scheduleId);
    appendEvent(db, actor, {
      entity: "schedule", entityId: scheduleId, action: "mark-paid",
      before: { nextDue: schedule.next_due }, after: { nextDue: next, transactionId: posted },
      summary:
        (posted
          ? `Recorded ${schedule.name} for ${formatPaise(Math.abs(schedule.amount ?? 0) as Paise)}`
          : `Marked ${schedule.name} done`) +
        `; next due ${next ? formatDate(next) : "never"}`,
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
  db: DB,
  opts: {
    days?: number; floor?: Paise; today?: IsoDate;
    /** H2.2 · Who is looking, so a private loan's instalment stays private. */
    viewerMemberId?: string | null;
    /**
     * 15 · Whose cash is being projected. "Will I make it to the 30th" is a
     * question about one budget's accounts — answering it from the household's
     * cash while somebody is looking at their own budget is worse than useless.
     */
    budgetId?: string;
  } = {},
): Cashflow {
  const today = opts.today ?? todayIST();
  const horizon = opts.days ?? 60;
  const floor = opts.floor ?? 0;

  // Only Budget accounts: a card's balance is a liability, and a loan's is
  // not spendable either. The calendar is about cash on hand (R1).
  const balances = accountBalances(db);
  const budgetAccounts = queryAll<{ id: string }>(
    db,
    `SELECT id FROM accounts
      WHERE kind = 'budget' AND closed_at IS NULL
        ${opts.budgetId ? "AND budget_id = ?" : ""}`,
    ...(opts.budgetId ? [opts.budgetId] : []),
  );
  const inScope = new Set(budgetAccounts.map((a) => a.id));
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
    // A standing instruction only moves this budget's cash if it comes out of
    // one of its accounts.
    if (opts.budgetId && schedule.account_id && !inScope.has(schedule.account_id)) continue;
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

  /*
   * Loan instalments — usually the largest single outgoing in the month.
   *
   * H2.2 · Somebody else's private loan is not in this household's projection:
   * its instalment would show as an outflow with no explanation attached to it.
   */
  for (const loan of listLoans(db, { viewerMemberId: opts.viewerMemberId })) {
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

  /*
   * A deleted schedule comes back whole; an edited one goes back to what it was.
   * Only `next_due` used to be restored, which was right while marking one paid
   * was the only thing that could change it and wrong the moment a schedule
   * could be edited at all.
   */
  if (event.action === "delete") {
    execute(
      db,
      `INSERT INTO schedules
         (id,name,account_id,payee_id,category_id,amount,amount_is_estimate,recurrence,
          next_due,short_month_policy,is_subscription,detected,confidence,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      event.entityId!, before.name, before.account_id, before.payee_id, before.category_id,
      before.amount, before.amount_is_estimate, before.recurrence, before.next_due,
      before.short_month_policy, before.is_subscription, before.detected,
      before.confidence, nowIST(),
    );
    return `Put the schedule for ${before.name} back`;
  }

  execute(
    db,
    `UPDATE schedules SET name = ?, amount = ?, recurrence = ?, next_due = ?,
       category_id = ?, account_id = ?, short_month_policy = ?, is_subscription = ?,
       amount_is_estimate = ?
     WHERE id = ?`,
    before.name, before.amount, before.recurrence, before.next_due,
    before.category_id, before.account_id, before.short_month_policy,
    before.is_subscription, before.amount_is_estimate, event.entityId!,
  );
  return `Set the schedule for ${before.name} back`;
});
