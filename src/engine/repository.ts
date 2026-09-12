/**
 * Loads the engine's inputs from SQLite.
 *
 * The engine is pure and knows nothing about storage; this is the only place
 * the two meet. Aggregation happens in SQL so a month's figures cost one pass
 * over indexed rows rather than pulling the ledger into memory — F21's target
 * is under 200ms at the server for a month with 500 transactions.
 */

import type { DB } from "../db/db.ts";
import { queryAll, queryOne, queryValue, execute, transact } from "../db/db.ts";
import type { Paise } from "../core/money.ts";
import type { MonthKey, IsoDate } from "../core/dates.ts";
import {
  addMonths, monthOf, todayIST, nowIST, addDays, daysBetween,
  firstDayOfMonth, lastDayOfMonth,
} from "../core/dates.ts";
import {
  emptyMonth,
  type EngineInput,
  type MonthlyFacts,
  type CategoryMeta,
  type CategoryGroupMeta,
  type OverspendModel,
  type Target,
} from "./types.ts";

/**
 * Every categorised amount, whether it came from a plain transaction or from
 * one leg of a split. Used by several aggregates below, so it is defined once.
 */
/**
 * Categorised money, split rows included, bounded by the window the caller
 * passes — `from` then `to`, once for each leg of the union.
 *
 * B73: without any bound, every read materialised the whole ledger and threw
 * away what fell outside the months asked for. Both ends matter: bounding only
 * the top still built the entire history before the outer query narrowed it,
 * which left the six-month live window scaling with all of time.
 */
const CATEGORISED_CTE = `
  WITH categorised AS (
    SELECT t.date AS date, t.account_id AS account_id, t.category_id AS category_id, t.amount AS amount
      FROM transactions t
     WHERE t.deleted_at IS NULL AND t.is_split = 0 AND t.category_id IS NOT NULL
       AND t.date >= ? AND t.date <= ?
    UNION ALL
    SELECT t.date, t.account_id, s.category_id, s.amount
      FROM transaction_splits s
      JOIN transactions t ON t.id = s.transaction_id
     WHERE t.deleted_at IS NULL AND s.category_id IS NOT NULL
       AND t.date >= ? AND t.date <= ?
  )
`;

/**
 * B74 · How far back a month is still expected to change.
 *
 * Six months is a judgement, not a law: an Indian household chasing a
 * reimbursement or a late statement is still editing three months back, and is
 * not still editing last year. Any edit to a sealed month drops that month's
 * rollup through a trigger, so the number only decides how often that happens —
 * never whether the figures are right.
 */
export const ROLLUP_SEAL_AFTER_MONTHS = 6;

/*
 * 15 · Scoping to one budget.
 *
 * Every fact below already joins `accounts`, so restricting a load to one
 * budget is one clause rather than a rewrite — and `computeBudget` never learns
 * that budgets exist at all. It is handed a smaller set of facts and does the
 * same arithmetic on it, which is why the identity holds per budget without the
 * engine changing.
 *
 * An empty filter means every budget, which is what the export, the backup and
 * a single-budget household all want.
 */
function budgetClause(budgetId: string | undefined, alias = "a"): string {
  return budgetId ? ` AND ${alias}.budget_id = ?` : "";
}
function budgetParams(budgetId: string | undefined): string[] {
  return budgetId ? [budgetId] : [];
}

/** The per-month, per-category, per-account spend, for a bounded window. */
function categorisedSql(budgetId?: string): string {
  return `${CATEGORISED_CTE}
     SELECT substr(c.date,1,7) AS month, c.category_id AS category_id,
            c.account_id AS account_id, a.kind AS kind, SUM(c.amount) AS amount
       FROM categorised c
       JOIN accounts a ON a.id = c.account_id
      WHERE 1 = 1${budgetClause(budgetId)}
      GROUP BY month, c.category_id, c.account_id`;
}

/**
 * R6: negated, a card's flow is its payment category's activity. The card's
 * opening balance is deliberately excluded — the envelope starts at ₹0 — which
 * is why this reads transactions rather than balances.
 */
function accountFlowSql(budgetId?: string): string {
  return `SELECT substr(t.date,1,7) AS month, t.account_id AS account_id,
            a.kind AS kind, SUM(t.amount) AS amount
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.deleted_at IS NULL AND a.kind IN ('budget','credit')
        AND t.date >= ? AND t.date <= ?${budgetClause(budgetId)}
      GROUP BY month, t.account_id`;
}

