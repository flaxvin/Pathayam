/**
 * F10 · Reports and the query screen · F16 · Search.
 *
 * F10.3 is the design decision that shapes this: **one** filterable, sortable,
 * groupable transaction table, saveable as a named view — rather than a
 * proliferation of report presets. The presets in F10.1 are then just saved
 * filters over the same query, which is why they cost almost nothing here.
 *
 * F10.2: every figure drills down to the transactions behind it, so no number
 * is a dead end.
 */

import type { DB } from "../db/db.ts";
import { queryAll } from "../db/db.ts";
import type { Paise } from "../core/money.ts";
import {
  todayIST, addDays, addMonths, monthOf, fiscalYearOf, fiscalYearRange, formatFiscalYear,
  type IsoDate, type MonthKey,
} from "../core/dates.ts";

export interface TransactionFilter {
  from?: IsoDate;
  to?: IsoDate;
  accountIds?: string[];
  categoryIds?: string[];
  payeeIds?: string[];
  tagNames?: string[];
  ownerIds?: string[];
  minAmount?: Paise;
  maxAmount?: Paise;
  /** F16.1: matches payees, memos and raw imported strings. */
  text?: string;
  direction?: "in" | "out";
  uncategorisedOnly?: boolean;
  includeTransfers?: boolean;
  /**
   * 15 · Which budget's money this is about.
   *
   * Deliberately an option rather than a default. `16`'s decision is that reports
   * offer every scope rather than picking one: a household wants to ask about its
   * own money, about somebody's own money, and about all of it, and which of those
   * is interesting changes with the question.
   *
   * A row belongs to a budget through **either** end — the account the money moved
   * on, or the envelope it was filed to — because those differ exactly when one of
   * you paid for something shared, and both answers are ones somebody might want.
   */
  budgetId?: string;
  /**
   * H2.2 · Who is asking.
   *
   * A private account is its holder's alone, and every index respected that —
   * the accounts list, net worth, the loans page — while this, the query every
   * other screen is built on, respected nothing. Query, its CSV export and the
   * reports all showed one member's private spending to the rest of the
   * household, line by line, payee and amount and envelope.
   *
   * Omitted means everything, which is what a whole-database export and the
   * month close want. Screens pass the authenticated member.
   */
  viewerMemberId?: string | null;
  limit?: number;
}

/**
 * H2.2 · The one predicate, so every report asks it the same way.
 *
 * A private account is its holder's alone. Passing `undefined` means "count
 * everything", which is what a whole-database export, a snapshot and the month
 * close want; a screen passes the authenticated member and gets their view.
 */
function visibilityClause(
  viewerMemberId: string | null | undefined, alias = "a",
): { sql: string; params: string[] } {
  if (viewerMemberId === undefined) return { sql: "", params: [] };
  return {
    sql: ` AND (${alias}.visibility <> 'private' OR ${alias}.holder_member_id IS ?)`,
    params: [viewerMemberId as string],
  };
}

export interface QueryRow {
  id: string;
  date: IsoDate;
  account: string;
  accountId: string;
  payee: string | null;
  category: string | null;
  categoryId: string | null;
  memo: string | null;
  amount: Paise;
  owner: string | null;
  cleared: number;
  isTransfer: number;
  raw_narration: string | null;
}

/**
 * The one query everything else is built on.
 *
 * Splits are expanded into their own rows so a split transaction appears once
 * per category — otherwise a spending-by-category report would attribute the
 * whole amount to whichever category happened to be first.
 */
