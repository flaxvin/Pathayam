/**
 * `02` F14 · Notifications, as errata E12 leaves them.
 *
 * E12 removed the last sentence implying push exists somewhere: **the in-app
 * badge and the digest on next open are the only notification channels, on
 * every platform** (Q21). So this file is the whole of F14's delivery. There
 * is no scheduler, no service worker, and nothing that can arrive while the
 * app is closed — a digest is computed when someone opens the app, from the
 * same data every screen reads.
 *
 * F14.1's list, in full:
 *   · a card payment due with an unfunded shortfall (F8.3)
 *   · a subscription renewing within N days
 *   · a category overspent
 *   · the month rolled over — here, a month waiting to be closed (`08` S5)
 *   · the review queue non-empty for more than N days
 *   · a projected balance shortfall from the cashflow calendar (F7.7)
 *
 * F14.5 is the constraint that keeps it trustworthy: **no engagement or streak
 * notifications**, and one item per event. Every item below is a thing the
 * household would want to act on today. None of them exist to bring anyone
 * back into the app.
 *
 * N18 applies throughout: nothing here scolds, and nothing states an amount
 * where the amount is the point of the shame rather than the point of the fact.
 */

import type { DB } from "../db/db.ts";
import { queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, type Actor } from "../core/events.ts";
import {
  nowIST, todayIST, monthOf, formatMonth, formatDate, daysBetween, addDays,
  type IsoDate,
} from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import { averageDailySpend } from "../engine/repository.ts";
import { buildBudgetView } from "../web/viewmodel.ts";
import { monthAwaitingClose } from "./month-close.ts";
import { projectCashflow } from "./schedules.ts";

/** F14.2 · Each of these is individually mutable per member. */
export const DIGEST_KINDS = [
  "card-due", "subscription-due", "overspent", "month-close",
  "review-waiting", "cash-shortfall", "hold-surplus",
] as const;
export type DigestKind = (typeof DIGEST_KINDS)[number];

export const DIGEST_LABELS: Record<DigestKind, string> = {
  "card-due": "A card payment is due and not fully funded",
  "subscription-due": "A subscription is about to renew",
  overspent: "A category has gone over",
  "month-close": "Last month is ready to close",
  "review-waiting": "Things have been waiting in Review",
  "cash-shortfall": "The cashflow projection dips below your floor",
  "hold-surplus": "More is unassigned than a month usually costs",
};

export interface DigestItem {
  kind: DigestKind;
  /** The one line the household reads. */
  text: string;
  /** Where acting on it starts. */
  href: string;
  urgent: boolean;
}

/** How long the review queue may sit before it is worth mentioning. */
const REVIEW_PATIENCE_DAYS = 3;
/** How far ahead a renewal counts as imminent. */
const SUBSCRIPTION_HORIZON_DAYS = 7;

/**
 * B102 · R11 · When to suggest holding income back for next month.
 *
 * This household is not paid a salary. Money arrives in lumps — two to four
 * credits a month, anywhere from ₹45,000 to ₹3.5 lakh — which is exactly the
 * shape "hold for next month" exists for and exactly the shape that never
 * prompts for it: the control has always been one tap away on the budget
 * footer, and nothing ever suggested reaching for it.
 *
 * A whole extra month already sitting unassigned is the moment worth
 * mentioning. Below that, a large Ready to Assign is just a month in progress.
 */
const HOLD_SUGGESTION_MONTHS = 1;