/*
 * Transfer legs are excluded from RTA only when the transfer is *internal to
 * the budget* — budget↔budget nets to zero, and budget↔credit must reduce the
 * card's payment envelope rather than the pool (R6). See
 * docs/dev/01-engine-derivation.md §3.
 *
 * A transfer to or from a **tracking** account is a third case, and it is not
 * internal: one side is outside the budget entirely. Lending ₹50,000 to family,
 * buying an asset, or repaying loan principal all remove money that R1 counts
 * as "money you have", so the budget-side leg must behave like any other flow —
 * reducing RTA when it carries no category, and consumed by the envelope when
 * it does. Excluding it here instead let money leave the budget with nothing
 * recording it, and broke the identity by exactly the amount transferred.
 */
function transferFlowSql(budgetId?: string): string {
  return `SELECT substr(t.date,1,7) AS month, t.account_id AS account_id, SUM(t.amount) AS amount
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       JOIN transactions other
         ON other.transfer_pair_id = t.transfer_pair_id AND other.id <> t.id
       JOIN accounts otherAccount ON otherAccount.id = other.account_id
      WHERE t.deleted_at IS NULL AND a.kind = 'budget'
        AND t.transfer_pair_id IS NOT NULL
        AND otherAccount.kind IN ('budget','credit')
        AND t.date >= ? AND t.date <= ?${budgetClause(budgetId)}
      GROUP BY month, t.account_id`;
}

/**
 * B97 · Card charges with no category on them, per card.
 *
 * The payment envelope holds money a category gave up to meet the card's debt.
 * A charge nobody has filed gave nothing up, so it must not raise the envelope.
 */
function creditUnfiledSql(budgetId?: string): string {
  return `SELECT substr(t.date,1,7) AS month, t.account_id AS account_id,
            SUM(t.amount) AS amount
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.deleted_at IS NULL AND a.kind = 'credit'
        AND t.is_split = 0 AND t.category_id IS NULL AND t.transfer_pair_id IS NULL
        AND t.date >= ? AND t.date <= ?${budgetClause(budgetId)}
      GROUP BY month, t.account_id`;
}

/** Raw movement per account and cleared flag — what a balance is made of. */
function balanceSql(budgetId?: string): string {
  return `SELECT substr(t.date,1,7) AS month, t.account_id AS account_id,
            CAST(t.cleared AS TEXT) AS kind, SUM(t.amount) AS amount
       FROM transactions t
      WHERE t.deleted_at IS NULL AND t.date >= ? AND t.date <= ?
      GROUP BY month, t.account_id, t.cleared`;
}

/**
 * B74 · Compute and store any sealed month that is missing, and report the last
 * month that is now covered by the rollup.
 *
 * Returns null when nothing is old enough to seal, in which case the caller
 * derives the whole range live exactly as it always did.
 */
