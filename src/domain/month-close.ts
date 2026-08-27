/**
 * `08` S5 · The month-close ritual. Adopted at P1 by Q26.
 *
 * S5's argument is behavioural, not technical: "budgeting works when it is a
 * ritual; the app currently has no moment that feels like one." Everything
 * here is computable at any time from the event log — the point is that there
 * is *a moment*, once a month, where the household looks at what happened and
 * says so.
 *
 * Three parts, in the order S5 gives them:
 *
 *   1. **What the month did** — income, spending, what was assigned, what went
 *      over, and the savings rate.
 *   2. **A net worth snapshot** (R29.2), so the trend is recorded rather than
 *      reconstructed later from today's prices.
 *   3. **Is the new month funded** — Ready to Assign, underfunded categories,
 *      unfunded cards.
 *
 * The one rule that shapes the code: **closing a month changes nothing about
 * it.** R13's rollover is derived, not a job (see `engine.ts`), so there is no
 * state to advance. A close records that a human looked, and takes a snapshot.
 * A month can be reopened, and closing it again is harmless — which is what
 * makes it safe to make it a habit.
 */

import type { DB } from "../db/db.ts";
import { transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, registerUndoHandler, type Actor } from "../core/events.ts";
import {
  nowIST, todayIST, monthOf, addMonths, formatMonth,
  firstDayOfMonth, lastDayOfMonth, type MonthKey, type IsoDate,
} from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import { buildBudgetView } from "../web/viewmodel.ts";
import { queryTransactions } from "./reports.ts";
import { snapshotNetWorth, netWorthChange, type NetWorthChange } from "./networth.ts";

export interface MonthOutcome {
  month: MonthKey;
  income: Paise;
  spending: Paise;
  /** Income less spending. Not the same as what was *saved* into anything. */
  net: Paise;
  assigned: Paise;
  /** R6: what the month ended with unassigned. */
  leftToAssign: Paise;
  overspent: { name: string; amount: Paise }[];
  biggestCategories: { name: string; amount: Paise }[];
  transactionCount: number;
  /**
   * Net ÷ income. Null when there was no income, because a rate against zero
   * is not a number — N9 forbids showing one anyway.
   */
  savingsRate: number | null;
}

export interface NextMonthReadiness {
  month: MonthKey;
  readyToAssign: Paise;
  underfunded: { amount: Paise; categoryCount: number };
  unfundedCards: { name: string; shortfall: Paise }[];
  fullyFunded: boolean;
}

export interface MonthCloseView {
  month: MonthKey;
  outcome: MonthOutcome;
  next: NextMonthReadiness;
  netWorth: NetWorthChange | null;
  closedAt: string | null;
  closedBy: string | null;
  /** True when the month being closed is not yet over. */
  stillRunning: boolean;
}

