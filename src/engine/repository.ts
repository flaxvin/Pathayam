/**
 * Loads the engine's inputs from SQLite.
 *
 * The engine is pure and knows nothing about storage; this is the only place
 * the two meet. Aggregation happens in SQL so a month's figures cost one pass
 * over indexed rows rather than pulling the ledger into memory — F21's target
 * is under 200ms at the server for a month with 500 transactions.
 */

import type { DB } from "../db/db.ts";
import { queryAll, queryOne, queryValue } from "../db/db.ts";
import type { Paise } from "../core/money.ts";
import type { MonthKey, IsoDate } from "../core/dates.ts";
import { addMonths, monthOf, todayIST, addDays, daysBetween } from "../core/dates.ts";
import {
  emptyMonth,
  type EngineInput,
  type MonthlyFacts,
  type CategoryMeta,
  type CategoryGroupMeta,
  type OverspendModel,
  type Target,
} from "./types.ts";
import type { AutoAssignRule } from "./engine.ts";

/**
 * Every categorised amount, whether it came from a plain transaction or from
 * one leg of a split. Used by several aggregates below, so it is defined once.
 */
const CATEGORISED_CTE = `
  WITH categorised AS (
    SELECT t.date AS date, t.account_id AS account_id, t.category_id AS category_id, t.amount AS amount
      FROM transactions t
     WHERE t.deleted_at IS NULL AND t.is_split = 0 AND t.category_id IS NOT NULL
    UNION ALL
    SELECT t.date, t.account_id, s.category_id, s.amount
      FROM transaction_splits s
      JOIN transactions t ON t.id = s.transaction_id
     WHERE t.deleted_at IS NULL AND s.category_id IS NOT NULL
  )
`;

export interface LoadOptions {
  /** The latest month to compute. Defaults to the current month in IST. */
  through?: MonthKey;
}

export function loadEngineInput(db: DB, opts: LoadOptions = {}): EngineInput {
  const through = opts.through ?? monthOf(todayIST());
  const months = monthRange(db, through);
  const facts: Record<MonthKey, MonthlyFacts> = {};
  for (const m of months) facts[m] = emptyMonth();

  const ensure = (month: MonthKey): MonthlyFacts | null => facts[month] ?? null;

  for (const r of queryAll<{ month: string; category_id: string; amount: number }>(
    db,
    `SELECT month, category_id, amount FROM assignments`,
  )) {
    const f = ensure(r.month);
    if (f) f.assigned[r.category_id] = (f.assigned[r.category_id] ?? 0) + r.amount;
  }

  for (const r of queryAll<{ month: string; category_id: string; amount: number }>(
    db,
    `${CATEGORISED_CTE}
     SELECT substr(c.date,1,7) AS month, c.category_id AS category_id, SUM(c.amount) AS amount
       FROM categorised c
      GROUP BY month, c.category_id`,
  )) {
    const f = ensure(r.month);
    if (f) f.activity[r.category_id] = r.amount;
  }

  // Only the credit-charged portion, so a credit overspend can be told from a
  // cash one — the distinction R6 turns on.
  for (const r of queryAll<{ month: string; category_id: string; amount: number }>(
    db,
    `${CATEGORISED_CTE}
     SELECT substr(c.date,1,7) AS month, c.category_id AS category_id, SUM(c.amount) AS amount
       FROM categorised c
       JOIN accounts a ON a.id = c.account_id
      WHERE a.kind = 'credit'
      GROUP BY month, c.category_id`,
  )) {
    const f = ensure(r.month);
    if (f) f.creditActivity[r.category_id] = r.amount;
  }

  // R6: negated, this is each payment category's activity. The card's opening
  // balance is deliberately excluded — the envelope starts at ₹0.
  for (const r of queryAll<{ month: string; account_id: string; amount: number }>(
    db,
    `SELECT substr(t.date,1,7) AS month, t.account_id AS account_id, SUM(t.amount) AS amount
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.deleted_at IS NULL AND a.kind = 'credit'
      GROUP BY month, t.account_id`,
  )) {
    const f = ensure(r.month);
    if (f) f.creditAccountFlow[r.account_id] = r.amount;
  }

  for (const r of queryAll<{ month: string; amount: number }>(
    db,
    `SELECT substr(t.date,1,7) AS month, SUM(t.amount) AS amount
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.deleted_at IS NULL AND a.kind = 'budget'
      GROUP BY month`,
  )) {
    const f = ensure(r.month);
    if (f) f.budgetAccountFlow += r.amount;
  }

  // F2.5: an opening balance arrives in RTA as income, in the month it is dated.
  for (const r of queryAll<{ month: string; amount: number }>(
    db,
    `SELECT substr(opening_date,1,7) AS month, SUM(opening_balance) AS amount
       FROM accounts WHERE kind = 'budget' GROUP BY month`,
  )) {
    const f = ensure(r.month);
    if (f) f.budgetAccountFlow += r.amount;
  }

  for (const r of queryAll<{ month: string; amount: number }>(
    db,
    `${CATEGORISED_CTE}
     SELECT substr(c.date,1,7) AS month, SUM(c.amount) AS amount
       FROM categorised c
       JOIN accounts a ON a.id = c.account_id
      WHERE a.kind = 'budget'
      GROUP BY month`,
  )) {
    const f = ensure(r.month);
    if (f) f.budgetCategorisedFlow += r.amount;
  }

  // Transfer legs never reach RTA — a card payment must reduce the payment
  // envelope, not the pool. See docs/dev/01-engine-derivation.md §3.
  for (const r of queryAll<{ month: string; amount: number }>(
    db,
    `SELECT substr(t.date,1,7) AS month, SUM(t.amount) AS amount
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.deleted_at IS NULL AND a.kind = 'budget' AND t.transfer_pair_id IS NOT NULL
      GROUP BY month`,
  )) {
    const f = ensure(r.month);
    if (f) f.budgetTransferFlow += r.amount;
  }

  for (const r of queryAll<{ month: string; amount: number }>(
    db,
    `SELECT month, amount FROM held_for_next_month`,
  )) {
    const f = ensure(r.month);
    if (f) f.held = r.amount;
  }

  return {
    months,
    facts,
    categories: loadCategories(db),
    overspendModel: loadOverspendModel(db),
    creditOpeningBalances: loadCreditOpeningBalances(db),
  };
}