function sealMonths(db: DB, months: MonthKey[], through: MonthKey): MonthKey | null {
  const cutoff = addMonths(monthOf(todayIST()), -ROLLUP_SEAL_AFTER_MONTHS);
  const sealable = months.filter((m) => m <= cutoff && m <= through);
  const last = sealable.at(-1);
  if (!last) return null;

  const built = new Set(
    queryAll<{ month: string }>(
      db, `SELECT month FROM month_rollup_state WHERE month <= ?`, last,
    ).map((r) => r.month),
  );
  const missing = sealable.filter((m) => !built.has(m));

  /*
   * Every sealable month is built before this returns, so the caller can read
   * `month <= last` and know it has the lot. A hole would be silent and wrong:
   * an edit to 2019-03 drops that month, and reading up to 2026-03 would then
   * miss a year of movement rather than fail.
   */
  if (missing.length === 0) return last;

  // One pass over the whole missing span rather than a query per month: the
  // months are contiguous in practice, and a first run has every month missing.
  const from = firstDayOfMonth(missing[0]!);
  const to = lastDayOfMonth(missing.at(-1)!);
  const wanted = new Set(missing);

  transact(db, () => {
    const insert = (
      month: string, fact: string,
      categoryId: string, accountId: string, kind: string, amount: number,
    ) => {
      if (!wanted.has(month as MonthKey)) return;
      execute(
        db,
        `INSERT INTO month_rollups (month, fact, category_id, account_id, kind, amount)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(month, fact, category_id, account_id, kind)
           DO UPDATE SET amount = amount + excluded.amount`,
        month, fact, categoryId, accountId, kind, amount,
      );
    };

    /*
     * 15 · The cache is built unscoped, on purpose. It summarises the ledger for
     * every budget at once and carries the account or category on each row, so a
     * scoped read filters it on the way out rather than needing one cache per
     * budget — which would multiply the invalidation triggers by the number of
     * members.
     */
    for (const r of queryAll<{
      month: string; category_id: string; account_id: string; kind: string; amount: number;
    }>(db, categorisedSql(), from, to, from, to)) {
      insert(r.month, "categorised", r.category_id, r.account_id, r.kind, r.amount);
    }
    for (const r of queryAll<{ month: string; account_id: string; kind: string; amount: number }>(
      db, accountFlowSql(), from, to,
    )) {
      insert(r.month, "account-flow", "", r.account_id, r.kind, r.amount);
    }
    for (const r of queryAll<{ month: string; account_id: string; amount: number }>(
      db, transferFlowSql(), from, to,
    )) {
      // 15 · Carrying the account is what lets a sealed month be read back for
      // one budget. Grouped by month alone, as it was, a transfer leg could not
      // be traced to whose money moved.
      insert(r.month, "transfer-flow", "", r.account_id, "", r.amount);
    }
    for (const r of queryAll<{ month: string; account_id: string; kind: string; amount: number }>(
      db, balanceSql(), from, to,
    )) {
      insert(r.month, "balance", "", r.account_id, r.kind, r.amount);
    }
    for (const r of queryAll<{ month: string; account_id: string; amount: number }>(
      db, creditUnfiledSql(), from, to,
    )) {
      insert(r.month, "credit-unfiled", "", r.account_id, "", r.amount);
    }

    const at = nowIST();
    for (const m of missing) {
      execute(
        db, `INSERT OR REPLACE INTO month_rollup_state (month, built_at) VALUES (?,?)`, m, at,
      );
    }
  });

  return last;
}

export interface LoadOptions {
  /** The latest month to compute. Defaults to the current month in IST. */
  through?: MonthKey;
  /**
   * 15 · Which budget to compute. Omitted means every budget at once, which is
   * what a household with only the one shared budget has always had and what
   * the export and backup want.
   */
  budgetId?: string;
  /**
   * B89 · Derive every month from the ledger, ignoring the rollup entirely.
   *
   * The rollup is a summary of the ledger, so the only question worth asking
   * about it is whether it still agrees with what it summarises — and that
   * cannot be asked from inside. Emptying the tables does not work: the next
   * read rebuilds them and compares the rollup against itself, which is exactly
   * how a dispatch bug that broke the accounting identity slipped through a
   * test written to catch it.
   *
   * This is the honest second opinion.
   */
  useRollup?: boolean;
}