export function queryTransactions(db: DB, filter: TransactionFilter = {}): QueryRow[] {
  const where: string[] = ["t.deleted_at IS NULL"];
  const params: (string | number)[] = [];

  if (!filter.includeTransfers) where.push("t.transfer_pair_id IS NULL");
  if (filter.viewerMemberId !== undefined) {
    // The same predicate the accounts list and net worth use, on the account the
    // money actually moved on.
    where.push("(a.visibility <> 'private' OR a.holder_member_id IS ?)");
    params.push(filter.viewerMemberId as string);
  }
  if (filter.from) { where.push("t.date >= ?"); params.push(filter.from); }
  if (filter.to) { where.push("t.date <= ?"); params.push(filter.to); }
  if (filter.direction === "out") where.push("line.amount < 0");
  if (filter.direction === "in") where.push("line.amount > 0");
  if (filter.uncategorisedOnly) where.push("line.category_id IS NULL");
  if (filter.budgetId) {
    where.push(
      `(a.budget_id = ? OR line.category_id IN (SELECT id FROM categories WHERE budget_id = ?))`,
    );
    params.push(filter.budgetId, filter.budgetId);
  }

  if (filter.accountIds?.length) {
    where.push(`t.account_id IN (${filter.accountIds.map(() => "?").join(",")})`);
    params.push(...filter.accountIds);
  }
  if (filter.categoryIds?.length) {
    where.push(`line.category_id IN (${filter.categoryIds.map(() => "?").join(",")})`);
    params.push(...filter.categoryIds);
  }
  if (filter.payeeIds?.length) {
    where.push(`t.payee_id IN (${filter.payeeIds.map(() => "?").join(",")})`);
    params.push(...filter.payeeIds);
  }
  if (filter.ownerIds?.length) {
    where.push(`t.owner_member_id IN (${filter.ownerIds.map(() => "?").join(",")})`);
    params.push(...filter.ownerIds);
  }
  if (filter.minAmount !== undefined) { where.push("ABS(line.amount) >= ?"); params.push(filter.minAmount); }
  if (filter.maxAmount !== undefined) { where.push("ABS(line.amount) <= ?"); params.push(filter.maxAmount); }

  if (filter.text) {
    // F16.1: payees, memos, categories, tags and the raw imported string.
    where.push(
      `(p.name LIKE ? OR t.memo LIKE ? OR t.raw_narration LIKE ? OR c.name LIKE ?
        OR EXISTS (SELECT 1 FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id
                    WHERE tt.transaction_id = t.id AND g.name LIKE ?))`,
    );
    const like = `%${filter.text}%`;
    params.push(like, like, like, like, like);
  }

  if (filter.tagNames?.length) {
    where.push(
      `EXISTS (SELECT 1 FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id
                WHERE tt.transaction_id = t.id
                  AND g.name IN (${filter.tagNames.map(() => "?").join(",")}))`,
    );
    params.push(...filter.tagNames);
  }

  params.push(filter.limit ?? 500);

  return queryAll<QueryRow>(
    db,
    `WITH lines AS (
       SELECT t.id AS tx_id, t.category_id AS category_id, t.amount AS amount
         FROM transactions t WHERE t.is_split = 0
       UNION ALL
       SELECT s.transaction_id, s.category_id, s.amount FROM transaction_splits s
     )
     SELECT t.id, t.date, a.name AS account, t.account_id AS accountId,
            p.name AS payee, c.name AS category, line.category_id AS categoryId,
            t.memo, line.amount AS amount, m.name AS owner, t.cleared,
            CASE WHEN t.transfer_pair_id IS NULL THEN 0 ELSE 1 END AS isTransfer,
            t.raw_narration
       FROM transactions t
       JOIN lines line ON line.tx_id = t.id
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN payees p ON p.id = t.payee_id
       LEFT JOIN categories c ON c.id = line.category_id
       LEFT JOIN members m ON m.id = t.owner_member_id
      WHERE ${where.join(" AND ")}
      ORDER BY t.date DESC, t.created_at DESC
      LIMIT ?`,
    ...params,
  );
}

export interface GroupedTotal {
  key: string;
  label: string;
  total: Paise;
  count: number;
}

export type GroupBy = "category" | "payee" | "account" | "owner" | "month" | "tag";

/** F10.3 · Group the same query by any dimension. */
export function groupTotals(rows: QueryRow[], by: GroupBy): GroupedTotal[] {
  const groups = new Map<string, GroupedTotal>();

  for (const row of rows) {
    const [key, label] =
      by === "category" ? [row.categoryId ?? "none", row.category ?? "Uncategorised"]
      : by === "payee" ? [row.payee ?? "none", row.payee ?? "No payee"]
      : by === "account" ? [row.accountId, row.account]
      : by === "owner" ? [row.owner ?? "none", row.owner ?? "Unattributed"]
      : [monthOf(row.date), monthOf(row.date)];

    const existing = groups.get(key) ?? { key, label, total: 0, count: 0 };
    existing.total += row.amount;
    existing.count++;
    groups.set(key, existing);
  }

  // Largest spend first — what a household actually wants to see.
  return [...groups.values()].sort((a, b) => a.total - b.total);
}