/**
 * The contiguous span the engine must walk: from the earliest month carrying
 * any data through the later of `through` and the last month with an
 * assignment, since a future assignment reduces today's RTA (R2).
 */
export function monthRange(db: DB, through: MonthKey): MonthKey[] {
  const earliest =
    queryValue<string>(
      db,
      `SELECT MIN(m) FROM (
         SELECT MIN(substr(date,1,7)) AS m FROM transactions WHERE deleted_at IS NULL
         UNION ALL SELECT MIN(month) FROM assignments
         UNION ALL SELECT MIN(substr(opening_date,1,7)) FROM accounts
       )`,
    ) ?? through;

  const latestAssignment = queryValue<string>(db, `SELECT MAX(month) FROM assignments`) ?? through;
  const last = latestAssignment > through ? latestAssignment : through;

  const months: MonthKey[] = [];
  let cursor = earliest < through ? earliest : through;
  // A corrupt or absurd date must not spin here; a household budget will never
  // legitimately span more than a few decades.
  for (let guard = 0; cursor <= last && guard < 1200; guard++) {
    months.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return months;
}

export function loadCategories(db: DB): CategoryMeta[] {
  return queryAll<{
    id: string;
    name: string;
    group_id: string;
    hidden_at: string | null;
    payment_account_id: string | null;
    sort: number;
    group_sort: number;
  }>(
    db,
    `SELECT c.id, c.name, c.group_id, c.hidden_at, c.payment_account_id, c.sort,
            g.sort AS group_sort
       FROM categories c
       JOIN category_groups g ON g.id = c.group_id
      WHERE c.deleted_at IS NULL
      ORDER BY g.sort, c.sort, c.name`,
  ).map((r) => ({
    id: r.id,
    name: r.name,
    groupId: r.group_id,
    hidden: r.hidden_at !== null,
    paymentAccountId: r.payment_account_id,
  }));
}

export function loadCategoryGroups(db: DB): CategoryGroupMeta[] {
  return queryAll<{
    id: string;
    name: string;
    kind: string;
    sort: number;
    hidden_at: string | null;
  }>(db, `SELECT id, name, kind, sort, hidden_at FROM category_groups ORDER BY sort, name`).map(
    (r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind as CategoryGroupMeta["kind"],
      sort: r.sort,
      hidden: r.hidden_at !== null,
    }),
  );
}

