/**
 * F7 · Schedules, bills and the cashflow calendar.
 *
 * `05` §2 calls the cashflow calendar "the single most differentiating feature
 * versus YNAB and Actual". It answers one question the envelope model cannot:
 * *will I make it to the 30th?* Envelopes say whether money is allocated;
 * they say nothing about whether it is in the account on the day the standing
 * instruction fires.
 */

import { memberScope } from "./member-scope.ts";
import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, registerUndoHandler, type Actor } from "../core/events.ts";
import {
  nowIST, todayIST, addDays, addMonths, monthOf, daysBetween, resolveDayOfMonth,
  formatDate, nthWeekdayOfMonth, weekdayOf,
  WEEKDAY_NAMES, WEEKDAY_ORDINAL_NAMES,
  type IsoDate, type WeekdayOrdinal,
} from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import { accountBalances } from "../engine/repository.ts";
import { listLoans, projectLoan } from "./loans.ts";
import { Refusal, Missing } from "../core/refusal.ts";
import { createTransaction, refusePaymentCategories } from "./transactions.ts";

export type Recurrence =
  | "daily" | "weekly" | "fortnightly" | "monthly" | "monthly-nth-weekday"
  | "quarterly" | "half-yearly" | "yearly";

export const RECURRENCES: readonly Recurrence[] = [
  "daily", "weekly", "fortnightly", "monthly", "monthly-nth-weekday",
  "quarterly", "half-yearly", "yearly",
] as const;

/**
 * Every route took the form field and cast it: `field(body, "recurrence") as
 * Recurrence`. A cast is not a check — any string at all was stored, and
 * `nextOccurrence` then fell through to its default and advanced the schedule
 * monthly. A schedule could say "fortnighly", behave as monthly, and never
 * mention it. The column carries no CHECK either, so nothing downstream
 * objected.
 *
 * The table cannot gain one without a rebuild, and `schedules` is referenced by
 * `schedule_splits` with ON DELETE CASCADE, so the refusal lives here instead —
 * every write goes through create or update, and both call this.
 */
export function parseRecurrence(value: unknown): Recurrence {
  if (typeof value === "string" && (RECURRENCES as readonly string[]).includes(value)) {
    return value as Recurrence;
  }
  throw new Refusal(
    `"${String(value)}" is not a recurrence this app knows. ` +
    `Choose one of: ${RECURRENCES.join(", ")}.`,
  );
}

export const SCHEDULE_HUMAN_RECURRENCE: Record<Recurrence, string> = {
  daily: "Daily", weekly: "Weekly", fortnightly: "Fortnightly",
  monthly: "Monthly, on a date", "monthly-nth-weekday": "Monthly, on a weekday",
  quarterly: "Quarterly", "half-yearly": "Half-yearly", yearly: "Yearly",
};

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
  /** 'monthly-nth-weekday' only: 1..4, or -1 for the last in the month. */
  recurrence_ordinal: number | null;
  /** 'monthly-nth-weekday' only: 0 = Sunday. */
  recurrence_weekday: number | null;
  /**
   * The day of the month the household chose — 31 for "the 31st" — kept apart
   * from next_due because next_due is where *this* occurrence landed, and in
   * February that is the 28th. Undefined until the column is added (see
   * hasAnchorColumn), NULL on a row written before it; both fall back to the
   * day of next_due.
   */
  recurrence_day?: number | null;
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

const MONTH_BASED: readonly Recurrence[] = ["monthly", "quarterly", "half-yearly", "yearly"];

/**
 * Whether this database has somewhere to keep the anchor day yet. The column
 * arrives by migration; until it does, a schedule still advances, reading the
 * day from next_due as it always did.
 */
function hasAnchorColumn(db: DB): boolean {
  return queryAll<{ name: string }>(db, `PRAGMA table_info(schedules)`)
    .some((c) => c.name === "recurrence_day");
}

function dayOf(date: IsoDate): number {
  return Number(date.slice(8, 10));
}

