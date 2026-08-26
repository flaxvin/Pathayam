/**
 * R7.g · Forward recompute on past-month edits (`10` §3.1).
 *
 * Q5 allows any past month to be edited, and R2/R4 make each month's Ready to
 * Assign depend on the previous month's overspend carry. An edit in month M
 * therefore ripples through every derived figure from M to the present.
 *
 * ## Why there is no recompute step here
 *
 * R7.g.1 says monthly figures are derived values, never independently
 * authoritative. This app takes that literally: **nothing derived is ever
 * stored.** `computeBudget` walks every month from the first with data on each
 * request, so R7.g.2's forward recompute is not a job that can be forgotten,
 * run twice, or run late — it is the only way a figure is ever produced.
 *
 * R7.g.5 falls out of the same fact: there is no derived state to write, so a
 * recompute cannot touch a recorded transaction or assignment even in
 * principle.
 *
 * ## What does need building
 *
 * R7.g.3 is not structural. It asks that the ripple be **logged as a single
 * batch attributed to the edit that caused it**, so "explain this number" can
 * say *August's Ready to Assign changed because a June assignment did*. That
 * needs an explicit before/after comparison, which is what this module is.
 *
 * So the shape is: snapshot the derived figures, make the edit, snapshot
 * again, and log the difference as one event naming the cause. The figures are
 * recomputed either way; the event is what makes the ripple explicable.
 */

import type { DB } from "../db/db.ts";
import { transact } from "../db/db.ts";
import { appendEvent, type Actor } from "../core/events.ts";
import type { Paise } from "../core/money.ts";
import { formatPaise } from "../core/money.ts";
import { formatMonth, monthOf, todayIST, type MonthKey } from "../core/dates.ts";
import { computeBudget } from "./engine.ts";
import { loadEngineInput } from "./repository.ts";

/** The derived figures for one month — everything R7.g.1 calls non-authoritative. */
export interface DerivedFigures {
  month: MonthKey;
  readyToAssign: Paise;
  cashOverspendCarriedIn: Paise;
  unfundedCreditAbsorbed: Paise;
  /** Opening balance per category — the other value that carries forward. */
  openings: Record<string, Paise>;
}

export type DerivedSnapshot = Map<MonthKey, DerivedFigures>;

/**
 * Capture derived figures from `fromMonth` to the current month.
 *
 * Taken before and after an edit, the pair is the ripple R7.g.3 wants named.
 */
export function snapshotDerived(db: DB, fromMonth: MonthKey): DerivedSnapshot {
  const currentMonth = monthOf(todayIST());
  const through = fromMonth > currentMonth ? fromMonth : currentMonth;
  const state = computeBudget(loadEngineInput(db, { through }));

  const snapshot: DerivedSnapshot = new Map();
  for (const [month, s] of state) {
    if (month < fromMonth) continue;
    const openings: Record<string, Paise> = {};
    for (const [id, c] of s.categories) {
      if (c.opening !== 0) openings[id] = c.opening;
    }
    snapshot.set(month, {
      month,
      readyToAssign: s.readyToAssign,
      cashOverspendCarriedIn: s.cashOverspendCarriedIn,
      unfundedCreditAbsorbed: s.unfundedCreditAbsorbed,
      openings,
    });
  }
  return snapshot;
}

export interface MonthChange {
  month: MonthKey;
  readyToAssignBefore: Paise;
  readyToAssignAfter: Paise;
  cashCarryBefore: Paise;
  cashCarryAfter: Paise;
  /** Categories whose opening balance moved, and by how much. */
  openingChanges: { categoryId: string; before: Paise; after: Paise }[];
}

export interface RecomputeResult {
  /** Months whose derived figures actually moved. Empty is the common case. */
  changed: MonthChange[];
  /** Months walked, whether or not anything moved. */
  monthsExamined: number;
  eventId: string | null;
}

export function diffDerived(before: DerivedSnapshot, after: DerivedSnapshot): MonthChange[] {
  const changes: MonthChange[] = [];

  for (const [month, a] of after) {
    const b = before.get(month);
    if (!b) continue;

    const openingChanges: MonthChange["openingChanges"] = [];
    const ids = new Set([...Object.keys(b.openings), ...Object.keys(a.openings)]);
    for (const id of ids) {
      const from = b.openings[id] ?? 0;
      const to = a.openings[id] ?? 0;
      if (from !== to) openingChanges.push({ categoryId: id, before: from, after: to });
    }

    const moved =
      b.readyToAssign !== a.readyToAssign ||
      b.cashOverspendCarriedIn !== a.cashOverspendCarriedIn ||
      openingChanges.length > 0;

    if (moved) {
      changes.push({
        month,
        readyToAssignBefore: b.readyToAssign,
        readyToAssignAfter: a.readyToAssign,
        cashCarryBefore: b.cashOverspendCarriedIn,
        cashCarryAfter: a.cashOverspendCarriedIn,
        openingChanges,
      });
    }
  }

  return changes.sort((x, y) => (x.month < y.month ? -1 : 1));
}