export function loadOverspendModel(db: DB): OverspendModel {
  return (
    (queryValue<string>(db, `SELECT overspend_model FROM household WHERE id = 1`) as
      | OverspendModel
      | null) ?? "reduce-rta"
  );
}

function loadCreditOpeningBalances(db: DB): Record<string, Paise> {
  const out: Record<string, Paise> = {};
  for (const r of queryAll<{ id: string; opening_balance: number }>(
    db,
    `SELECT id, opening_balance FROM accounts WHERE kind = 'credit'`,
  )) {
    out[r.id] = r.opening_balance;
  }
  return out;
}

export function loadTargets(db: DB): Target[] {
  return queryAll<{
    category_id: string;
    type: string;
    amount: number | null;
    target_date: string | null;
    period: string | null;
    schedule_id: string | null;
  }>(db, `SELECT * FROM targets`).map((r) => ({
    categoryId: r.category_id,
    type: r.type as Target["type"],
    amount: r.amount,
    targetDate: r.target_date,
    period: r.period as Target["period"],
  }));
}

export function loadAutoAssignRules(db: DB): AutoAssignRule[] {
  return queryAll<{
    category_id: string;
    type: string;
    params_json: string;
    priority: number;
  }>(db, `SELECT * FROM autoassign_rules WHERE enabled = 1`).map((r) => ({
    categoryId: r.category_id,
    type: r.type as AutoAssignRule["type"],
    priority: r.priority,
    ...(JSON.parse(r.params_json) as Partial<AutoAssignRule>),
  }));
}

// ---------------------------------------------------------------------------
// Account balances (F2.8)
// ---------------------------------------------------------------------------

export interface AccountBalances {
  accountId: string;
  cleared: Paise;
  uncleared: Paise;
  /** cleared + uncleared — what the account is actually worth right now. */
  working: Paise;
}

export function accountBalances(db: DB): Map<string, AccountBalances> {
  const out = new Map<string, AccountBalances>();

  for (const a of queryAll<{ id: string; opening_balance: number }>(
    db,
    `SELECT id, opening_balance FROM accounts`,
  )) {
    // The opening balance is an asserted starting point, so it counts cleared.
    out.set(a.id, {
      accountId: a.id,
      cleared: a.opening_balance,
      uncleared: 0,
      working: a.opening_balance,
    });
  }

  for (const r of queryAll<{ account_id: string; cleared: number; amount: number }>(
    db,
    `SELECT account_id, cleared, SUM(amount) AS amount
       FROM transactions WHERE deleted_at IS NULL
      GROUP BY account_id, cleared`,
  )) {
    const entry = out.get(r.account_id);
    if (!entry) continue;
    if (r.cleared) entry.cleared += r.amount;
    else entry.uncleared += r.amount;
    entry.working += r.amount;
  }

  return out;
}

/**
 * R12's denominator: average daily spend over the trailing 90 days.
 *
 * Counts money leaving categories, so transfers, card payments and income are
 * all excluded — it measures how fast the household actually consumes
 * envelopes, which is what makes the buffer figure mean what it says.
 */
export function averageDailySpend(db: DB, asOf: IsoDate = todayIST(), windowDays = 90): Paise {
  const from = addDays(asOf, -windowDays);
  const total =
    queryValue<number>(
      db,
      `${CATEGORISED_CTE}
       SELECT COALESCE(SUM(-c.amount), 0)
         FROM categorised c
         LEFT JOIN categories cat ON cat.id = c.category_id
        WHERE c.date >= ? AND c.date <= ? AND c.amount < 0
          AND cat.payment_account_id IS NULL`,
      from,
      asOf,
    ) ?? 0;

  const days = Math.max(1, daysBetween(from, asOf));
  return Math.round(total / days);
}

/** The current outstanding on each Credit account, for R6's funding figures. */
export function creditOutstanding(db: DB): Map<string, Paise> {
  const balances = accountBalances(db);
  const out = new Map<string, Paise>();
  for (const a of queryAll<{ id: string }>(db, `SELECT id FROM accounts WHERE kind = 'credit'`)) {
    out.set(a.id, balances.get(a.id)?.working ?? 0);
  }
  return out;
}

export function householdSettings(db: DB) {
  return queryOne<{
    name: string;
    base_currency: string;
    overspend_model: OverspendModel;
    auto_assign_on_rollover: number;
    fiscal_year_start_month: number;
    card_due_warning_days: number;
    setup_completed_at: string | null;
  }>(db, `SELECT * FROM household WHERE id = 1`);
}