/**
 * The ordinal and weekday belong to 'monthly-nth-weekday' and to nothing else.
 * Storing them on a monthly-by-date schedule would leave a value that means
 * nothing, waiting to be read by a later change of recurrence and quietly
 * moving somebody's rent.
 */
function weekdayFields(
  recurrence: Recurrence,
  ordinal: WeekdayOrdinal | null | undefined,
  weekday: number | null | undefined,
): { ordinal: number | null; weekday: number | null } {
  if (recurrence !== "monthly-nth-weekday") return { ordinal: null, weekday: null };
  const ord = ordinal ?? 1;
  if (![1, 2, 3, 4, -1].includes(ord)) {
    throw new Refusal("Choose the first, second, third, fourth or last one in the month.");
  }
  const wd = weekday ?? 0;
  if (!Number.isInteger(wd) || wd < 0 || wd > 6) {
    throw new Refusal("That is not a day of the week.");
  }
  return { ordinal: ord, weekday: wd };
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
    /** 'monthly-nth-weekday' only. 1..4, or -1 for last. */
    recurrenceOrdinal?: WeekdayOrdinal | null;
    /** 'monthly-nth-weekday' only. 0 = Sunday. */
    recurrenceWeekday?: number | null;
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
          next_due,short_month_policy,recurrence_ordinal,recurrence_weekday,
          is_subscription,detected,confidence,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, input.name, input.accountId ?? null, input.payeeId ?? null, input.categoryId ?? null,
      input.amount ?? null, input.amountIsEstimate ? 1 : 0, parseRecurrence(input.recurrence),
      input.nextDue, input.shortMonthPolicy ?? "last-day",
      weekdayFields(input.recurrence, input.recurrenceOrdinal, input.recurrenceWeekday).ordinal,
      weekdayFields(input.recurrence, input.recurrenceOrdinal, input.recurrenceWeekday).weekday,
      input.isSubscription ? 1 : 0, input.detected ? 1 : 0, input.confidence ?? null,
      nowIST(),
    );
    if (hasAnchorColumn(db)) {
      execute(db, `UPDATE schedules SET recurrence_day = ? WHERE id = ?`, dayOf(input.nextDue), id);
    }

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
    | "short_month_policy" | "is_subscription" | "amount_is_estimate"
    | "recurrence_ordinal" | "recurrence_weekday">>,
  /**
   * `splitsFollow` is the caller promising to write split lines in the same
   * transaction. Without it, an edit that turns a single-envelope schedule into
   * a split is refused halfway: the category is cleared before the lines that
   * replace it exist, so the envelope rule sees a schedule with neither.
   *
   * `linesFollow` is the caller replacing or clearing the lines itself (the
   * edit form, whenever it posts any), so the stored ones are not re-filed
   * against a new amount first.
   */
  opts: { splitsFollow?: boolean; linesFollow?: boolean } = {},
): Schedule {
  return transact(db, () => {
    const before = getSchedule(db, id);
    if (!before) throw new Refusal("That schedule does not exist.");
    requireEnvelopeForOutgoing(
      patch.amount !== undefined ? patch.amount : before.amount,
      patch.category_id !== undefined ? patch.category_id : before.category_id,
      opts.splitsFollow === true || getScheduleSplits(db, id).length > 0,
    );

    /*
     * The weekday pair follows the recurrence, in both directions.
     *
     * Switching *to* a weekday rule with nothing chosen would otherwise store
     * nulls and fall back to "first Sunday" silently; switching *away* would
     * leave the pair behind, to be picked up and acted on if the schedule ever
     * came back — moving a payment to a day nobody had chosen this time.
     */
    if (patch.recurrence !== undefined) {
      const recurrence = parseRecurrence(patch.recurrence);
      const pair = weekdayFields(
        recurrence,
        (patch.recurrence_ordinal ?? before.recurrence_ordinal) as WeekdayOrdinal | null,
        patch.recurrence_weekday ?? before.recurrence_weekday,
      );
      patch = { ...patch, recurrence_ordinal: pair.ordinal, recurrence_weekday: pair.weekday };
    }

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

    /*
     * The anchor day moves only when somebody moves it. The edit form posts
     * next_due back every time, and for a 31st schedule sitting on 28 Feb that
     * is "2026-02-28" — reading the day from it would quietly turn the rent
     * into a 28th schedule on any edit of the amount. So it follows next_due
     * only when next_due actually changed, or when the schedule has just become
     * month-based (a weekly one never kept its anchor up to date).
     */
    const moved = patch.next_due !== undefined && patch.next_due !== before.next_due;
    const becameMonthly = patch.recurrence !== undefined
      && MONTH_BASED.includes(patch.recurrence) && !MONTH_BASED.includes(before.recurrence);
    const nextDue = patch.next_due ?? before.next_due;
    if ((moved || becameMonthly) && nextDue && hasAnchorColumn(db)) {
      execute(db, `UPDATE schedules SET recurrence_day = ? WHERE id = ?`, dayOf(nextDue), id);
    }

    const amount = patch.amount !== undefined ? patch.amount : before.amount;
    const lines = amount !== before.amount && !opts.splitsFollow && !opts.linesFollow
      ? getScheduleSplits(db, id)
      : [];
    const refiled = lines.length > 0 ? refileLines(db, before.name, lines, amount) : null;

    const after = getSchedule(db, id)!;
    appendEvent(db, actor, {
      entity: "schedule", entityId: id, action: "update",
      // The lines ride along only when they moved, so undo can put them back
      // with the amount they added up to.
      before: refiled ? { ...before, splits: lines } : before,
      after: refiled ? { ...after, splits: refiled } : after,
      summary: `Edited the schedule for ${after.name}`,
    });
    return after;
  });
}