export interface RecordOptions {
  /** The month the edit landed in. */
  fromMonth: MonthKey;
  /** Plain-language description of the edit, for the log line. */
  cause: string;
  /** The event id of the edit itself, so the ripple points back at it. */
  causeEventId?: string | null;
  before: DerivedSnapshot;
}

/**
 * R7.g.3 · Log the ripple as one event batch attributed to its cause.
 *
 * Only the *current* month and later are worth reporting to the user — a
 * change to June's own figures is the edit itself, not a ripple. What matters
 * is that August moved because of it.
 */
export function recordForwardRecompute(
  db: DB, actor: Actor, opts: RecordOptions,
): RecomputeResult {
  const after = snapshotDerived(db, opts.fromMonth);
  const changed = diffDerived(opts.before, after);

  // The edit's own month always moves; that is the edit, not a consequence.
  const rippled = changed.filter((c) => c.month > opts.fromMonth);

  if (rippled.length === 0) {
    return { changed, monthsExamined: after.size, eventId: null };
  }

  const event = appendEvent(db, actor, {
    entity: "recompute",
    entityId: opts.fromMonth,
    action: "forward-recompute",
    before: Object.fromEntries(
      rippled.map((c) => [c.month, { readyToAssign: c.readyToAssignBefore }]),
    ),
    after: Object.fromEntries(
      rippled.map((c) => [c.month, { readyToAssign: c.readyToAssignAfter }]),
    ),
    summary: describeRipple(opts.cause, opts.fromMonth, rippled),
    undoOfEventId: null,
  });

  return { changed, monthsExamined: after.size, eventId: event.id };
}

function describeRipple(cause: string, fromMonth: MonthKey, rippled: MonthChange[]): string {
  const months = rippled.length;
  const last = rippled.at(-1)!;
  const delta = last.readyToAssignAfter - last.readyToAssignBefore;

  return (
    `${cause} in ${formatMonth(fromMonth)}, which changed ` +
    `${months} later ${months === 1 ? "month" : "months"} — ` +
    `${formatMonth(last.month)}'s Ready to Assign moved by ${formatPaise(delta)}`
  );
}

/**
 * The whole pattern in one call: snapshot, edit, log the ripple.
 *
 * Callers doing a past-month edit wrap it in this instead of remembering the
 * three steps.
 */
export function withForwardRecompute<T>(
  db: DB,
  actor: Actor,
  opts: { month: MonthKey; cause: string },
  fn: () => T,
): { result: T; recompute: RecomputeResult } {
  const currentMonth = monthOf(todayIST());

  // A current- or future-month edit has nothing behind it to ripple into.
  if (opts.month >= currentMonth) {
    return {
      result: fn(),
      recompute: { changed: [], monthsExamined: 0, eventId: null },
    };
  }

  return transact(db, () => {
    const before = snapshotDerived(db, opts.month);
    const result = fn();
    const recompute = recordForwardRecompute(db, actor, {
      fromMonth: opts.month,
      cause: opts.cause,
      before,
    });
    return { result, recompute };
  });
}

/**
 * R7.g.4 · Switching the overspend model is itself a full-history recompute.
 *
 * Every month from the first with data is affected, because the model decides
 * which term absorbs each negative — so the ripple is logged from the
 * beginning rather than from a month.
 */
export function setOverspendModel(
  db: DB, actor: Actor, model: "reduce-rta" | "carry-negative",
): RecomputeResult {
  return transact(db, () => {
    const current =
      (db.prepare(`SELECT overspend_model FROM household WHERE id = 1`).get() as
        | { overspend_model: string }
        | undefined)?.overspend_model ?? "reduce-rta";

    if (current === model) {
      return { changed: [], monthsExamined: 0, eventId: null };
    }

    const input = loadEngineInput(db);
    const earliest = input.months[0] ?? monthOf(todayIST());
    const before = snapshotDerived(db, earliest);

    db.prepare(`UPDATE household SET overspend_model = ? WHERE id = 1`).run(model);

    appendEvent(db, actor, {
      entity: "household",
      entityId: "1",
      action: "set-overspend-model",
      before: { overspendModel: current },
      after: { overspendModel: model },
      summary:
        model === "reduce-rta"
          ? "Switched to reducing next month's Ready to Assign when a category is overspent"
          : "Switched to carrying an overspent category's negative balance forward",
    });

    const after = snapshotDerived(db, earliest);
    const changed = diffDerived(before, after);

    if (changed.length > 0) {
      appendEvent(db, actor, {
        entity: "recompute",
        entityId: earliest,
        action: "forward-recompute",
        before: Object.fromEntries(
          changed.map((c) => [c.month, { readyToAssign: c.readyToAssignBefore }]),
        ),
        after: Object.fromEntries(
          changed.map((c) => [c.month, { readyToAssign: c.readyToAssignAfter }]),
        ),
        summary:
          `Changing the overspend model recomputed every month from ` +
          `${formatMonth(earliest)} — ${changed.length} ` +
          `${changed.length === 1 ? "month" : "months"} changed`,
      });
    }

    return { changed, monthsExamined: after.size, eventId: null };
  });
}