// ---------------------------------------------------------------------------
// F10.4 · Period presets, including the Indian fiscal year
// ---------------------------------------------------------------------------

export interface Period {
  key: string;
  label: string;
  from: IsoDate;
  to: IsoDate;
}

export function periodPresets(today = todayIST()): Period[] {
  const month = monthOf(today);
  const lastMonth = addMonths(month, -1);
  const year = Number(today.slice(0, 4));
  const fy = fiscalYearOf(today);
  const fyRange = fiscalYearRange(fy);
  const previousFy = fiscalYearRange(fy - 1);

  return [
    { key: "this-month", label: "This month", from: `${month}-01`, to: today },
    { key: "last-month", label: "Last month", from: `${lastMonth}-01`, to: `${month}-01` },
    { key: "last-3", label: "Last 3 months", from: addDays(today, -90), to: today },
    { key: "last-12", label: "Last 12 months", from: addDays(today, -365), to: today },
    // L4: the Indian financial year, alongside the calendar year.
    { key: "fy", label: `FY ${fy}-${String((fy + 1) % 100).padStart(2, "0")}`, from: fyRange.from, to: fyRange.to },
    {
      key: "fy-prev",
      label: `FY ${fy - 1}-${String(fy % 100).padStart(2, "0")}`,
      from: previousFy.from, to: previousFy.to,
    },
    { key: "calendar", label: `${year}`, from: `${year}-01-01`, to: `${year}-12-31` },
  ];
}

export function periodFor(key: string, today = todayIST()): Period {
  return periodPresets(today).find((p) => p.key === key) ?? periodPresets(today)[0]!;
}

// ---------------------------------------------------------------------------
// F10.1 · The preset reports
// ---------------------------------------------------------------------------

export interface TrendPoint {
  month: MonthKey;
  income: Paise;
  spending: Paise;
  net: Paise;
}

/** F10.1 · Income against expense over time, and the net cash position. */
export function incomeVsExpense(
  db: DB, from: IsoDate, to: IsoDate, budgetId?: string,
  viewerMemberId?: string | null,
): TrendPoint[] {
  // 15 · Cash in and out of one budget's accounts, when asked for one.
  const seen = visibilityClause(viewerMemberId);
  const rows = queryAll<{ month: string; income: number; spending: number }>(
    db,
    `SELECT substr(t.date,1,7) AS month,
            COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END),0) AS income,
            COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END),0) AS spending
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.deleted_at IS NULL AND a.kind = 'budget'
        AND t.transfer_pair_id IS NULL
        AND t.date >= ? AND t.date <= ?
        ${budgetId ? "AND a.budget_id = ?" : ""}${seen.sql}
      GROUP BY month ORDER BY month`,
    from, to, ...(budgetId ? [budgetId] : []), ...seen.params,
  );

  return rows.map((r) => ({
    month: r.month,
    income: r.income,
    spending: r.spending,
    net: r.income - r.spending,
  }));
}

/**
 * B78 · What the household actually spent in a month.
 *
 * `incomeVsExpense` above measures cash moving through budget accounts, which
 * is the right question for a cashflow chart and the wrong one for "what did we
 * spend". It filters `a.kind = 'budget'`, so every rupee charged to a credit
 * card is invisible to it — and in this household most discretionary spending
 * goes on a card. Measured on the demo data the gap was ₹1,060 against ₹22,010.
 *
 * Spending, in an envelope budget, is money leaving an envelope. R6 is explicit
 * that a card charge consumes its category the moment it happens, whatever
 * settles the card later. So this counts categorised outflow across every
 * account kind, and excludes payment categories — paying the card off is not a
 * second act of spending, it is settling the first.
 *
 * This is the same definition `averageDailySpend` already uses for R12's
 * buffer; it simply had no monthly form, so the Overview reached for the
 * cashflow number instead.
 */