/**
 * A split schedule's lines, against a new amount.
 *
 * S6 · Changing the amount left the lines at the old total: ₹1,000.01 split
 * ₹666.68 / ₹333.33, changed to ₹500, kept both lines — the edit form said
 * "updated" — and every markPaid after that was refused ("the lines add up to
 * −₹1,000.01, but the transaction is −₹500"), so the schedule could never be
 * paid again until somebody re-entered its lines. The lines are re-filed the
 * way the form files them: the first takes whatever the others leave (₹166.67
 * here). When the others alone are the whole new amount or more, there is no
 * honest remainder, and the change is refused with the numbers instead.
 */
function refileLines(db: DB, name: string, lines: ScheduleSplit[], amount: Paise | null): ScheduleSplit[] {
  if (amount === null) {
    throw new Refusal(
      `${name} is split across ${lines.length} envelopes, so it needs an amount to split. ` +
      "Remove the split first, or keep an amount.",
    );
  }
  const [first, ...rest] = lines;
  if (rest.some((l) => (l.amount < 0) !== (amount < 0))) {
    throw new Refusal(
      `${name}'s envelope lines are money ${amount < 0 ? "coming in" : "going out"}, and the new ` +
      "amount is the other way. Change the lines along with the amount.",
    );
  }
  const claimed = rest.reduce((sum, l) => sum + l.amount, 0);
  const remainder = (amount - claimed) as Paise;
  if (remainder === 0 || (remainder < 0) !== (amount < 0)) {
    throw new Refusal(
      `The other envelope lines of ${name} come to ${formatPaise(Math.abs(claimed) as Paise)}, ` +
      `which leaves nothing for the first out of ${formatPaise(Math.abs(amount) as Paise)}. ` +
      "Change the lines along with the amount.",
    );
  }
  execute(db, `UPDATE schedule_splits SET amount = ? WHERE id = ?`, remainder, first!.id);
  return [{ ...first!, amount: remainder }, ...rest];
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
     * What undo needs to put back. These events recorded only what they did,
     * with no before-state, and the undo handler reads a missing before-state
     * as "this was a creation" — so undoing "Set Rent to split across 2
     * envelopes" deleted the schedule outright. They are recorded as their own
     * action now, with the lines and envelope as they were.
     */
    const priorState = {
      category_id: schedule.category_id,
      lines: getScheduleSplits(db, scheduleId).map((l) => ({
        category_id: l.category_id, amount: l.amount, memo: l.memo ?? null,
      })),
    };

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
        entity: "schedule", entityId: scheduleId, action: "split",
        before: priorState,
        after: { category_id: only.categoryId, lines: [] },
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
      entity: "schedule", entityId: scheduleId, action: "split",
      before: priorState,
      after: {
        category_id: schedule.category_id,
        lines: kept.map((l) => ({ category_id: l.categoryId, amount: l.amount, memo: l.memo ?? null })),
      },
      summary: kept.length
        ? `Set ${schedule.name} to split across ${kept.length} envelopes`
        : `Removed the split from ${schedule.name}`,
    });
  });
}