export function digestFor(
  db: DB, memberId: string | null, today: IsoDate = todayIST(),
): DigestItem[] {
  const muted = mutedKinds(db, memberId);
  const items: DigestItem[] = [];
  const add = (item: DigestItem) => {
    if (!muted.has(item.kind)) items.push(item);
  };

  const view = buildBudgetView(db, monthOf(today));

  // F8.3 · A card payment due with an unfunded shortfall. The shortfall is the
  // actionable part; the due date alone is the bank's business, not ours.
  const cardNames = new Map(
    queryAll<{ id: string; name: string; due_day: number | null }>(
      db, `SELECT id, name, due_day FROM accounts WHERE kind = 'credit' AND closed_at IS NULL`,
    ).map((a) => [a.id, a]),
  );
  for (const card of view.cards) {
    if (card.unfunded <= 0) continue;
    const account = cardNames.get(card.accountId);
    add({
      kind: "card-due",
      text:
        `${formatPaise(card.unfunded)} of your ${account?.name ?? "card"} balance ` +
        `has no envelope behind it.`,
      href: `/accounts/${card.accountId}`,
      urgent: true,
    });
  }

  // F14.1 · A category overspent. Only cash overspend: a credit overspend is
  // not the household's to cover from another envelope this month (R5).
  const overspent = view.overspentCategories.filter((c) => c.needsCover);
  if (overspent.length > 0) {
    add({
      kind: "overspent",
      text:
        overspent.length === 1
          ? `${overspent[0]!.name} is over by ${formatPaise(Math.abs(overspent[0]!.state.balance))}.`
          : `${overspent.length} categories are over.`,
      href: "/review",
      urgent: false,
    });
  }

  // F14.1 · A subscription renewing within N days.
  const renewing = queryAll<{ name: string; next_due: string; amount: number }>(
    db,
    // Subscriptions only, and only confirmed ones: F7.8 keeps a *detected*
    // schedule unconfirmed, and nagging about a guess is how a digest earns
    // being ignored.
    `SELECT name, next_due, amount FROM schedules
      WHERE enabled = 1 AND detected = 0 AND is_subscription = 1
        AND next_due IS NOT NULL AND next_due >= ? AND next_due <= ?
      ORDER BY next_due`,
    today, addDays(today, SUBSCRIPTION_HORIZON_DAYS),
  );
  for (const schedule of renewing) {
    const days = daysBetween(today, schedule.next_due as IsoDate);
    add({
      kind: "subscription-due",
      text:
        `${schedule.name} renews ${days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`}` +
        ` — ${formatPaise(Math.abs(schedule.amount) as Paise)}.`,
      href: "/schedules",
      urgent: days <= 1,
    });
  }

  // F14.1 · The review queue non-empty for more than N days. The *oldest* item
  // decides: a queue that turns over daily is a queue being used, not ignored.
  const oldest = queryOne<{ created_at: string; n: number }>(
    db,
    `SELECT MIN(created_at) AS created_at, COUNT(*) AS n
       FROM staged_transactions WHERE status = 'pending'`,
  );
  if (oldest?.created_at && oldest.n > 0) {
    const waiting = daysBetween(oldest.created_at.slice(0, 10) as IsoDate, today);
    if (waiting >= REVIEW_PATIENCE_DAYS) {
      add({
        kind: "review-waiting",
        text:
          `${oldest.n} ${oldest.n === 1 ? "item has" : "items have"} been waiting in Review ` +
          `for ${waiting} days.`,
        href: "/review",
        urgent: false,
      });
    }
  }

  // F7.7 · A projected shortfall. This is the "will I make it to the 30th?"
  // question, and it is the one item here worth interrupting someone for.
  const cashflow = projectCashflow(db, { today });
  if (cashflow.firstShortfall) {
    const days = daysBetween(today, cashflow.firstShortfall);
    add({
      kind: "cash-shortfall",
      text:
        `Your balance is projected to dip below your floor on ` +
        `${formatDate(cashflow.firstShortfall)}` +
        `${days <= 7 ? " — that is within the week" : ""}.`,
      href: "/schedules?tab=calendar",
      urgent: days <= 7,
    });
  }

  /*
   * B102 · R11 · A whole extra month is sitting unassigned.
   *
   * The household that is paid in lumps rather than monthly is the one this
   * matters to, and the one the app never spoke to: "hold for next month" has
   * always been a tap away on the budget footer and nothing ever suggested it.
   *
   * The comparison is against what a month actually costs — `averageDailySpend`
   * over the trailing window, which is R12's own denominator — rather than
   * against a round number, because a large Ready to Assign means nothing until
   * you know what a month takes.
   */
  const monthlySpend = averageDailySpend(db, today) * 30;
  const rta = view.monthState.readyToAssign;
  if (monthlySpend > 0 && rta > monthlySpend * (HOLD_SUGGESTION_MONTHS + 1)) {
    /*
     * Suggest a month, not the surplus. The point of R11 is that next month
     * opens already funded from money that has arrived — holding everything
     * unassigned would just move a large number from one month to the next and
     * tell the household nothing about what to do with it.
     *
     * Rounded to the nearest ₹100, because "hold ₹17,166.60" reads as a figure
     * the app computed and this is an estimate the household is free to ignore.
     */
    const suggestion = (Math.round(monthlySpend / 10_000) * 10_000) as Paise;
    add({
      kind: "hold-surplus",
      text:
        `${formatPaise(rta)} is unassigned — about ${(rta / monthlySpend).toFixed(1)} months ` +
        `of typical spending. Hold ${formatPaise(suggestion)} for next month and it opens ` +
        `already funded, which is how you get to spending last month's income.`,
      href: `/hold?month=${monthOf(today)}`,
      urgent: false,
    });
  }

  // `08` S5 · Last month is over and nobody has closed it.
  const awaiting = monthAwaitingClose(db, today);
  if (awaiting) {
    add({
      kind: "month-close",
      text: `${formatMonth(awaiting)} is over. Close it when you have ten minutes.`,
      href: `/months/${awaiting}/close`,
      urgent: false,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// F14.2 · Per-member, per-kind muting
// ---------------------------------------------------------------------------

export function mutedKinds(db: DB, memberId: string | null): Set<DigestKind> {
  if (!memberId) return new Set();
  return new Set(
    queryAll<{ kind: string }>(
      db, `SELECT kind FROM digest_mutes WHERE member_id = ?`, memberId,
    ).map((r) => r.kind as DigestKind),
  );
}

/**
 * Set which kinds a member wants.
 *
 * Stored as mutes rather than subscriptions so the default is on: a member who
 * has never opened settings still gets told their card is unfunded.
 */
export function setMutedKinds(db: DB, actor: Actor, kinds: DigestKind[]): void {
  const memberId = actor.memberId;
  if (!memberId) return;

  execute(db, `DELETE FROM digest_mutes WHERE member_id = ?`, memberId);
  for (const kind of kinds) {
    if (!DIGEST_KINDS.includes(kind)) continue;
    execute(
      db, `INSERT INTO digest_mutes (member_id, kind, muted_at) VALUES (?,?,?)`,
      memberId, kind, nowIST(),
    );
  }

  appendEvent(db, actor, {
    entity: "digest", entityId: memberId, action: "set-mutes",
    after: { muted: kinds },
    summary:
      kinds.length === 0
        ? "Turned every notification back on"
        : `Turned off ${kinds.length} ${kinds.length === 1 ? "notification" : "notifications"}`,
  });
}