export function envelopeSpendByMonth(
  db: DB, from: IsoDate, to: IsoDate, budgetId?: string, viewerMemberId?: string | null,
): { month: string; spent: Paise }[] {
  const seen = visibilityClause(viewerMemberId);
  // 15 · Spending belongs to the envelope's budget, which is the budget that
  // planned for it — the same rule the engine uses (15 §3A.4).
  return queryAll<{ month: string; spent: number }>(
    db,
    `WITH categorised AS (
       SELECT t.date AS date, t.category_id AS category_id, t.amount AS amount
         FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.deleted_at IS NULL AND t.is_split = 0 AND t.category_id IS NOT NULL
          AND t.date >= ? AND t.date <= ?${seen.sql}
       UNION ALL
       SELECT t.date, s.category_id, s.amount
         FROM transaction_splits s
         JOIN transactions t ON t.id = s.transaction_id
         JOIN accounts a ON a.id = t.account_id
        WHERE t.deleted_at IS NULL AND s.category_id IS NOT NULL
          AND t.date >= ? AND t.date <= ?${seen.sql}
     )
     SELECT substr(c.date,1,7) AS month, COALESCE(SUM(-c.amount),0) AS spent
       FROM categorised c
       JOIN categories cat ON cat.id = c.category_id
      WHERE c.amount < 0 AND cat.payment_account_id IS NULL
        ${budgetId ? "AND cat.budget_id = ?" : ""}
      GROUP BY month ORDER BY month`,
    from, to, ...seen.params, from, to, ...seen.params, ...(budgetId ? [budgetId] : []),
  ).map((r) => ({ month: r.month, spent: r.spent as Paise }));
}

/** F10.1 · One category's trend, for the category detail sheet. */
/**
 * F12 · Spend per tag over a window — tags work as ad-hoc budgets, so this is
 * how much each one has actually taken, with its budget where one was set.
 */
export function spendByTag(
  db: DB, from: IsoDate, to: IsoDate, viewerMemberId?: string | null,
): { tag: string; spent: Paise; budget: Paise | null }[] {
  const seen = visibilityClause(viewerMemberId);
  return queryAll<{ tag: string; spent: number; budget: number | null }>(
    db,
    `SELECT g.name AS tag,
            COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END),0) AS spent,
            g.budget_amount AS budget
       FROM tags g
       JOIN transaction_tags tt ON tt.tag_id = g.id
       JOIN transactions t ON t.id = tt.transaction_id
       JOIN accounts a ON a.id = t.account_id
      WHERE t.deleted_at IS NULL AND t.date >= ? AND t.date <= ?${seen.sql}
      GROUP BY g.id HAVING spent > 0
      ORDER BY spent DESC`,
    from, to, ...seen.params,
  ).map((r) => ({ tag: r.tag, spent: r.spent as Paise, budget: r.budget as Paise | null }));
}

/** S15 · Total spend per day over a window, for the heatmap calendar. */
export function spendingCalendar(
  db: DB, from: IsoDate, to: IsoDate, viewerMemberId?: string | null,
): { date: IsoDate; value: Paise }[] {
  const seen = visibilityClause(viewerMemberId);
  return queryAll<{ date: string; value: number }>(
    db,
    `WITH lines AS (
       SELECT t.date AS date, t.amount AS amount
         FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.is_split = 0 AND t.deleted_at IS NULL${seen.sql}
       UNION ALL
       SELECT t.date, s.amount FROM transaction_splits s
         JOIN transactions t ON t.id = s.transaction_id
         JOIN accounts a ON a.id = t.account_id
        WHERE t.deleted_at IS NULL${seen.sql}
     )
     SELECT substr(date,1,10) AS date, COALESCE(SUM(-amount),0) AS value
       FROM lines WHERE amount < 0 AND date >= ? AND date <= ?
      GROUP BY substr(date,1,10) ORDER BY date`,
    ...seen.params, ...seen.params, from, to,
  ).map((r) => ({ date: r.date as IsoDate, value: r.value as Paise }));
}