export function loadEngineInput(db: DB, opts: LoadOptions = {}): EngineInput {
  const through = opts.through ?? monthOf(todayIST());
  const months = monthRange(db, through);
  const facts: Record<MonthKey, MonthlyFacts> = {};
  for (const m of months) facts[m] = emptyMonth();

  const ensure = (month: MonthKey): MonthlyFacts | null => facts[month] ?? null;

  /*
   * B73 · Everything below is bounded by the month being viewed.
   *
   * It used to be unbounded, so opening any month scanned the whole ledger and
   * then discarded the rows that fell outside the range. Looking at a month in
   * 2019 cost the same as looking at today.
   */
  const horizon = lastDayOfMonth(through);
  const scope = opts.budgetId;

  for (const r of queryAll<{ month: string; category_id: string; amount: number }>(
    db,
    `SELECT s.month AS month, s.category_id AS category_id, s.amount AS amount
       FROM assignments s
       JOIN categories c ON c.id = s.category_id
      WHERE s.month <= ?${scope ? " AND c.budget_id = ?" : ""}`,
    through, ...budgetParams(scope),
  )) {
    const f = ensure(r.month);
    if (f) f.assigned[r.category_id] = (f.assigned[r.category_id] ?? 0) + r.amount;
  }

  /*
   * B73 · One pass over categorised spending, not four.
   *
   * Activity, the credit-charged portion of it (R6's distinction between a
   * credit overspend and a cash one), that same portion split by card so the
   * debt can be attributed, and the budget-side total each ran their own copy
   * of the CTE — four full scans of transactions UNION splits, each grouping on
   * substr(date) where no index can help. Measured at twenty years of history
   * they were most of the cost of rendering the budget, and the month-by-month
   * fold everyone would suspect was 2% of it.
   *
   * B74 · And the scan now covers only the months that can still change.
   * Everything older is read from `month_rollups`, which costs months rather
   * than rows. `sealMonths` builds any sealed month that is missing before this
   * runs, so the two together always cover the whole range exactly once.
   */
  const sealedThrough = opts.useRollup === false ? null : sealMonths(db, months, through);
  const liveFrom = sealedThrough ? firstDayOfMonth(addMonths(sealedThrough, 1)) : null;

  const applyCategorised = (r: {
    month: string; category_id: string; account_id: string; kind: string; amount: number;
  }) => {
    const f = ensure(r.month);
    if (!f) return;
    f.activity[r.category_id] = (f.activity[r.category_id] ?? 0) + r.amount;
    if (r.kind === "credit") {
      f.creditActivity[r.category_id] = (f.creditActivity[r.category_id] ?? 0) + r.amount;
      const byAccount = (f.creditActivityByAccount[r.category_id] ??= {});
      byAccount[r.account_id] = (byAccount[r.account_id] ?? 0) + r.amount;
    } else if (r.kind === "budget") {
      f.budgetCategorisedFlow += r.amount;
    }
  };

  const applyUnfiled = (r: { month: string; account_id: string; amount: number }) => {
    const f = ensure(r.month);
    if (!f) return;
    f.creditUncategorisedFlow[r.account_id] =
      (f.creditUncategorisedFlow[r.account_id] ?? 0) + r.amount;
  };

  const applyAccountFlow = (r: { month: string; account_id: string; kind: string; amount: number }) => {
    const f = ensure(r.month);
    if (!f) return;
    if (r.kind === "credit") {
      f.creditAccountFlow[r.account_id] = (f.creditAccountFlow[r.account_id] ?? 0) + r.amount;
    } else {
      f.budgetAccountFlow += r.amount;
    }
  };

  // --- the sealed months, straight out of the rollup ------------------------
  if (sealedThrough) {
    for (const r of queryAll<{
      month: string; fact: string; category_id: string; account_id: string;
      kind: string; amount: number;
    }>(
      db,
      /*
       * Every fact row carries the account it moved on, or the category it
       * landed in, so one join scopes the whole cache. `categorised` rows carry
       * both and agree today, because 15 §3 forbids a personal account funding a
       * household envelope without a receivable.
       */
      `SELECT r.month AS month, r.fact AS fact, r.category_id AS category_id,
              r.account_id AS account_id, r.kind AS kind, r.amount AS amount
         FROM month_rollups r
         LEFT JOIN accounts a   ON a.id = r.account_id
         LEFT JOIN categories c ON c.id = r.category_id
        WHERE r.month <= ?
          ${scope ? "AND COALESCE(a.budget_id, c.budget_id) = ?" : ""}`,
      sealedThrough, ...budgetParams(scope),
    )) {
      /*
       * B89 · Match the fact by name, never by "everything else".
       *
       * This was written as an if/else chain ending in a bare else, and then a
       * fourth fact — the per-account balances accountBalances reads — was
       * added to the rollup without touching it. Every balance row was
       * therefore added to budgetTransferFlow, which broke the accounting
       * identity the moment any month was old enough to seal.
       *
       * An unknown fact is now ignored rather than quietly absorbed into
       * whichever term happened to be last.
       */
      if (r.fact === "categorised") applyCategorised(r);
      else if (r.fact === "account-flow") applyAccountFlow(r);
      else if (r.fact === "transfer-flow") {
        const f = ensure(r.month);
        if (f) f.budgetTransferFlow += r.amount;
      } else if (r.fact === "credit-unfiled") applyUnfiled(r);
    }
  }

  // --- and the months that can still change, derived live -------------------
  const since = liveFrom ?? "0000-01-01";

  for (const r of queryAll<{
    month: string; category_id: string; account_id: string; kind: string; amount: number;
  }>(db, categorisedSql(scope), since, horizon, since, horizon, ...budgetParams(scope))) {
    applyCategorised(r);
  }

  for (const r of queryAll<{ month: string; account_id: string; kind: string; amount: number }>(
    db, accountFlowSql(scope), since, horizon, ...budgetParams(scope),
  )) applyAccountFlow(r);

  for (const r of queryAll<{ month: string; account_id: string; amount: number }>(
    db, creditUnfiledSql(scope), since, horizon, ...budgetParams(scope),
  )) applyUnfiled(r);

  // F2.5: an opening balance arrives in RTA as income, in the month it is dated.
  // Not part of the rollup: it lives on the account, not on any transaction, so
  // no trigger could keep it in step. It is one row per account.
  for (const r of queryAll<{ month: string; amount: number }>(
    db,
    `SELECT substr(opening_date,1,7) AS month, SUM(opening_balance) AS amount
       FROM accounts
      WHERE kind = 'budget' AND opening_date <= ?${scope ? " AND budget_id = ?" : ""}
      GROUP BY month`,
    horizon, ...budgetParams(scope),
  )) {
    const f = ensure(r.month);
    if (f) f.budgetAccountFlow += r.amount;
  }

  for (const r of queryAll<{ month: string; amount: number }>(
    db, transferFlowSql(scope), since, horizon, ...budgetParams(scope),
  )) {
    const f = ensure(r.month);
    if (f) f.budgetTransferFlow += r.amount;
  }

  for (const r of queryAll<{ month: string; amount: number }>(
    db,
    `SELECT month, amount FROM held_for_next_month
      WHERE month <= ?${scope ? " AND budget_id = ?" : ""}`,
    through, ...budgetParams(scope),
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
  /*
   * B75 · `MIN(substr(date,1,7))` cannot use an index — SQLite has to read every
   * row to work out the minimum of an expression — so finding the first month
   * scanned the whole ledger, on every call, from both the budget and the
   * balances. Taking the MIN first and shortening it afterwards is the same
   * answer: an ISO date is fixed-width, so ordering by the whole string orders
   * by its prefix.
   */
  const earliest =
    queryValue<string>(
      db,
      `SELECT MIN(m) FROM (
         SELECT substr(MIN(date),1,7) AS m FROM transactions WHERE deleted_at IS NULL
         UNION ALL SELECT MIN(month) FROM assignments
         UNION ALL SELECT substr(MIN(opening_date),1,7) FROM accounts
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

  const add = (accountId: string, cleared: boolean, amount: number) => {
    const entry = out.get(accountId);
    if (!entry) return;
    if (cleared) entry.cleared += amount;
    else entry.uncleared += amount;
    entry.working += amount;
  };

  /*
   * B74 · A balance is the sum of every transaction ever, which is the other
   * place a long history was paid for on every page. It reads from the same
   * rollup, over the same sealed months, and derives only the recent window
   * live — there is no upper bound here, because a balance is as of now and a
   * transaction may be dated ahead.
   */
  const now = monthOf(todayIST());
  const sealedThrough = sealMonths(db, monthRange(db, now), now);

  if (sealedThrough) {
    for (const r of queryAll<{ account_id: string; kind: string; amount: number }>(
      db,
      `SELECT account_id, kind, SUM(amount) AS amount
         FROM month_rollups WHERE fact = 'balance' AND month <= ?
        GROUP BY account_id, kind`,
      sealedThrough,
    )) {
      add(r.account_id, r.kind === "1", r.amount);
    }
  }

  for (const r of queryAll<{ account_id: string; cleared: number; amount: number }>(
    db,
    `SELECT account_id, cleared, SUM(amount) AS amount
       FROM transactions
      WHERE deleted_at IS NULL AND date >= ?
      GROUP BY account_id, cleared`,
    sealedThrough ? firstDayOfMonth(addMonths(sealedThrough, 1)) : "0000-01-01",
  )) {
    add(r.account_id, Boolean(r.cleared), r.amount);
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
        WHERE c.amount < 0 AND cat.payment_account_id IS NULL`,
      // Each leg of the union is bounded to the window, so a long history
      // costs no more than a short one.
      from, asOf,
      from, asOf,
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
