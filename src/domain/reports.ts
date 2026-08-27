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
  todayIST, addDays, addMonths, monthOf, fiscalYearOf, fiscalYearRange,
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
  limit?: number;
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
  if (filter.from) { where.push("t.date >= ?"); params.push(filter.from); }
  if (filter.to) { where.push("t.date <= ?"); params.push(filter.to); }
  if (filter.direction === "out") where.push("line.amount < 0");
  if (filter.direction === "in") where.push("line.amount > 0");
  if (filter.uncategorisedOnly) where.push("line.category_id IS NULL");

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
export function incomeVsExpense(db: DB, from: IsoDate, to: IsoDate): TrendPoint[] {
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
      GROUP BY month ORDER BY month`,
    from, to,
  );

  return rows.map((r) => ({
    month: r.month,
    income: r.income,
    spending: r.spending,
    net: r.income - r.spending,
  }));
}

/** F10.1 · One category's trend, for the category detail sheet. */
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
 * A report only. The app computes no tax liability and gives no advice
 * (`02` L14, N15) — it states what was paid and leaves it there.
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