export function categoryTrend(
  db: DB, categoryId: string, months = 12, today = todayIST(),
): { month: MonthKey; assigned: Paise; spent: Paise }[] {
  const from = `${addMonths(monthOf(today), -(months - 1))}-01`;

  const assigned = new Map(
    queryAll<{ month: string; amount: number }>(
      db, `SELECT month, amount FROM assignments WHERE category_id = ? AND month >= ?`,
      categoryId, from.slice(0, 7),
    ).map((r) => [r.month, r.amount]),
  );

  const spent = new Map(
    queryAll<{ month: string; total: number }>(
      db,
      `WITH lines AS (
         SELECT t.date AS date, t.category_id AS category_id, t.amount AS amount
           FROM transactions t WHERE t.is_split = 0 AND t.deleted_at IS NULL
         UNION ALL
         SELECT t.date, s.category_id, s.amount
           FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
          WHERE t.deleted_at IS NULL
       )
       SELECT substr(date,1,7) AS month, COALESCE(SUM(-amount),0) AS total
         FROM lines WHERE category_id = ? AND date >= ? GROUP BY month`,
      categoryId, from,
    ).map((r) => [r.month, r.total]),
  );

  const out: { month: MonthKey; assigned: Paise; spent: Paise }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const month = addMonths(monthOf(today), -i);
    out.push({ month, assigned: assigned.get(month) ?? 0, spent: spent.get(month) ?? 0 });
  }
  return out;
}

/**
 * L14 / Q13 · Interest and principal per financial year, across all loans.
 *
 * A report only: it states what was paid and leaves it there. It is not read
 * by the tax estimate, and deliberately so — interest under section 24(b) is
 * claimed on an accrual basis against a specific property, and this figure is
 * cash paid across every loan. Q31 reversed L14 and N15, but not into here.
 */
export function loanInterestByFinancialYear(
  db: DB,
): { fy: number; label: string; interest: Paise; principal: Paise; lender: string }[] {
  const rows = queryAll<{ date: string; interest: number; principal: number; lender: string }>(
    db,
    `SELECT p.date, p.interest, p.principal, l.lender
       FROM loan_payments p JOIN loans l ON l.id = p.loan_id
      ORDER BY p.date`,
  );

  const groups = new Map<string, { fy: number; interest: Paise; principal: Paise; lender: string }>();
  for (const row of rows) {
    const fy = fiscalYearOf(row.date);
    const key = `${fy}:${row.lender}`;
    const existing = groups.get(key) ?? { fy, interest: 0, principal: 0, lender: row.lender };
    existing.interest += row.interest;
    existing.principal += row.principal;
    groups.set(key, existing);
  }

  return [...groups.values()]
    .map((g) => ({
      ...g,
      label: `FY ${g.fy}-${String((g.fy + 1) % 100).padStart(2, "0")}`,
    }))
    .sort((a, b) => b.fy - a.fy || a.lender.localeCompare(b.lender));
}

/**
 * B84 · What the household has paid for and expects back.
 *
 * `reimbursable` has been a column on every transaction, settable through the
 * domain, since the beginning — with no screen that set it and no screen that
 * showed it. Money fronted for an office claim or a sibling is real, and until
 * it comes back it is the one kind of spending that is not really spending.
 *
 * Still counted against its envelope while it is outstanding, because that is
 * the truth about the money right now: it has left. This only makes the amount
 * visible so nobody forgets to chase it.
 */
export interface OutstandingClaim {
  id: string;
  date: IsoDate;
  amount: Paise;
  payee: string | null;
  memo: string | null;
  category: string | null;
}

export function outstandingReimbursements(db: DB): OutstandingClaim[] {
  return queryAll<{
    id: string; date: IsoDate; amount: number;
    payee: string | null; memo: string | null; category: string | null;
  }>(
    db,
    `SELECT t.id, t.date, t.amount, p.name AS payee, t.memo, c.name AS category
       FROM transactions t
       LEFT JOIN payees p ON p.id = t.payee_id
       LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.deleted_at IS NULL AND t.reimbursable = 1
      ORDER BY t.date DESC`,
  ).map((r) => ({ ...r, amount: Math.abs(r.amount) as Paise }));
}

