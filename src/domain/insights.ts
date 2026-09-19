/**
 * F10.5 · Spending insights — factual observations, not advice.
 *
 * The app's stance is that it states what happened and leaves the judgement to
 * the household. (Q31 later added a tax estimate on its own screen, from
 * figures a person enters there; these insights still compute nothing.) So these
 * are observations with the numbers attached — "dining is 45% above its
 * three-month average, ₹8,200 against ₹5,650" — never "you should cut back".
 *
 * Each insight compares the current (partial) month to the mean of the three
 * complete months before it, per category. To be surfaced a change has to clear
 * both a proportional bar (so a category does not shout over a rounding wobble)
 * and an absolute one (so a ₹40 category does not rank next to rent).
 */

import type { DB } from "../db/db.ts";
import { budgetsFor } from "./budgets.ts";
import { queryAll } from "../db/db.ts";
import type { Paise } from "../core/money.ts";
import { formatPaise } from "../core/money.ts";
import { todayIST, monthOf, addMonths, type IsoDate, type MonthKey } from "../core/dates.ts";

export type InsightKind = "up" | "down" | "new" | "quiet";

export interface Insight {
  kind: InsightKind;
  categoryId: string;
  categoryName: string;
  /** This (partial) month's spend. */
  current: Paise;
  /** Mean of the three complete prior months. */
  baseline: Paise;
  /** Signed fraction vs baseline (0.45 = 45% above). */
  delta: number;
  text: string;
}

/** Only flag a move past both of these, so the list stays signal. */
const MIN_FRACTION = 0.3;
const MIN_ABSOLUTE: Paise = 100_000 as Paise; // ₹1,000

interface Row { month: string; category_id: string; name: string; spent: number }

function monthlySpendByCategory(
  db: DB, fromMonth: MonthKey, viewerMemberId?: string | null,
): Row[] {
  /*
   * 15 · Insights are sentences about envelopes — "Qwertyuiop Envelope is new
   * this month", "Groceries is 34% below its three-month average" — and they
   * appeared on Overview and Reports for every budget at once. The name of an
   * envelope in somebody else's budget, and what they spent from it, read out
   * in a sentence on the first screen of the app.
   */
  const visible = viewerMemberId === undefined
    ? null
    : budgetsFor(db, viewerMemberId ?? null).map((b) => b.id);
  // The same split-aware line set the trend uses, grouped by category and month.
  return queryAll<Row>(
    db,
    `WITH lines AS (
       SELECT t.date AS date, t.category_id AS category_id, t.amount AS amount
         FROM transactions t WHERE t.is_split = 0 AND t.deleted_at IS NULL
       UNION ALL
       SELECT t.date, s.category_id, s.amount
         FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
        WHERE t.deleted_at IS NULL
     )
     SELECT substr(l.date,1,7) AS month, l.category_id AS category_id,
            c.name AS name, COALESCE(SUM(-l.amount),0) AS spent
       FROM lines l JOIN categories c ON c.id = l.category_id
      WHERE l.date >= ? AND l.amount < 0 AND c.deleted_at IS NULL
        AND c.payment_account_id IS NULL
        ${visible ? `AND (c.budget_id IS NULL OR c.budget_id IN (${visible.map(() => "?").join(",")}))` : ""}
      GROUP BY month, l.category_id
      HAVING spent > 0`,
    `${fromMonth}-01`, ...(visible ?? []),
  );
}

/**
 * Observations about the current month against the trailing three.
 *
 * Ranked by how much money the change moved (an absolute rupee delta), because
 * a 200% jump on a tiny category is less worth a household's attention than a
 * 35% jump on rent. `limit` caps the list; 0 means all.
 */
export function spendingInsights(
  db: DB, today: IsoDate = todayIST(), limit = 6, viewerMemberId?: string | null,
): Insight[] {
  const thisMonth = monthOf(today);
  const priorMonths = [1, 2, 3].map((n) => addMonths(thisMonth, -n));
  const fromMonth = priorMonths[2]!;

  const rows = monthlySpendByCategory(db, fromMonth, viewerMemberId);

  // category -> month -> spent
  const byCat = new Map<string, { name: string; months: Map<string, number> }>();
  for (const r of rows) {
    let e = byCat.get(r.category_id);
    if (!e) { e = { name: r.name, months: new Map() }; byCat.set(r.category_id, e); }
    e.months.set(r.month, r.spent);
  }

  const insights: Insight[] = [];
  for (const [categoryId, { name, months }] of byCat) {
    const current = (months.get(thisMonth) ?? 0) as Paise;
    const priors = priorMonths.map((m) => months.get(m) ?? 0);
    const seen = priors.filter((v) => v > 0).length;
    // B77 · Rounded, not cast. An average of three integers is rarely an
    // integer, and `as Paise` only silences the type — it does not make the
    // value one. The Overview rendered the result as "₹13,666.66.66666666674428".
    const baseline = Math.round(priors.reduce((s, v) => s + v, 0) / 3) as Paise;

    // Brand-new spending: nothing in the prior three months, something now.
    if (current > 0 && seen === 0) {
      if (current >= MIN_ABSOLUTE) {
        insights.push({
          kind: "new", categoryId, categoryName: name, current, baseline: 0 as Paise,
          delta: 1,
          text: `${name} is new this month — ${formatPaise(current)}, with nothing in the previous three.`,
        });
      }
      continue;
    }
    if (baseline <= 0) continue;

    const delta = (current - baseline) / baseline;
    const absDelta = Math.abs(current - baseline);
    if (absDelta < MIN_ABSOLUTE || Math.abs(delta) < MIN_FRACTION) continue;

    if (delta > 0) {
      insights.push({
        kind: "up", categoryId, categoryName: name, current, baseline, delta,
        text: `${name} is ${Math.round(delta * 100)}% above its three-month average — ` +
          `${formatPaise(current)} this month against ${formatPaise(baseline)}.`,
      });
    } else {
      insights.push({
        kind: "down", categoryId, categoryName: name, current, baseline, delta,
        text: `${name} is ${Math.round(-delta * 100)}% below its three-month average — ` +
          `${formatPaise(current)} this month against ${formatPaise(baseline)}.`,
      });
    }
  }

  insights.sort((a, b) => Math.abs(b.current - b.baseline) - Math.abs(a.current - a.baseline));
  return limit > 0 ? insights.slice(0, limit) : insights;
}