/** The most recent month that is over and not yet closed, if there is one. */
export function monthAwaitingClose(db: DB, today: IsoDate = todayIST()): MonthKey | null {
  const lastComplete = addMonths(monthOf(today), -1);
  if (isClosed(db, lastComplete)) return null;

  // Only nudge about a month the household actually used. A fresh install
  // should not open on "you have not closed March".
  const used = queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM transactions
      WHERE deleted_at IS NULL AND date >= ? AND date <= ?`,
    firstDayOfMonth(lastComplete), lastDayOfMonth(lastComplete),
  );
  return (used?.n ?? 0) > 0 ? lastComplete : null;
}

export function isClosed(db: DB, month: MonthKey): boolean {
  return queryOne(db, `SELECT month FROM month_closes WHERE month = ?`, month) !== null;
}

/** What the month did, and whether the next one is ready. Reads only. */
export function monthCloseView(
  db: DB, month: MonthKey, today: IsoDate = todayIST(),
): MonthCloseView {
  const from = firstDayOfMonth(month);
  const to = lastDayOfMonth(month);
  const view = buildBudgetView(db, month);

  const rows = queryTransactions(db, { from, to });

  let income = 0;
  let spending = 0;
  const byCategory = new Map<string, { name: string; amount: number }>();

  for (const row of rows) {
    // A transfer is not income and not spending — it is the same money in a
    // different place, and counting it would make every month look wrong.
    if (row.isTransfer) continue;

    if (row.amount > 0) income += row.amount;
    else spending += -row.amount;

    if (row.amount < 0 && row.categoryId) {
      const entry = byCategory.get(row.categoryId) ??
        { name: row.category ?? "Uncategorised", amount: 0 };
      entry.amount += -row.amount;
      byCategory.set(row.categoryId, entry);
    }
  }

  const assigned = [...view.categories.values()].reduce((sum, c) => sum + c.state.assigned, 0);

  const outcome: MonthOutcome = {
    month,
    income: income as Paise,
    spending: spending as Paise,
    net: (income - spending) as Paise,
    assigned: assigned as Paise,
    leftToAssign: view.monthState.readyToAssign,
    overspent: view.overspentCategories.map((c) => ({
      name: c.name, amount: Math.abs(c.state.balance) as Paise,
    })),
    biggestCategories: [...byCategory.values()]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5)
      .map((c) => ({ name: c.name, amount: c.amount as Paise })),
    transactionCount: rows.filter((r) => !r.isTransfer).length,
    savingsRate: income > 0 ? (income - spending) / income : null,
  };

  const following = addMonths(month, 1);
  const nextView = buildBudgetView(db, following);
  const cardNames = new Map(
    queryAll<{ id: string; name: string }>(
      db, `SELECT id, name FROM accounts WHERE kind = 'credit'`,
    ).map((a) => [a.id, a.name]),
  );

  const next: NextMonthReadiness = {
    month: following,
    readyToAssign: nextView.monthState.readyToAssign,
    underfunded: nextView.underfunded,
    unfundedCards: nextView.cards
      .filter((c) => c.unfunded > 0)
      .map((c) => ({
        name: cardNames.get(c.accountId) ?? "A card",
        shortfall: c.unfunded,
      })),
    fullyFunded: nextView.fullyFunded,
  };

  const closed = queryOne<{ closed_at: string; member_name: string | null }>(
    db,
    `SELECT c.closed_at, m.name AS member_name
       FROM month_closes c LEFT JOIN members m ON m.id = c.closed_by
      WHERE c.month = ?`,
    month,
  );

  return {
    month,
    outcome,
    next,
    // The month's own movement: where net worth stood entering it, against
    // where it stood leaving.
    netWorth: safeNetWorthChange(db, from, to),
    closedAt: closed?.closed_at ?? null,
    closedBy: closed?.member_name ?? null,
    stillRunning: month >= monthOf(today),
  };
}

/**
 * R30/FW-adjacent: the close must work with the assets module absent or its
 * tables empty. A ritual that fails because there is no portfolio is a ritual
 * nobody performs.
 */
function safeNetWorthChange(db: DB, from: IsoDate, to: IsoDate): NetWorthChange | null {
  try {
    return netWorthChange(db, from, to);
  } catch {
    return null;
  }
}

export interface MonthCloseResult {
  month: MonthKey;
  snapshotTaken: boolean;
}

/**
 * Close a month.
 *
 * Records that it happened and takes a net worth snapshot. It does not touch a
 * transaction, an assignment, or any derived figure — R13's rollover already
 * happened by arithmetic, and R7.g still lets any past month be edited
 * afterwards. Closing is a statement about attention, not a lock.
 */
export function closeMonth(
  db: DB, actor: Actor, month: MonthKey, note?: string | null,
): MonthCloseResult {
  return transact(db, () => {
    const view = monthCloseView(db, month);

    let snapshotTaken = false;
    try {
      // R29.2: dated, so the trend is real rather than reconstructed from
      // today's prices later.
      snapshotNetWorth(db, actor, lastDayOfMonth(month));
      snapshotTaken = true;
    } catch {
      // No assets configured. The rest of the close still stands.
    }

    execute(
      db,
      `INSERT INTO month_closes (month, closed_at, closed_by, note, income, spending, assigned)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(month) DO UPDATE SET
         closed_at = excluded.closed_at, closed_by = excluded.closed_by,
         note = excluded.note, income = excluded.income,
         spending = excluded.spending, assigned = excluded.assigned`,
      month, nowIST(), actor.memberId, note ?? null,
      view.outcome.income, view.outcome.spending, view.outcome.assigned,
    );

    appendEvent(db, actor, {
      entity: "month-close", entityId: month, action: "close",
      after: { income: view.outcome.income, spending: view.outcome.spending },
      summary:
        `Closed ${formatMonth(month)} — ${formatPaise(view.outcome.income)} in, ` +
        `${formatPaise(view.outcome.spending)} out` +
        (snapshotTaken ? ", net worth snapshotted" : ""),
    });

    return { month, snapshotTaken };
  });
}

/** Reopen a closed month. Nothing was locked; this only clears the record. */
export function reopenMonth(db: DB, actor: Actor, month: MonthKey): void {
  transact(db, () => {
    execute(db, `DELETE FROM month_closes WHERE month = ?`, month);
    appendEvent(db, actor, {
      entity: "month-close", entityId: month, action: "reopen",
      summary: `Reopened ${formatMonth(month)}`,
    });
  });
}

export interface ClosedMonth {
  month: MonthKey;
  closed_at: string;
  note: string | null;
  income: Paise;
  spending: Paise;
  assigned: Paise;
}

export function closedMonths(db: DB, limit = 24): ClosedMonth[] {
  return queryAll<ClosedMonth>(
    db, `SELECT * FROM month_closes ORDER BY month DESC LIMIT ?`, limit,
  );
}

// R37: every action undoes, including this one.
registerUndoHandler("month-close", (db, event) => {
  if (event.action === "close") {
    execute(db, `DELETE FROM month_closes WHERE month = ?`, event.entityId);
    return `Reopened ${formatMonth(event.entityId as MonthKey)}`;
  }
  return "Nothing to undo.";
});