/**
 * B88 · Realised gains, by financial year and holding period.
 *
 * The app already reports loan interest per FY per lender — the number a home
 * loan's 24(b) claim is built from — so it is squarely in the business of
 * handing the household the facts a return is assembled from. It stopped one
 * report short of the one that actually costs an evening every July.
 *
 * What this does *not* do is compute tax. Which threshold separates short from
 * long depends on the asset and on the year's rules, and both change; deciding
 * that here would be exactly the advice the app declines to give (N9). So this
 * splits at twelve months, names the split as a holding period rather than a
 * tax class, and reports the days. Applying the right rule stays with whoever
 * files the return.
 *
 * Sales recorded before parcels were stored (B88) have no breakdown. They are
 * reported under `unknownPeriod` rather than guessed at, because a gain filed
 * in the wrong column is worse than one the household is told to check.
 */
const LONG_TERM_DAYS = 365;

export interface GainsParcel {
  soldOn: IsoDate;
  instrument: string;
  acquiredOn: IsoDate;
  holdingPeriodDays: number;
  cost: Paise;
  proceeds: Paise;
  gain: Paise;
  longTerm: boolean;
}

export interface GainsYear {
  fy: number;
  label: string;
  shortTerm: Paise;
  longTerm: Paise;
  unknownPeriod: Paise;
  proceeds: Paise;
  parcels: GainsParcel[];
}

export function capitalGainsByYear(db: DB): GainsYear[] {
  const sales = queryAll<{
    date: IsoDate; realised_gain: number | null; amount: number | null;
    detail_json: string | null; instrument: string;
  }>(
    db,
    `SELECT e.date, e.realised_gain, e.amount, e.detail_json, i.name AS instrument
       FROM holding_events e
       JOIN holdings h ON h.id = e.holding_id
       JOIN instruments i ON i.id = h.instrument_id
      WHERE e.kind = 'sale'
      ORDER BY e.date`,
  );

  const years = new Map<number, GainsYear>();
  const yearFor = (fy: number): GainsYear => {
    let year = years.get(fy);
    if (!year) {
      year = {
        fy, label: formatFiscalYear(fy),
        shortTerm: 0, longTerm: 0, unknownPeriod: 0, proceeds: 0, parcels: [],
      };
      years.set(fy, year);
    }
    return year;
  };

  for (const sale of sales) {
    const year = yearFor(fiscalYearOf(sale.date));
    year.proceeds = (year.proceeds + (sale.amount ?? 0)) as Paise;

    let parcels: { tradeDate: IsoDate; cost: number; proceeds: number; holdingPeriodDays: number }[] = [];
    try {
      parcels = sale.detail_json ? (JSON.parse(sale.detail_json).parcels ?? []) : [];
    } catch {
      parcels = [];
    }

    if (parcels.length === 0) {
      year.unknownPeriod = (year.unknownPeriod + (sale.realised_gain ?? 0)) as Paise;
      continue;
    }

    for (const parcel of parcels) {
      const gain = (parcel.proceeds - parcel.cost) as Paise;
      const longTerm = parcel.holdingPeriodDays > LONG_TERM_DAYS;
      if (longTerm) year.longTerm = (year.longTerm + gain) as Paise;
      else year.shortTerm = (year.shortTerm + gain) as Paise;

      year.parcels.push({
        soldOn: sale.date,
        instrument: sale.instrument,
        acquiredOn: parcel.tradeDate,
        holdingPeriodDays: parcel.holdingPeriodDays,
        cost: parcel.cost as Paise,
        proceeds: parcel.proceeds as Paise,
        gain,
        longTerm,
      });
    }
  }

  return [...years.values()].sort((a, b) => b.fy - a.fy);
}

/** F10.5 · Every report exports to CSV. */
export function rowsToCsv(rows: QueryRow[]): string {
  const headers = ["date", "account", "payee", "category", "memo", "amount", "owner", "cleared", "raw_narration"];
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    headers.join(","),
    ...rows.map((r) =>
      [r.date, r.account, r.payee, r.category, r.memo, r.amount / 100, r.owner, r.cleared, r.raw_narration]
        .map(escape).join(","),
    ),
  ].join("\n");
}