export function listSchedules(
  db: DB,
  opts: {
    includeDisabled?: boolean;
    /**
     * 15 · Who is looking. A schedule posting into somebody's private account,
     * or filing into their private envelope, is theirs: the schedules screen
     * listed Ravi's "Snorlax Secret Subscription" (₹777 a month, from his
     * private account) to Priya among the household's bills. Omitted means
     * every schedule, which is what the engine and the scheduler want.
     */
    viewerMemberId?: string | null;
  } = {},
): Schedule[] {
  const rows = queryAll<Schedule>(
    db,
    `SELECT * FROM schedules ${opts.includeDisabled ? "" : "WHERE enabled = 1"}
      ORDER BY next_due IS NULL, next_due`,
  );
  if (opts.viewerMemberId === undefined) return rows;
  const hidden = memberScope(db, opts.viewerMemberId).schedules;
  return rows.filter((row) => !hidden.has(row.id));
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

/**
 * F7.2 · The first occurrence of the schedule after `after` — and always at
 * least one step past next_due, since the caller is asking for "the one after
 * this".
 *
 * An overdue schedule is walked forward along its own series. It used to take
 * `after` itself as the starting point and add one step to it, which is a
 * different series: a salary on the 26th, last ticked off on 26 Aug, asked on
 * 25 Sep for what comes next, answered 26 Oct — September's payday had fallen
 * out — and a weekly Monday asked on a Wednesday answered the Wednesday after.
 */
export function nextOccurrence(schedule: Schedule, after: IsoDate): IsoDate | null {
  if (!schedule.next_due) return followingOccurrence(schedule, after);
  let at: IsoDate | null = schedule.next_due;
  // Ten thousand steps is 27 years of a daily schedule nobody ticked off.
  for (let guard = 0; at && guard < 10_000; guard++) {
    at = followingOccurrence(schedule, at);
    if (at && at > after) return at;
  }
  return at && followingOccurrence(schedule, after);
}

/** One step along the series from `from`, which is itself an occurrence. */
function followingOccurrence(schedule: Schedule, from: IsoDate): IsoDate | null {
  switch (schedule.recurrence) {
    case "daily": return addDays(from, 1);
    case "weekly": return addDays(from, 7);
    case "fortnightly": return addDays(from, 14);
    case "monthly-nth-weekday": return nextNthWeekday(schedule, from);
    case "quarterly": return shiftMonthsKeepingDay(schedule, from, 3);
    case "half-yearly": return shiftMonthsKeepingDay(schedule, from, 6);
    case "yearly": return shiftMonthsKeepingDay(schedule, from, 12);
    case "monthly": return shiftMonthsKeepingDay(schedule, from, 1);
    default: return shiftMonthsKeepingDay(schedule, from, 1);
  }
}

/**
 * "The first Sunday of each month" — F7.3.
 *
 * This case did not exist. `monthly-nth-weekday` fell through to the default
 * and advanced by day of month, so a schedule set to the first Sunday would
 * drift to whatever date the first Sunday happened to be when it was created
 * and then stay there. The value was never offered by the UI, which is the only
 * reason nobody met it.
 *
 * The ordinal and weekday come from the schedule rather than from `next_due`,
 * because a date cannot tell you which of the two it meant: 8 October 2026 is
 * both "the 8th" and "the second Thursday", and next month they are different
 * days. Where they are missing — a row written before 0041 — the weekday of
 * `next_due` is the best available guess and is used rather than refusing.
 */
function nextNthWeekday(schedule: Schedule, from: IsoDate): IsoDate | null {
  const anchor = schedule.next_due ?? from;
  const weekday = schedule.recurrence_weekday ?? weekdayOf(anchor);
  const ordinal = (schedule.recurrence_ordinal ?? 1) as WeekdayOrdinal;

  // This month's occurrence may still be ahead of us; only move on if it is not.
  const thisMonth = nthWeekdayOfMonth(monthOf(from), weekday, ordinal);
  if (thisMonth > from) return thisMonth;
  return nthWeekdayOfMonth(addMonths(monthOf(from), 1), weekday, ordinal);
}

/** "the first Sunday" — for the schedules list and the calendar. */
export function describeRecurrence(schedule: Schedule): string {
  if (schedule.recurrence !== "monthly-nth-weekday") {
    return SCHEDULE_HUMAN_RECURRENCE[schedule.recurrence] ?? schedule.recurrence;
  }
  const weekday = schedule.recurrence_weekday ?? weekdayOf(schedule.next_due ?? todayIST());
  const ordinal = (schedule.recurrence_ordinal ?? 1) as WeekdayOrdinal;
  return `The ${WEEKDAY_ORDINAL_NAMES[ordinal]} ${WEEKDAY_NAMES[weekday]} of each month`;
}

/**
 * F7.3 · The 29th–31st on a short month resolves by the schedule's own policy,
 * rather than silently sliding to a date the household did not choose.
 */
function shiftMonthsKeepingDay(schedule: Schedule, from: IsoDate, months: number): IsoDate | null {
  /*
   * S2 · The day comes from the anchor, not from where the last occurrence
   * landed. Reading it from next_due made every clamp permanent: 31 Jan,
   * 28 Feb, then 28 Mar, 28 Apr and the 28th for ever; yearly 29 Feb 2028 was
   * 28 Feb even in 2032; "next-day" put a 31st on the 1st of every month.
   */
  const day = schedule.recurrence_day ?? dayOf(schedule.next_due ?? from);
  /*
   * "next-day" lands the occurrence in the following month — 31 Feb is 1 Mar —
   * but it is still February's. Counting months from March would skip March's
   * own 31st, so a 1st that is exactly the previous month's spill-over counts
   * from the previous month.
   */
  let month = monthOf(from);
  if (schedule.short_month_policy === "next-day" && day > 1 && dayOf(from) === 1) {
    const previous = addMonths(month, -1);
    if (resolveDayOfMonth(previous, day, "next-day") === from) month = previous;
  }
  /*
   * "Skip" skips *that* month and carries on. resolveDayOfMonth answers null
   * for a month without the day, and that null used to be stored as next_due:
   * a rent on the 31st from 31 Jan 2026 was "next due never" the moment
   * February was reached, and the projection showed it once a year. So a
   * missing month moves on to the following step — 31 Jan, 31 Mar, 31 May;
   * yearly 29 Feb 2028, 29 Feb 2032. Forty-eight steps covers the longest
   * gap there is (29 Feb across 2100, which is not a leap year: eight years).
   */
  for (let step = 1; step <= 48; step++) {
    const date = resolveDayOfMonth(
      addMonths(month, months * step), day, schedule.short_month_policy,
    );
    if (date) return date;
  }
  return null;
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
    if (!schedule) throw new Missing("That schedule does not exist.");

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

    /*
     * S3 · Marking paid settles the occurrence that was due, so the schedule
     * moves one step on from the *due* date — never from the day it was paid.
     * Advancing from the payment date re-based the whole cycle on a late
     * payment: quarterly due 15 Mar paid 2 Apr went to 15 Jul (the Mar/Jun/
     * Sep/Dec cycle became Apr/Jul/Oct/Jan for good); monthly due 31 Jan paid
     * 2 Feb went to 31 Mar and February's rent vanished; a weekly Monday paid
     * on a Wednesday became a Wednesday schedule. Paid very late, the next
     * occurrence can already be overdue — which is true: it has not been paid.
     * Early payment was always right and still is: due 15 Mar paid 10 Mar is
     * next due 15 Apr.
     */
    const next = schedule.next_due
      ? followingOccurrence(schedule, schedule.next_due)
      : nextOccurrence(schedule, on);
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
    /*
     * Two different answers, which one sentence used to give as a 500. A
     * schedule that is not there is a 404; one that is there with nothing due
     * is a refusal with a reason.
     */
    if (!schedule) throw new Missing("That schedule does not exist.");
    if (!schedule.next_due) throw new Refusal("That schedule has nothing due to skip.");
    const next = followingOccurrence(schedule, schedule.next_due);
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
export function detectSchedules(
  db: DB, today = todayIST(),
  /*
   * 15 · A suggestion is made of transactions, and names their payee: "Looks
   * like Grimalkin Therapy Clinic every month — ₹999" was offered to Priya from
   * four payments on Ravi's private account. Only what the viewer can see.
   */
  viewerMemberId?: string | null,
): DetectedSchedule[] {
  const hidden = viewerMemberId === undefined ? null : memberScope(db, viewerMemberId).transactions;
  const rows = queryAll<{
    id: string; payee_id: string; payee: string; account_id: string; category_id: string | null;
    date: string; amount: number;
  }>(
    db,
    `SELECT t.id, t.payee_id, p.name AS payee, t.account_id, t.category_id, t.date, t.amount
       FROM transactions t JOIN payees p ON p.id = t.payee_id
      WHERE t.deleted_at IS NULL AND t.transfer_pair_id IS NULL
        AND t.payee_id IS NOT NULL AND t.date >= ?
      ORDER BY t.payee_id, t.date`,
    addDays(today, -400),
  ).filter((row) => !hidden?.has(row.id));

  const byPayee = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byPayee.get(row.payee_id) ?? [];
    list.push(row);
    byPayee.set(row.payee_id, list);
  }

  const existing = new Set(
    listSchedules(db, { includeDisabled: true, viewerMemberId }).map((s) => s.payee_id).filter(Boolean),
  );

  const detected: DetectedSchedule[] = [];

  for (const [payeeId, seen] of byPayee) {
    if (seen.length < 3 || existing.has(payeeId)) continue;

    /*
     * S4 · Which way the money goes is what was observed, not assumed. Every
     * suggestion used to be emitted as money out: five ₹85,000 salary credits
     * from an employer became a proposed ₹85,000 *expense*, which markPaid
     * would then post every month. A payee seen both ways — purchases and the
     * odd refund — is judged on the direction it mostly goes; a refund is not
     * part of the rhythm, and averaging it in as a payment misstated both the
     * amount and the gaps.
     */
    const incoming = seen.filter((o) => o.amount > 0);
    const outgoing = seen.filter((o) => o.amount < 0);
    const occurrences = incoming.length > outgoing.length ? incoming : outgoing;
    const sign = occurrences === incoming ? 1 : -1;
    if (occurrences.length < 3) continue;

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
      amount: (sign * typical) as Paise,
      recurrence,
      nextDue: detectedNextDue(occurrences.map((o) => o.date as IsoDate), recurrence, average),
      confidence,
      occurrences: occurrences.length,
    });
  }

  return detected.sort((a, b) => b.occurrences - a.occurrences);
}

/**
 * Where a detected schedule lands next.
 *
 * The last date plus the average gap is right for a weekly rhythm and wrong for
 * a monthly one: months are 28 to 31 days, so a salary on the 1st of May–Sep
 * (gaps 31, 30, 31, 31 — average 30.75) was proposed for 2 Oct. A month-based
 * rhythm steps whole months and keeps the day it usually falls on — the most
 * common day among the occurrences, so one payment a bank holiday pushed to
 * the 2nd does not move the rest.
 */
function detectedNextDue(dates: IsoDate[], recurrence: Recurrence, averageGap: number): IsoDate {
  const last = dates.at(-1)!;
  const months = { monthly: 1, quarterly: 3, "half-yearly": 6, yearly: 12 }[
    recurrence as "monthly" | "quarterly" | "half-yearly" | "yearly"
  ];
  if (!months) return addDays(last, Math.round(averageGap));
  const counts = new Map<number, number>();
  for (const date of dates) counts.set(dayOf(date), (counts.get(dayOf(date)) ?? 0) + 1);
  let day = dayOf(last);
  for (const [d, n] of counts) if (n > (counts.get(day) ?? 0)) day = d;
  return resolveDayOfMonth(addMonths(monthOf(last), months), day, "last-day")!;
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

  /*
   * S5 · Cards in scope, and when each is paid. A card's balance is not cash
   * leaving on the day it is charged; it leaves on the due date. Every card was
   * listed whatever budget was asked about, and its current balance was
   * charged again on every due date in the horizon: a card owing ₹10,000 due
   * on the 5th was ₹30,000 of outflows over 90 days (5 Oct, 5 Nov, 5 Dec),
   * a lowest balance of ₹70,000 against a true ₹90,000. What is owed today is
   * paid once, at the next due date; what the card will owe after that is
   * only what is scheduled on it, and that is paid at the due date its
   * statement falls into.
   */
  const cards = new Map(
    queryAll<{ id: string; name: string; due_day: number | null; statement_day: number | null }>(
      db,
      `SELECT id, name, due_day, statement_day FROM accounts
        WHERE kind = 'credit' AND closed_at IS NULL
          ${opts.budgetId ? "AND budget_id = ?" : ""}`,
      ...(opts.budgetId ? [opts.budgetId] : []),
    ).map((card) => [card.id, card]),
  );

  // Confirmed and detected schedules, distinguished (F7.8).
  for (const schedule of listSchedules(db, { viewerMemberId: opts.viewerMemberId })) {
    if (!schedule.next_due || schedule.amount === null) continue;
    /*
     * S5 · Which schedules move this cash, the same rule in every scope. A
     * schedule on a card was taken out of cash on its own date in the combined
     * projection and dropped altogether from the household one (it is not a
     * Budget account, so it failed the scope check): a ₹649 subscription billed
     * to the card cost cash in one view and nothing in the other. Now: a
     * Budget account in scope moves cash on the day; a card in scope moves it
     * on the card's due date; a tracking account, or anything out of scope,
     * does not move this cash at all. No account at all is taken as cash.
     */
    const card = schedule.account_id ? cards.get(schedule.account_id) : undefined;
    if (schedule.account_id && !inScope.has(schedule.account_id) && !card) continue;
    let due: IsoDate | null = schedule.next_due;
    for (let guard = 0; due && due <= end && guard < 400; guard++) {
      const leaves = card ? cardPaymentDate(card, due) : due;
      if (leaves >= today && leaves <= end) {
        const day = dayFor(leaves);
        const entry = {
          label: card ? `${schedule.name} (${card.name})` : schedule.name,
          amount: Math.abs(schedule.amount),
          confirmed: schedule.detected === 0,
        };
        if (schedule.amount > 0) day.inflows.push(entry);
        else day.outflows.push(entry);
      }
      due = followingOccurrence(schedule, due);
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

  // What each card owes today, paid once, at its next due date (S5).
  for (const card of cards.values()) {
    const owed = Math.max(0, -(balances.get(card.id)?.working ?? 0));
    if (owed === 0 || !card.due_day) continue;
    const thisMonth = resolveDayOfMonth(monthOf(today), card.due_day, "last-day")!;
    const due = thisMonth >= today
      ? thisMonth
      : resolveDayOfMonth(addMonths(monthOf(today), 1), card.due_day, "last-day")!;
    if (due > end) continue;
    dayFor(due).outflows.push({ label: `${card.name} due`, amount: owed, confirmed: true });
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

/**
 * When a charge on a card becomes cash leaving the bank: the first due date
 * after the statement that takes it in. Statement on the 20th, due on the 5th —
 * a charge on 10 Sep is paid 5 Oct, one on 25 Sep is paid 5 Nov. A card with no
 * statement day is taken to be paid at the first due date after the charge; a
 * card with no due day at all, on the day (nothing better is known).
 */
function cardPaymentDate(
  card: { due_day: number | null; statement_day: number | null }, charged: IsoDate,
): IsoDate {
  if (!card.due_day) return charged;
  let closes = charged;
  if (card.statement_day) {
    for (let m = 0; m <= 1; m++) {
      const close = resolveDayOfMonth(addMonths(monthOf(charged), m), card.statement_day, "last-day")!;
      if (close >= charged) { closes = close; break; }
    }
  }
  for (let m = 0; ; m++) {
    const due = resolveDayOfMonth(addMonths(monthOf(closes), m), card.due_day, "last-day")!;
    if (due > closes) return due;
  }
}

/** F7.9 · Subscriptions, with what they actually cost per year. */
export function subscriptions(
  db: DB, viewerMemberId?: string | null,
): { schedule: Schedule; annualised: Paise }[] {
  return listSchedules(db, { viewerMemberId })
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
  // A split change puts back the lines and the envelope it replaced.
  if (event.action === "split") {
    const prior = event.before as {
      category_id: string | null;
      lines: { category_id: string | null; amount: number; memo: string | null }[];
    } | undefined;
    if (!prior) {
      throw new Refusal("That change was recorded without what it replaced, so it cannot be undone.");
    }
    execute(db, `DELETE FROM schedule_splits WHERE schedule_id = ?`, event.entityId!);
    prior.lines.forEach((line, i) => {
      execute(
        db,
        `INSERT INTO schedule_splits (id, schedule_id, category_id, amount, memo, sort) VALUES (?,?,?,?,?,?)`,
        newId(), event.entityId!, line.category_id, line.amount, line.memo, i,
      );
    });
    execute(db, `UPDATE schedules SET category_id = ? WHERE id = ?`, prior.category_id, event.entityId!);
    return prior.lines.length > 0 ? `Put the split back` : `Put the single envelope back`;
  }

  const before = event.before as Schedule | undefined;
  if (!before) {
    /*
     * Only a creation has no before-state to return to. Anything else that
     * arrives here without one is an older event whose shape this cannot
     * restore — refusing is better than the old reading, which deleted the
     * schedule for any such event, including a split change.
     */
    if (event.action !== "create") {
      throw new Refusal("That change was recorded without what it replaced, so it cannot be undone.");
    }
    execute(db, `DELETE FROM schedule_splits WHERE schedule_id = ?`, event.entityId!);
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
    restoreRecurrenceDetail(db, event.entityId!, before);
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
  restoreRecurrenceDetail(db, event.entityId!, before);
  // S6 · An amount change that re-filed the lines puts them back too, or the
  // old amount returns over lines that add up to the new one.
  const lines = (before as Schedule & { splits?: ScheduleSplit[] }).splits;
  for (const line of lines ?? []) {
    execute(db, `UPDATE schedule_splits SET amount = ? WHERE id = ?`, line.amount, line.id);
  }
  return `Set the schedule for ${before.name} back`;
});

/**
 * The parts of the recurrence the two statements above never named: the
 * weekday pair and the anchor day. Without them an undone edit put a 31st
 * schedule back with the anchor of the edit, and an undone delete brought a
 * "first Sunday" schedule back with no Sunday.
 */
function restoreRecurrenceDetail(db: DB, id: string, before: Schedule): void {
  if (before.recurrence_ordinal !== undefined) {
    execute(
      db, `UPDATE schedules SET recurrence_ordinal = ?, recurrence_weekday = ? WHERE id = ?`,
      before.recurrence_ordinal, before.recurrence_weekday ?? null, id,
    );
  }
  if (before.recurrence_day !== undefined && hasAnchorColumn(db)) {
    execute(db, `UPDATE schedules SET recurrence_day = ? WHERE id = ?`, before.recurrence_day, id);
  }
}
