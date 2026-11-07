/**
 * Read-only analysis, for an AI client and the snapshot export.
 *
 * Every function here answers one question a household might put to an
 * assistant — "what is ready to assign", "what did we spend on food since
 * April", "when does the car loan close" — with the figures the matching
 * screen shows, as plain JSON an LLM can read without a legend:
 *
 * - **snake_case names that do not move.** The MCP layer and whoever reads a
 *   pasted snapshot both lean on them; renaming one is a breaking change.
 * - **Rupees, not paise.** The app keeps integer paise (core/money.ts) and a
 *   model handed `1234500` will happily call it twelve lakh. Every amount is
 *   converted in `inr()` and nowhere else, to a number with two decimals.
 * - **ISO dates**, YYYY-MM-DD, and months as YYYY-MM.
 * - **Names beside ids**, so a row read on its own still says what it is.
 * - `currency: "INR"` once, at the top of anything composite.
 *
 * Privacy is the screens' privacy, by construction rather than by care: each
 * function calls the same domain functions its route calls, with the same
 * viewer, so another member's private account, loan, policy or personal
 * envelope is absent from lists, counts and totals here exactly as it is on
 * screen (docs/privacy.md). An id the viewer may not see answers `Missing` —
 * not-found, never forbidden — the same as one that does not exist.
 *
 * Nothing here writes. Some of what it calls is heavy (the budget engine walks
 * history), so the snapshot reuses one call wherever two sections need it.
 */

import type { DB } from "../db/db.ts";
import { queryAll } from "../db/db.ts";
import type { Paise } from "../core/money.ts";
import { Refusal, Missing } from "../core/refusal.ts";
import {
  todayIST, nowIST, addDays, addMonths, monthOf, isMonthKey, parseDate,
  fiscalYearOf, fiscalYearRange, formatFiscalYear, type IsoDate, type MonthKey,
} from "../core/dates.ts";
import { listMembers, getMember } from "../auth/sessions.ts";
import { historyFor } from "../core/events.ts";
import { budgetsFor, type Budget } from "../domain/budgets.ts";
import { listAccounts, SUBTYPE_LABELS } from "../domain/accounts.ts";
import { listCategories } from "../domain/budget.ts";
import { memberScope, hiddenTransactionSql } from "../domain/member-scope.ts";
import {
  listLoans, projectLoan, canSeeLoan, listPayments, debtOverview, LOAN_TYPE_LABELS,
  type LoanProjection,
} from "../domain/loans.ts";
import { assetAllocation, netWorthStatement, netWorthHistory, netWorthChange } from "../domain/networth.ts";
import { capitalGainsByYear, queryTransactions, groupTotals, type QueryRow } from "../domain/reports.ts";
import { listSchedules, projectCashflow, describeCashflow, type Cashflow } from "../domain/schedules.ts";
import { listMaturities } from "../domain/deposits.ts";
import {
  listPolicies, policiesDueBy, isCurrent, KIND_LABELS, FREQUENCY_LABELS, TAX_GROUP_LABELS,
} from "../domain/insurance.ts";
import { goalProgress } from "../domain/goals.ts";
import { fireProjection } from "../domain/fire.ts";
import { monthInReach } from "../engine/repository.ts";
import { UNIT_SCALE, PRICE_SCALE, type MicroRupees } from "../portfolio/holdings.ts";
import { buildBudgetView, type BudgetView, type CategoryView } from "../web/viewmodel.ts";
import {
  accountRows, cardsDue, overviewData, portfolioData, taxPageModel, scheduleInScope,
} from "../web/screen-data.ts";
import { explainLineFor } from "../web/pages/actions.ts";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export const CURRENCY = "INR" as const;

/**
 * The deployment's feature switches, which the functions cannot read for
 * themselves (they live in Config, not the database). Omitted means on, the
 * same default `loadConfig` has. A section whose feature is off answers
 * `{ enabled: false }` rather than throwing, so a composite still renders.
 */
export interface AnalysisOptions {
  features?: { loans?: boolean; assets?: boolean };
}

export interface Disabled { enabled: false; reason: string }

const DISABLED_ASSETS: Disabled = { enabled: false, reason: "Portfolio and net worth are switched off on this server." };
const DISABLED_LOANS: Disabled = { enabled: false, reason: "Loans are switched off on this server." };

function assetsOn(opts: AnalysisOptions): boolean { return opts.features?.assets !== false; }
function loansOn(opts: AnalysisOptions): boolean { return opts.features?.loans !== false; }

/**
 * Paise to rupees, the one conversion. The engine may carry a fraction of a
 * paisa (rounding is display-only, money.ts), so it is rounded to the paisa
 * first; the division by 100 of an integer then lands on two decimals.
 */
export function inr(paise: number): number;
export function inr(paise: number | null | undefined): number | null;
export function inr(paise: number | null | undefined): number | null {
  if (paise === null || paise === undefined || !Number.isFinite(paise)) return null;
  const rounded = Math.round(paise);
  // `+ 0` folds −0 into 0, which JSON would otherwise print as "0" anyway but
  // a deepEqual in a test would not.
  return rounded / 100 + 0;
}

/** Rupees in (a filter an AI typed), paise out. */
function paiseFrom(rupees: number, what: string): Paise {
  if (typeof rupees !== "number" || !Number.isFinite(rupees)) {
    throw new Refusal(`${what} must be a number of rupees.`);
  }
  return Math.round(rupees * 100) as Paise;
}

/** A timestamp's date, or a date as it is. */
function isoDay(value: string | null | undefined): IsoDate | null {
  return value ? value.slice(0, 10) : null;
}

function round(n: number | null | undefined, places = 2): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function requireMonth(month: string | undefined, db: DB): MonthKey {
  if (month === undefined || month === null || month === "") return monthOf(todayIST());
  if (!isMonthKey(month)) throw new Refusal(`"${month}" is not a month. Use YYYY-MM, e.g. ${monthOf(todayIST())}.`);
  // BUDGET-13 · Never another month's figures under this month's name.
  if (!monthInReach(db, month)) {
    throw new Refusal(`${month} is too far from the rest of this budget for it to reach.`);
  }
  return month;
}

function requireDate(value: string | undefined, what: string): IsoDate | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  // Strictly ISO: "03/04/2026" means two different days depending on who typed it.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || parseDate(value) !== value) {
    throw new Refusal(`${what} "${value}" is not a date. Use YYYY-MM-DD.`);
  }
  return value;
}

/** A financial year as its starting calendar year: 2026, "2026", "2026-27" or "FY 2026-27". */
function requireFy(fy: number | string | undefined): number {
  if (fy === undefined || fy === null || fy === "") return fiscalYearOf(todayIST());
  const m = String(fy).trim().match(/^(?:FY\s*)?(\d{4})(?:\s*[-–/]\s*(\d{2}|\d{4}))?$/i);
  const year = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(year) || year <= 2000 || year >= 9999) {
    throw new Refusal(`"${fy}" is not a financial year. Use its first year, e.g. ${fiscalYearOf(todayIST())} for ${formatFiscalYear(fiscalYearOf(todayIST()))}.`);
  }
  return year;
}

function memberNames(db: DB): Map<string, string> {
  return new Map(listMembers(db, { includeRemoved: true }).map((m) => [m.id, m.name]));
}

/** The household's budget and the viewer's own, labelled for a reader. */
function visibleBudgets(db: DB, viewerMemberId: string): (Budget & { label: string })[] {
  return budgetsFor(db, viewerMemberId)
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "household" ? -1 : 1))
    .map((b) => ({
      ...b,
      label: b.kind === "household" ? "Household budget" : `${b.name}'s personal budget`,
    }));
}

function budgetRef(b: Budget & { label: string }) {
  return { budget_id: b.id, budget_name: b.label, budget_kind: b.kind };
}

/**
 * The envelopes of a budget view that the viewer may see.
 *
 * buildBudgetView already keeps to the household's budget and the viewer's
 * own; memberScope's envelope list is asked as well, because it also hides a
 * card payment envelope whose card is somebody else's private account. Belt
 * and braces, and cheap.
 */
function visibleCategories(view: BudgetView, hidden: Set<string>): CategoryView[] {
  return [...view.categories.values()].filter((c) => !hidden.has(c.id));
}

function accountName(a: { name: string; nickname: string | null }): string {
  return a.nickname || a.name;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/** The home screen's headline figures: one entry per budget the viewer has. */
export function aiOverview(
  db: DB, viewerMemberId: string, args: { month?: string } = {}, opts: AnalysisOptions = {},
) {
  const month = requireMonth(args.month, db);
  const hidden = memberScope(db, viewerMemberId).categories;
  const budgets = visibleBudgets(db, viewerMemberId).map((b) => {
    const view = buildBudgetView(db, month, b.id, viewerMemberId);
    const now = overviewData(db, { budgetId: b.id, viewerMemberId, assets: assetsOn(opts) });
    const categories = visibleCategories(view, hidden);
    const names = new Map(categories.map((c) => [c.paymentAccountId, c.name]));
    return {
      ...budgetRef(b),
      month,
      ready_to_assign: inr(view.monthState.readyToAssign),
      ready_to_assign_state: view.monthState.rtaState,
      overspent_envelopes: categories
        .filter((c) => c.state.balance < 0 && !c.hidden)
        .map((c) => ({
          category_id: c.id, name: c.name, available: inr(c.state.balance), state: c.stateLabel,
        })),
      // R6 · Card debt no envelope is holding money for.
      card_payment_shortfall: view.cards
        .filter((c) => c.unfunded > 0 && names.has(c.accountId))
        .map((c) => ({ account_id: c.accountId, name: names.get(c.accountId)!, unfunded: inr(c.unfunded) })),
      underfunded_targets: { amount: inr(view.underfunded.amount), envelope_count: view.underfunded.categoryCount },
      // The rest is today's, whatever month was asked about — as on the Overview.
      // DEBUG-ENGINE-9 · One budget's cash, as the Overview and Schedules ask it.
      cashflow_next_14_days: cashflowHeadline(projectCashflow(db, { days: 14, budgetId: b.id, viewerMemberId })),
      spent_this_month: inr(now.monthSpend),
      cash_in_budget_accounts: inr(now.cash),
      runway_months: round(now.runwayMonths, 1),
      due_in_14_days: now.dueSoon.map((d) => ({
        kind: d.policy ? "insurance_premium" : "schedule",
        id: d.id, name: d.name, amount: inr(d.amount), due_date: d.nextDue,
      })),
      maturing_in_14_days: (now.maturing ?? []).map((m) => ({
        account_id: m.accountId, name: m.name, amount: inr(m.amount), date: m.date,
      })),
      insights: now.insights.map((i) => ({
        kind: i.kind, category_id: i.categoryId, category_name: i.categoryName,
        this_month: inr(i.current), usual: inr(i.baseline), text: i.text,
      })),
    };
  });

  const accounts = aiAccounts(db, viewerMemberId, {}, opts);

  return {
    currency: CURRENCY,
    as_of: todayIST(),
    month,
    budgets,
    account_totals_by_kind: accounts.totals_by_kind,
    net_worth: assetsOn(opts)
      ? (() => {
          const s = netWorthStatement(db, undefined, "INR", { viewerMemberId });
          return {
            enabled: true as const,
            net_worth: inr(s.netWorth), total_assets: inr(s.totalAssets),
            total_liabilities: inr(s.totalLiabilities), as_of: s.asOf,
          };
        })()
      : DISABLED_ASSETS,
  };
}

/** A cashflow projection's headline: where the cash starts, its low point, what leaves. */
function cashflowHeadline(cashflow: Cashflow) {
  const out = cashflow.days.flatMap((d) => d.outflows);
  const into = cashflow.days.flatMap((d) => d.inflows);
  return {
    opening_balance: inr(cashflow.openingBalance),
    lowest_balance: inr(cashflow.lowestBalance),
    lowest_on: cashflow.lowestOn,
    first_shortfall: cashflow.firstShortfall,
    inflow_total: inr(into.reduce((s, o) => s + o.amount, 0)),
    outflow_count: out.length,
    outflow_total: inr(out.reduce((s, o) => s + o.amount, 0)),
    summary: describeCashflow(cashflow),
  };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * Every account the viewer is shown on the Accounts screen, across the
 * budgets they can switch between, plus the tracking accounts. No account
 * number beyond the last four, which every screen prints beside the name.
 */
export function aiAccounts(
  db: DB, viewerMemberId: string, args: { includeClosed?: boolean } = {}, _opts: AnalysisOptions = {},
) {
  const budgets = visibleBudgets(db, viewerMemberId);
  const budgetLabel = new Map(budgets.map((b) => [b.id, b.label]));
  const seen = new Set<string>();
  const accounts = budgets.flatMap((b) =>
    accountRows(db, { budgetId: b.id, viewerMemberId, includeClosed: Boolean(args.includeClosed) }),
  )
    .filter((row) => (seen.has(row.account.id) ? false : (seen.add(row.account.id), true)))
    .map((row) => {
      const a = row.account;
      // What the account is worth where that is not its register (a loan, a
      // demat, a valued asset, a deposit with terms) — the figure the list shows.
      const worth = row.deposit?.value ?? row.derived?.value ?? row.balances.working;
      return {
        account_id: a.id,
        name: accountName(a),
        official_name: a.nickname ? a.name : null,
        kind: a.kind,
        type: a.subtype,
        type_label: SUBTYPE_LABELS[a.subtype] ?? a.subtype,
        institution: a.institution,
        last4: a.last4,
        currency: a.currency,
        budget_id: a.budget_id,
        budget_name: a.budget_id ? budgetLabel.get(a.budget_id) ?? null : null,
        holder_name: row.holderName ?? null,
        visibility: a.visibility,
        closed: a.closed_at !== null,
        closed_on: isoDay(a.closed_at),
        balance: inr(row.balances.working),
        cleared_balance: inr(row.balances.cleared),
        uncleared_balance: inr(row.balances.uncleared),
        uncleared_count: row.unclearedCount,
        value: inr(worth),
        value_source: row.deposit ? `deposit (${row.deposit.source === "terms" ? "computed from its terms" : "valued by hand"})`
          : row.derived ? row.derived.label.replace(/^Open (the )?/, "")
          : "register balance",
        last_reconciled: row.lastReconciled,
        card: a.kind === "credit"
          ? {
              owed: inr(Math.max(0, -(row.funding?.outstanding ?? row.balances.working))),
              payment_envelope_holds: inr(row.funding?.funded ?? 0),
              unfunded: inr(row.funding?.unfunded ?? 0),
              credit_limit: inr(a.credit_limit),
              statement_day: a.statement_day,
              due_day: a.due_day,
            }
          : null,
      };
    });

  const totals = new Map<string, { kind: string; count: number; total: number }>();
  for (const a of accounts) {
    if (a.closed) continue;
    const t = totals.get(a.kind) ?? { kind: a.kind, count: 0, total: 0 };
    t.count++;
    t.total += Math.round((a.value ?? 0) * 100);
    totals.set(a.kind, t);
  }

  return {
    currency: CURRENCY,
    as_of: todayIST(),
    accounts,
    totals_by_kind: [...totals.values()].map((t) => ({
      kind: t.kind, account_count: t.count, total: inr(t.total),
      meaning: t.kind === "budget" ? "cash in accounts that fund a budget"
        : t.kind === "credit" ? "card balances (negative is owed)"
        : "tracking accounts: loans, deposits, investments and assets outside the budget",
    })),
  };
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export const TRANSACTIONS_DEFAULT_LIMIT = 100;
export const TRANSACTIONS_MAX_LIMIT = 500;

export interface TransactionsArgs {
  from?: string;
  to?: string;
  account_id?: string;
  category_id?: string;
  /** Part of a payee's name, any case. */
  payee?: string;
  /** Payees, memos, envelopes, tags and the bank's own narration (as /query's search). */
  text?: string;
  /** Rupees, compared with the size of each line whatever its sign. */
  min_amount?: number;
  max_amount?: number;
  /** Transfers between accounts are left out, as on /query, unless asked for. */
  include_transfers?: boolean;
  limit?: number;
  cursor?: string;
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown };
    if (typeof parsed.o === "number" && Number.isInteger(parsed.o) && parsed.o >= 0) return parsed.o;
  } catch { /* falls through to the refusal */ }
  throw new Refusal("That cursor is not one this server gave out. Start again without it.");
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

/**
 * The /query screen's query, newest first, one entry per transaction with a
 * split shown as its lines. Totals and `total_matching` are over every match,
 * not the page (B96).
 *
 * The cursor is an offset into the same ordering, so a page fetched after
 * something new was entered may repeat or skip a row at the boundary; it is
 * opaque so that can change without the callers noticing.
 */
export function aiTransactions(
  db: DB, viewerMemberId: string, args: TransactionsArgs = {}, _opts: AnalysisOptions = {},
) {
  const from = requireDate(args.from, "from");
  const to = requireDate(args.to, "to");
  if (from && to && from > to) throw new Refusal(`"from" (${from}) is after "to" (${to}).`);

  // An id the viewer may not see is the same answer as one that does not exist.
  if (args.account_id !== undefined) {
    const visible = listAccounts(db, { viewerMemberId, includeClosed: true }).some((a) => a.id === args.account_id);
    if (!visible) throw new Missing("That account does not exist.");
  }
  if (args.category_id !== undefined) {
    const visible = listCategories(db, { includeHidden: true, viewerMemberId })
      .some((c) => c.id === args.category_id)
      && !memberScope(db, viewerMemberId).categories.has(args.category_id);
    if (!visible) throw new Missing("That envelope does not exist.");
  }

  const requested = args.limit ?? TRANSACTIONS_DEFAULT_LIMIT;
  if (!Number.isInteger(requested) || requested < 1) throw new Refusal("limit must be a whole number, 1 or more.");
  const limit = Math.min(requested, TRANSACTIONS_MAX_LIMIT);
  const offset = decodeCursor(args.cursor);

  const lines = queryTransactions(db, {
    from, to,
    accountIds: args.account_id ? [args.account_id] : undefined,
    categoryIds: args.category_id ? [args.category_id] : undefined,
    text: args.text?.trim() || undefined,
    minAmount: args.min_amount !== undefined ? paiseFrom(args.min_amount, "min_amount") : undefined,
    maxAmount: args.max_amount !== undefined ? paiseFrom(args.max_amount, "max_amount") : undefined,
    includeTransfers: Boolean(args.include_transfers),
    viewerMemberId,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const payee = args.payee?.trim().toLowerCase();
  const matching = payee ? lines.filter((l) => (l.payee ?? "").toLowerCase().includes(payee)) : lines;

  // Lines to transactions, keeping the query's order (newest first).
  const grouped = new Map<string, QueryRow[]>();
  for (const line of matching) {
    const list = grouped.get(line.id);
    if (list) list.push(line);
    else grouped.set(line.id, [line]);
  }
  const all = [...grouped.values()];
  const page = all.slice(offset, offset + limit);

  const ids = page.map((rows) => rows[0]!.id);
  const facts = new Map(
    ids.length === 0 ? [] : queryAll<{ id: string; amount: number; is_split: number }>(
      db,
      `SELECT id, amount, is_split FROM transactions WHERE id IN (${ids.map(() => "?").join(",")})`,
      ...ids,
    ).map((r) => [r.id, r]),
  );

  const sum = (rows: QueryRow[]) => rows.reduce((s, r) => s + r.amount, 0);
  return {
    currency: CURRENCY,
    filter: {
      from: from ?? null, to: to ?? null, account_id: args.account_id ?? null,
      category_id: args.category_id ?? null, payee: args.payee ?? null, text: args.text ?? null,
      min_amount: args.min_amount ?? null, max_amount: args.max_amount ?? null,
      include_transfers: Boolean(args.include_transfers),
    },
    total_matching: all.length,
    totals: {
      net: inr(sum(matching)),
      inflow: inr(sum(matching.filter((r) => r.amount > 0))),
      outflow: inr(sum(matching.filter((r) => r.amount < 0))),
    },
    limit,
    transactions: page.map((rows) => {
      const first = rows[0]!;
      const fact = facts.get(first.id);
      const split = fact ? fact.is_split === 1 : rows.length > 1;
      return {
        transaction_id: first.id,
        date: first.date,
        account_id: first.accountId,
        account_name: first.account,
        payee: first.payee,
        memo: first.memo,
        amount: inr(fact?.amount ?? sum(rows)),
        cleared: first.cleared === 1,
        is_transfer: first.isTransfer === 1,
        spent_by: first.owner,
        split,
        // A split shows each line; a filter on an envelope shows the lines in it.
        lines: rows.map((r) => ({ category_id: r.categoryId, category_name: r.category ?? "Uncategorised", amount: inr(r.amount) })),
        // The envelope, when there is one; a split's envelopes are its lines'.
        category_id: split ? null : first.categoryId,
        category_name: split ? null : first.category ?? "Uncategorised",
      };
    }),
    next_cursor: offset + limit < all.length ? encodeCursor(offset + limit) : null,
  };
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

function envelope(c: CategoryView) {
  return {
    category_id: c.id,
    name: c.name,
    opening: inr(c.state.opening),
    assigned: inr(c.state.assigned),
    activity: inr(c.state.activity),
    available: inr(c.state.balance),
    state: c.stateLabel,
    is_card_payment: c.isPaymentCategory,
    card_account_id: c.paymentAccountId,
    commitment_to_budget_id: c.commitsToBudgetId,
    target: c.target
      ? {
          type: c.target.type,
          amount: inr(c.target.amount),
          target_date: c.target.targetDate,
          period: c.target.period,
          needed_this_month: inr(c.progress?.needed ?? null),
          underfunded: inr(c.progress?.underfunded ?? null),
          funded_state: c.progress?.state ?? null,
        }
      : null,
  };
}

function budgetMonth(db: DB, viewerMemberId: string, b: Budget & { label: string }, month: MonthKey, hidden: Set<string>, full: boolean) {
  const view = buildBudgetView(db, month, b.id, viewerMemberId);
  const shown = new Set(visibleCategories(view, hidden).map((c) => c.id));
  const groups = view.groups.map((g) => {
    const cats = g.categories.filter((c) => shown.has(c.id));
    return {
      group_id: g.id,
      group_name: g.name,
      assigned: inr(cats.reduce((s, c) => s + c.state.assigned, 0)),
      activity: inr(cats.reduce((s, c) => s + c.state.activity, 0)),
      available: inr(cats.reduce((s, c) => s + c.state.balance, 0)),
      envelopes: cats.map(envelope),
    };
  }).filter((g) => g.envelopes.length > 0);
  const all = groups.flatMap((g) => g.envelopes);
  const total = (k: "assigned" | "activity" | "available") =>
    inr(all.reduce((s, e) => s + Math.round((e[k] ?? 0) * 100), 0));
  const summary = {
    ...budgetRef(b),
    month,
    ready_to_assign: inr(view.monthState.readyToAssign),
    ready_to_assign_state: view.monthState.rtaState,
    assigned: total("assigned"),
    activity: total("activity"),
    available: total("available"),
    overspent_count: all.filter((e) => (e.available ?? 0) < 0).length,
    underfunded_targets: inr(view.underfunded.amount),
  };
  return full ? { ...summary, groups } : summary;
}

/**
 * The budget grid for a month: each envelope's assigned, activity (spending is
 * negative) and available, with its target where it has one — for the
 * household's budget and the viewer's own, each labelled.
 */
export function aiBudgetMonth(
  db: DB, viewerMemberId: string, args: { month?: string } = {}, _opts: AnalysisOptions = {},
) {
  const month = requireMonth(args.month, db);
  const hidden = memberScope(db, viewerMemberId).categories;
  return {
    currency: CURRENCY,
    month,
    budgets: visibleBudgets(db, viewerMemberId).map((b) => budgetMonth(db, viewerMemberId, b, month, hidden, true)),
  };
}

// ---------------------------------------------------------------------------
// Spending
// ---------------------------------------------------------------------------

export type SpendingGroupBy = "category" | "payee" | "month" | "account";

/**
 * Money out over a period, grouped — the /reports "spending by category"
 * figure, with the other groupings over the same rows: transfers and a loan's
 * own ledger left out, card spending counted when it was charged, refunds not
 * netted (they are money in).
 */
export function aiSpending(
  db: DB, viewerMemberId: string,
  args: { from: string; to: string; group_by?: SpendingGroupBy },
  _opts: AnalysisOptions = {},
) {
  const from = requireDate(args.from, "from");
  const to = requireDate(args.to, "to");
  if (!from || !to) throw new Refusal(`Give both "from" and "to", as YYYY-MM-DD.`);
  if (from > to) throw new Refusal(`"from" (${from}) is after "to" (${to}).`);
  const by = args.group_by ?? "category";
  if (!["category", "payee", "month", "account"].includes(by)) {
    throw new Refusal(`group_by is one of category, payee, month or account.`);
  }

  const rows = queryTransactions(db, { from, to, direction: "out", viewerMemberId });
  const groups = groupTotals(rows, by)
    .map((g) => ({ key: g.key, label: g.label, total: Math.abs(g.total), count: g.count }))
    .filter((g) => g.total > 0)
    .sort((a, b) => b.total - a.total);
  const total = groups.reduce((s, g) => s + g.total, 0);

  return {
    currency: CURRENCY,
    from, to, group_by: by,
    total_spent: inr(total),
    groups: groups.map((g) => ({
      [`${by}_id`]: by === "category" ? (g.key === "none" ? null : g.key)
        : by === "account" ? g.key
        : by === "month" ? g.key
        : null,
      name: g.label,
      spent: inr(g.total),
      line_count: g.count,
      share_pct: total > 0 ? round((g.total / total) * 100, 1) : 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------

function loanSummary(db: DB, p: LoanProjection, names: Map<string, string>) {
  const account = listAccounts(db, { includeClosed: true }).find((a) => a.id === p.loan.account_id);
  const next = p.schedule.instalments[0] ?? null;
  return {
    loan_id: p.loan.id,
    name: p.loan.nickname || p.loan.lender,
    lender: p.loan.lender,
    loan_type: p.loan.loan_type,
    loan_type_label: LOAN_TYPE_LABELS[p.loan.loan_type] ?? p.loan.loan_type,
    account_id: p.loan.account_id,
    holder_name: account?.holder_member_id ? names.get(account.holder_member_id) ?? null : null,
    visibility: account?.visibility ?? "household",
    interest_model: p.loan.interest_model,
    sanctioned: inr(p.loan.sanctioned),
    sanction_date: p.loan.sanction_date,
    disbursed: inr(p.disbursed),
    undrawn: inr(p.undrawn),
    outstanding: inr(p.outstanding),
    rate_pct: round(p.ratePct, 4),
    emi: inr(p.emi),
    pre_emi: inr(p.preEmi),
    remaining_months: p.schedule.months,
    closes_on: p.schedule.closesOn,
    interest_paid_so_far: inr(p.metrics.interestPaid),
    principal_repaid_so_far: inr(p.metrics.principalRepaid),
    interest_remaining: inr(p.schedule.totalInterest),
    interest_over_life: inr(p.metrics.interestProjected),
    interest_saved_vs_original_schedule: inr(p.metrics.interestSaved),
    history_from: p.metrics.fromDate,
    next_instalment: next
      ? {
          due_date: next.dueDate, amount: inr(next.payment),
          interest: inr(next.interest), principal: inr(next.principal),
        }
      : null,
    drift_from_lender_balance: p.driftAmount === null ? null
      : { amount: inr(p.driftAmount), material: p.driftMaterial, as_of: p.driftAsOf },
    closed: p.loan.closed_at !== null,
  };
}

/** Every loan the viewer can see, and everything they owe in one table. */
export function aiLoans(db: DB, viewerMemberId: string, _args: Record<string, never> = {}, opts: AnalysisOptions = {}) {
  if (!loansOn(opts)) return DISABLED_LOANS;
  const names = memberNames(db);
  const loans = listLoans(db, { viewerMemberId })
    .map((l) => projectLoan(db, l.id))
    .filter((p): p is LoanProjection => p !== null)
    .map((p) => loanSummary(db, p, names));
  const debts = debtOverview(db, viewerMemberId);
  return {
    currency: CURRENCY,
    enabled: true as const,
    as_of: todayIST(),
    loans,
    total_outstanding: inr(loans.reduce((s, l) => s + Math.round((l.outstanding ?? 0) * 100), 0)),
    everything_owed: debts.map((d) => ({
      name: d.name, kind: d.kind, balance: inr(d.balance), rate_pct: d.ratePct,
      monthly_obligation: inr(d.monthlyObligation), months_remaining: d.monthsRemaining,
      holder_name: d.holderName,
    })),
  };
}

export const SCHEDULE_DEFAULT_LIMIT = 120;
export const SCHEDULE_MAX_LIMIT = 600;

/** One loan's projected schedule from here, and the payments already recorded. */
export function aiLoanSchedule(
  db: DB, viewerMemberId: string, args: { loan_id: string; limit?: number }, opts: AnalysisOptions = {},
) {
  if (!loansOn(opts)) return DISABLED_LOANS;
  // H2.2 · Another member's private loan and a made-up id: one answer.
  if (!args?.loan_id || !canSeeLoan(db, args.loan_id, viewerMemberId)) {
    throw new Missing("That loan does not exist.");
  }
  const projection = projectLoan(db, args.loan_id);
  if (!projection) throw new Missing("That loan does not exist.");
  const requested = args.limit ?? SCHEDULE_DEFAULT_LIMIT;
  if (!Number.isInteger(requested) || requested < 1) throw new Refusal("limit must be a whole number, 1 or more.");
  const limit = Math.min(requested, SCHEDULE_MAX_LIMIT);

  const payments = listPayments(db, args.loan_id);
  return {
    currency: CURRENCY,
    enabled: true as const,
    loan: loanSummary(db, projection, memberNames(db)),
    projected_instalments: projection.schedule.instalments.slice(0, limit).map((i) => ({
      number: i.number, due_date: i.dueDate,
      opening: inr(i.opening), payment: inr(i.payment), interest: inr(i.interest),
      principal: inr(i.principal), closing: inr(i.closing), estimated: i.estimated,
    })),
    projected_instalment_count: projection.schedule.instalments.length,
    truncated: projection.schedule.instalments.length > limit,
    // Most recent first, so a limit keeps what is likeliest to be asked about.
    payments_recorded: [...payments].reverse().slice(0, limit).map((p) => ({
      date: p.date, kind: p.kind, amount: inr(p.amount), principal: inr(p.principal),
      interest: inr(p.interest), estimated_split: p.estimated === 1, note: p.note,
    })),
    payments_recorded_count: payments.length,
  };
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

function perUnit(micro: MicroRupees | null | undefined): number | null {
  return micro === null || micro === undefined ? null : round(micro / PRICE_SCALE, 4);
}

/**
 * Holdings, hand-valued assets and the allocation — the Portfolio page. XIRR is
 * given wherever the page shows one; it is money-weighted and annualised, and
 * `absolute_return_pct` is simple gain over cost.
 */
export function aiPortfolio(db: DB, viewerMemberId: string, _args: Record<string, never> = {}, opts: AnalysisOptions = {}) {
  if (!assetsOn(opts)) return DISABLED_ASSETS;
  const data = portfolioData(db, { viewerMemberId, scope: "household" });
  const allocation = assetAllocation(db, todayIST(), "INR", { viewerMemberId });
  const invested = data.rows.reduce((s, r) => s + r.view.costBasis, 0);
  const value = data.rows.reduce((s, r) => s + r.view.marketValue, 0);
  const slices = (list: { key: string; label: string; value: number; share: number }[]) =>
    list.map((s) => ({ key: s.key, name: s.label, value: inr(s.value), share_pct: round(s.share * 100, 1) }));

  return {
    currency: CURRENCY,
    enabled: true as const,
    as_of: todayIST(),
    totals: {
      invested: inr(invested),
      market_value: inr(value),
      unrealised_gain: inr(value - invested),
      portfolio_xirr_pct: round(data.portfolioXirr, 2),
      hand_valued_assets: inr(data.manualAssets.reduce((s, a) => s + a.value, 0)),
    },
    holdings: data.rows.map(({ view: v, accountName: acct }) => ({
      holding_id: v.holding.id,
      instrument_id: v.instrument.id,
      instrument_name: v.instrument.name,
      instrument_kind: v.instrument.kind,
      asset_class: v.instrument.asset_class,
      instrument_currency: v.instrument.currency,
      account_id: v.holding.account_id,
      account_name: acct,
      units: v.units / UNIT_SCALE,
      // What each unit cost, in rupees; the price is in the instrument's own
      // currency, as a broker quotes it (a US share's in dollars).
      average_cost_per_unit_inr: perUnit(v.averageCost),
      price: v.quote
        ? { per_unit: perUnit(v.quote.price), currency: v.instrument.currency, as_of: v.quote.asOf, stale: v.quote.stale }
        : null,
      cost: inr(v.costBasis),
      market_value: inr(v.marketValue),
      unrealised_gain: inr(v.unrealisedGain),
      absolute_return_pct: round(v.absoluteReturn, 2),
      xirr_pct: round(v.xirr, 2),
      realised_gain: inr(v.realisedGain),
      dividends: inr(v.dividends),
    })),
    hand_valued_assets: data.manualAssets.map((a) => ({
      account_id: a.id, name: a.name, type: a.subtype, type_label: SUBTYPE_LABELS[a.subtype] ?? a.subtype,
      value: inr(a.value), as_of: a.asOf, stale: a.stale, valued: a.valued,
    })),
    allocation: {
      total: inr(allocation.total),
      by_class: slices(allocation.byClass),
      by_region: slices(allocation.byRegion),
      by_currency: slices(allocation.byCurrency),
      unclassified: {
        value: inr(allocation.unclassified.value),
        holdings: allocation.unclassified.holdings.map((h) => ({ instrument_id: h.instrumentId, name: h.name, value: inr(h.value) })),
      },
    },
  };
}

/** Capital gains realised in one financial year, sale by sale (the Reports figure). */
export function aiRealisedGains(
  db: DB, viewerMemberId: string, args: { fy?: number | string } = {}, opts: AnalysisOptions = {},
) {
  if (!assetsOn(opts)) return DISABLED_ASSETS;
  const fy = requireFy(args.fy);
  const year = capitalGainsByYear(db, viewerMemberId).find((y) => y.fy === fy);
  const range = fiscalYearRange(fy);
  return {
    currency: CURRENCY,
    enabled: true as const,
    fy, fy_label: formatFiscalYear(fy), from: range.from, to: range.to,
    short_term_gain: inr(year?.shortTerm ?? 0),
    long_term_gain: inr(year?.longTerm ?? 0),
    gain_with_unknown_holding_period: inr(year?.unknownPeriod ?? 0),
    proceeds: inr(year?.proceeds ?? 0),
    sales: (year?.parcels ?? []).map((p) => ({
      sold_on: p.soldOn, instrument_name: p.instrument, acquired_on: p.acquiredOn,
      holding_period_days: p.holdingPeriodDays, cost: inr(p.cost), proceeds: inr(p.proceeds),
      gain: inr(p.gain), term: p.longTerm ? "long" : "short",
    })),
    note: "Gains on the viewer's visible holdings. The tax estimate counts only the holdings they are named holder of.",
  };
}

// ---------------------------------------------------------------------------
// Net worth
// ---------------------------------------------------------------------------

/** The live statement, as the viewer sees it, and the household's snapshot history. */
export function aiNetWorth(db: DB, viewerMemberId: string, _args: Record<string, never> = {}, opts: AnalysisOptions = {}) {
  if (!assetsOn(opts)) return DISABLED_ASSETS;
  const s = netWorthStatement(db, todayIST(), "INR", { viewerMemberId, scope: "household" });
  const history = netWorthHistory(db);
  const previous = history.at(-2);
  const change = previous ? netWorthChange(db, previous.as_of, todayIST()) : null;
  const group = (g: { name: string; total: number; lines: { label: string; accountId: string | null; value: number; asOf: string | null; stale: boolean }[] }) => ({
    name: g.name, total: inr(g.total),
    lines: g.lines.map((l) => ({ name: l.label, account_id: l.accountId, value: inr(l.value), as_of: l.asOf, stale: l.stale })),
  });
  return {
    currency: CURRENCY,
    enabled: true as const,
    as_of: s.asOf,
    net_worth: inr(s.netWorth),
    total_assets: inr(s.totalAssets),
    total_liabilities: inr(s.totalLiabilities),
    oldest_input_date: s.worstInputDate,
    has_stale_inputs: s.hasStaleInputs,
    assets: s.assetGroups.map(group),
    liabilities: s.liabilityGroups.map(group),
    warnings: [...s.untrackedAssetWarnings, ...s.drifts.map((d) => d.explanation)],
    change_since_last_snapshot: change
      ? {
          from: change.from, to: change.to, total: inr(change.total),
          parts: change.parts.map((p) => ({ part: p.key, name: p.label, value: inr(p.value) })),
          reading: change.reading,
        }
      : null,
    // A snapshot is one shared row per date, taken as nobody in particular, so
    // it counts household-held accounts only (docs/privacy.md).
    history_note: "Snapshots count the household's shared accounts only, not anybody's private ones.",
    history: history.map((h) => ({
      as_of: h.as_of, net_worth: inr(h.net_worth), cash: inr(h.cash), investments: inr(h.investments),
      other_assets: inr(h.other_assets), credit_cards: inr(h.credit_cards), loans: inr(h.loans),
      owed_to_family: inr(h.owed_to_family), other_liabilities: inr(h.other_liabilities),
    })),
  };
}

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------

/**
 * The viewer's own income-tax estimate for a financial year, both regimes, as
 * the /tax page computes it. A year whose rates the app does not have answers
 * `{ refused }` with the page's own sentence, never a guess at another year's.
 */
export function aiTaxEstimate(
  db: DB, viewerMemberId: string, args: { fy?: number | string } = {}, _opts: AnalysisOptions = {},
) {
  const fy = requireFy(args.fy);
  const base = { currency: CURRENCY, fy, fy_label: formatFiscalYear(fy) };
  try {
    const p = taxPageModel(db, viewerMemberId, fy, false);
    const refusal = p.staleWarning ?? p.gainsRefusal ?? p.slabsRefusal ?? null;
    if (refusal && !p.estimate) return { ...base, refused: refusal };
    const regime = (r: NonNullable<typeof p.estimate>["old"]) => ({
      gross_income: inr(r.gross), standard_deduction: inr(r.standardDeduction), hra_exempt: inr(r.hraExempt),
      home_loan_interest: inr(r.homeLoanInterest), chapter_via_deductions: inr(r.chapterViA),
      taxable_income: inr(r.taxable), tax_before_rebate: inr(r.taxBeforeRebate), rebate_87a: inr(r.rebate),
      tax_on_capital_gains: inr(r.specialRateTax), surcharge: inr(r.surcharge), cess: inr(r.cess),
      total_tax: inr(r.total), effective_rate_pct: r.effectiveRatePct,
    });
    return {
      ...base,
      gross_income: inr(p.gross),
      income_seen_in_ledger: inr(p.ledgerIncome),
      gross_income_source: p.gross === p.ledgerIncome ? "ledger or declaration (equal)" : "declaration",
      estimate: p.estimate
        ? {
            old_regime: regime(p.estimate.old),
            new_regime: regime(p.estimate.new),
            better_regime: p.estimate.better,
            saves: inr(p.estimate.saves),
          }
        : null,
      no_estimate_reason: p.estimate ? null : "No income or gains for this year yet — declare a gross income on the Tax page.",
      capital_gains_tax: p.gains
        ? { special_rate_tax: inr(p.gains.specialRateTax), added_to_slab_income: inr(p.gains.addToSlabIncome), exemption_used: inr(p.gains.exemptionUsed) }
        : null,
      tax_paid: { tds: inr(p.paid.tds), advance: inr(p.paid.advance), self_assessment: inr(p.paid.selfAssessment) },
      balance_due: p.settlement
        ? { old_regime: inr(p.settlement.old.balance), new_regime: inr(p.settlement.new.balance), meaning: "positive is still to pay, negative a refund" }
        : null,
      advance_tax: p.advance.map((a) => ({
        label: a.label, due_date: a.date, cumulative_pct: a.cumulativePct, instalment: inr(a.instalmentAmount),
        paid_by_then: inr(a.paidByThen), short_by: inr(a.shortBy),
      })),
      rates_verified_on: p.ratesVerifiedOn,
      caveat: "An estimate from what is recorded here, not a filing. Check with the department's own calculator.",
    };
  } catch (err) {
    if (err instanceof Missing || !(err instanceof Refusal)) throw err;
    return { ...base, refused: err.message };
  }
}

// ---------------------------------------------------------------------------
// Cashflow
// ---------------------------------------------------------------------------

export const CASHFLOW_DEFAULT_DAYS = 30;
export const CASHFLOW_MAX_DAYS = 366;

/**
 * What is due over the next `days`: scheduled bills and income, loan
 * instalments and card payments as the Schedules page projects them against
 * the viewer's cash in budget accounts, plus card statements, deposits maturing
 * and insurance premiums.
 */
export function aiCashflow(
  db: DB, viewerMemberId: string, args: { days?: number } = {}, _opts: AnalysisOptions = {},
) {
  const asked = args.days ?? CASHFLOW_DEFAULT_DAYS;
  if (!Number.isInteger(asked) || asked < 1) throw new Refusal("days must be a whole number, 1 or more.");
  const days = Math.min(asked, CASHFLOW_MAX_DAYS);
  const today = todayIST();
  const end = addDays(today, days);
  const budgets = visibleBudgets(db, viewerMemberId);
  const schedules = listSchedules(db, { viewerMemberId });

  return {
    currency: CURRENCY,
    from: today, to: end, days,
    // Per budget, as the Schedules page projects it: "will I make it to the
    // 30th" is a question about one budget's accounts (15).
    budgets: budgets.map((b) => {
      const cashflow = projectCashflow(db, { days, budgetId: b.id, viewerMemberId });
      const inScope = scheduleInScope(db, { budgetId: b.id, viewerMemberId });
      return {
        ...budgetRef(b),
        ...cashflowHeadline(cashflow),
        calendar: cashflow.days
          .filter((d) => d.inflows.length || d.outflows.length || d.maturing?.length)
          .map((d) => ({
            date: d.date,
            inflows: d.inflows.map((x) => ({ name: x.label, amount: inr(x.amount), confirmed: x.confirmed })),
            outflows: d.outflows.map((x) => ({ name: x.label, amount: inr(x.amount), confirmed: x.confirmed })),
            deposits_maturing: (d.maturing ?? []).map((m) => ({ account_id: m.accountId, name: m.label, amount: inr(m.amount) })),
            projected_balance: inr(d.projectedBalance),
          })),
        schedules_due: schedules
          .filter(inScope)
          .filter((s) => s.next_due && s.next_due <= end)
          .map((s) => ({
            schedule_id: s.id, name: s.name, next_due: s.next_due, amount: inr(s.amount),
            amount_is_estimate: s.amount_is_estimate === 1, recurrence: s.recurrence,
            detected: s.detected === 1, overdue: s.next_due! < today,
          })),
        card_dues: cardsDue(db, { month: monthOf(today), budgetId: b.id, viewerMemberId })
          .filter((c) => c.owed > 0 || (c.statement && c.statement.due >= today && c.statement.due <= end))
          .map((c) => ({
            account_id: c.accountId, name: c.name, last4: c.last4,
            owed_now: inr(c.owed), payment_envelope_holds: inr(c.funded), unfunded: inr(c.unfunded),
            statement: c.statement
              ? { amount: inr(c.statement.amount), statement_date: c.statement.date, due_date: c.statement.due, minimum_due: inr(c.statement.minimum) }
              : null,
            days_to_due: c.daysToDue,
            paid_since_statement: inr(c.paidSinceStatement),
          })),
        insurance_premiums: policiesDueBy(db, { viewerMemberId, until: end, budgetId: b.id })
          .map((p) => ({ policy_id: p.id, name: p.name, amount: inr(p.amount), due_date: p.nextDue })),
      };
    }),
    deposit_maturities: listMaturities(db, { from: today, to: end, viewerMemberId }).map((m) => ({
      account_id: m.accountId, name: m.name, kind: m.kind, date: m.date, amount: inr(m.amount),
    })),
  };
}

// ---------------------------------------------------------------------------
// Insurance, goals, FIRE
// ---------------------------------------------------------------------------

/** Every policy the viewer can see: premium, cover, next due, who holds it. */
export function aiInsurance(db: DB, viewerMemberId: string, _args: Record<string, never> = {}, _opts: AnalysisOptions = {}) {
  const names = memberNames(db);
  const hidden = memberScope(db, viewerMemberId).categories;
  const envelopes = new Map(
    listCategories(db, { includeHidden: true, viewerMemberId })
      .filter((c) => !hidden.has(c.id)).map((c) => [c.id, c.name]),
  );
  const today = todayIST();
  const policies = listPolicies(db, { viewerMemberId }).map((p) => ({
    policy_id: p.id,
    insurer: p.insurer,
    kind: p.kind,
    kind_label: KIND_LABELS[p.kind] ?? p.kind,
    policy_last4: p.policy_last4,
    sum_assured: inr(p.sum_assured),
    premium: inr(p.premium),
    frequency: p.frequency,
    frequency_label: FREQUENCY_LABELS[p.frequency] ?? p.frequency,
    next_due: p.next_due,
    start_date: p.start_date,
    end_date: p.end_date,
    covered: p.covered,
    nominee: p.nominee,
    tax_group: p.tax_group,
    tax_group_label: TAX_GROUP_LABELS[p.tax_group] ?? p.tax_group,
    status: p.status,
    current: isCurrent(p, today),
    holder_name: p.holder_member_id ? names.get(p.holder_member_id) ?? null : null,
    visibility: p.visibility,
    // The envelope it is paid from, only when the viewer may see that envelope.
    envelope_id: p.category_id && envelopes.has(p.category_id) ? p.category_id : null,
    envelope_name: p.category_id ? envelopes.get(p.category_id) ?? null : null,
  }));
  return { currency: CURRENCY, as_of: today, policies };
}

/** Each goal in the viewer's budgets: target, saved, what it takes per month. */
export function aiGoals(db: DB, viewerMemberId: string, _args: Record<string, never> = {}, _opts: AnalysisOptions = {}) {
  const hidden = memberScope(db, viewerMemberId).categories;
  const goals = visibleBudgets(db, viewerMemberId).flatMap((b) => {
    const view = buildBudgetView(db, undefined, b.id, viewerMemberId);
    const balances = new Map(
      visibleCategories(view, hidden).map((c) => [c.id, { name: c.name, balance: c.state.balance }]),
    );
    return goalProgress(db, balances, todayIST(), [b.id]).map((g) => ({
      goal_id: g.goal.id,
      name: g.goal.name,
      ...budgetRef(b),
      target: inr(g.goal.target_amount),
      target_date: g.goal.target_date,
      saved: inr(g.saved),
      remaining: inr(g.remaining),
      percent: round(g.percent, 1),
      required_monthly: inr(g.requiredMonthly),
      months_remaining: g.monthsRemaining,
      reached: g.reached,
      completed_on: isoDay(g.goal.completed_at),
      envelopes: g.categories.map((c) => ({ category_id: c.id, name: c.name, available: inr(c.balance) })),
      reading: g.reading,
    }));
  });
  return { currency: CURRENCY, as_of: todayIST(), goals };
}

/** The FIRE page at its default assumptions: corpus, FIRE number, years to go. */
export function aiFire(db: DB, viewerMemberId: string, _args: Record<string, never> = {}, opts: AnalysisOptions = {}) {
  if (!assetsOn(opts)) return DISABLED_ASSETS;
  const f = fireProjection(db, { viewerMemberId, scope: "household" });
  const lines = (list: { label: string; accountId: string; value: number; subtype: string }[]) =>
    list.map((l) => ({ name: l.label, account_id: l.accountId, type: l.subtype, value: inr(l.value) }));
  return {
    currency: CURRENCY,
    enabled: true as const,
    as_of: f.asOf,
    window_days: f.windowDays,
    window_is_short: f.windowIsShort,
    annual_expenses: inr(f.annualExpenses),
    annual_income: inr(f.annualIncome),
    annual_savings: inr(f.annualSavings),
    savings_rate_pct: round(f.savingsRatePct, 1),
    corpus: inr(f.corpus),
    drawable_now: inr(f.drawableNow),
    locked_until_retirement: inr(f.lockedUntilRetirement),
    excluded: inr(f.excluded),
    fire_number: inr(f.fireNumber),
    fire_number_at_4_pct: inr(f.fireNumberAtFourPercent),
    progress_pct: round(f.progressPct, 1),
    shortfall: inr(f.shortfall),
    years_to_fire: round(f.yearsToFire, 1),
    fire_month: f.fireMonth,
    assumptions: {
      withdrawal_rate_pct: f.assumptions.withdrawalRateBp / 100,
      real_return_pct: f.assumptions.realReturnBp / 100,
      include_locked: f.assumptions.includeLocked,
    },
    drawable_lines: lines(f.drawableLines),
    locked_lines: lines(f.lockedLines),
    excluded_lines: lines(f.excludedLines),
  };
}

// ---------------------------------------------------------------------------
// Explain
// ---------------------------------------------------------------------------

/**
 * Why a figure is what it is: Ready to Assign broken into its parts (for each
 * of the viewer's budgets), or one envelope's month and every change to it.
 */
export function aiExplain(
  db: DB, viewerMemberId: string,
  args: { what: "ready_to_assign" | "category"; category_id?: string; month?: string },
  _opts: AnalysisOptions = {},
) {
  const month = requireMonth(args?.month, db);
  if (args?.what === "ready_to_assign") {
    return {
      currency: CURRENCY,
      what: "ready_to_assign" as const,
      month,
      meaning: "Every rupee in a budget account that hasn't been given a job yet.",
      budgets: visibleBudgets(db, viewerMemberId).map((b) => {
        // BUDGET-2 · The figure being explained is one budget's; so is the answer.
        const r = buildBudgetView(db, month, b.id, viewerMemberId).monthState.rtaBreakdown;
        return {
          ...budgetRef(b),
          ready_to_assign: inr(r.total),
          income_received_to_date: inr(r.incomeToDate),
          less_assigned_this_month_and_earlier: inr(-r.assignedThisMonthAndEarlier),
          less_assigned_in_future_months: inr(-r.assignedInFutureMonths),
          less_held_for_next_month: inr(-r.heldForNextMonth),
          less_cash_overspending_carried_in: inr(-r.cashOverspendCarried),
          committed_to_this_budget_this_month: inr(r.committedToMe),
        };
      }),
    };
  }
  if (args?.what !== "category") throw new Refusal(`"what" is ready_to_assign or category.`);
  if (!args.category_id) throw new Refusal("Give the category_id to explain.");

  // BUDGET-2 · Computed in the envelope's own budget, which the viewer must see.
  const own = listCategories(db, { includeHidden: true, viewerMemberId }).find((c) => c.id === args.category_id);
  if (!own || memberScope(db, viewerMemberId).categories.has(own.id)) throw new Missing("That envelope does not exist.");
  const budgetId = own.budget_id ?? visibleBudgets(db, viewerMemberId).find((b) => b.kind === "household")!.id;
  const view = buildBudgetView(db, month, budgetId, viewerMemberId);
  const category = view.categories.get(own.id);
  if (!category) throw new Missing("That envelope does not exist.");

  // The envelope's own transactions this month, split lines included, on
  // accounts and envelopes the viewer may see — as /explain/category does.
  const hidden = hiddenTransactionSql("t", viewerMemberId);
  const transactionIds = queryAll<{ id: string }>(
    db,
    `SELECT t.id FROM transactions t
      WHERE t.deleted_at IS NULL AND t.date >= ? AND t.date < ?
        AND (t.category_id = ?
             OR EXISTS (SELECT 1 FROM transaction_splits s
                         WHERE s.transaction_id = t.id AND s.category_id = ?))
        AND NOT ${hidden.sql}`,
    `${month}-01`, `${addMonths(month, 1)}-01`, category.id, category.id, ...hidden.params,
  ).map((r) => r.id);
  const names = memberNames(db);
  const nameOf = (id: string | null) => (id ? names.get(id) ?? "a former member" : "the app");
  const events = [
    ...historyFor(db, "assignment", `${month}:${category.id}`),
    ...transactionIds.flatMap((id) => historyFor(db, "transaction", id)),
  ].sort((a, b) => a.seq - b.seq);

  return {
    currency: CURRENCY,
    what: "category" as const,
    month,
    category_id: category.id,
    name: category.name,
    budget_id: budgetId,
    opening: inr(category.state.opening),
    assigned: inr(category.state.assigned),
    activity: inr(category.state.activity),
    available: inr(category.state.balance),
    state: category.stateLabel,
    changes: events.map((e) => {
      const line = explainLineFor(e, nameOf);
      return { date: isoDay(e.at), who: line.who, what: line.what };
    }),
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export const SNAPSHOT_DEFAULT_MONTHS = 12;
export const SNAPSHOT_MAX_MONTHS = 36;
const TOP_PAYEES = 20;

/**
 * Everything above in one document, for pasting into a chat or loading into a
 * spreadsheet. Not the transaction list — a year of it is megabytes — but
 * spending by envelope and the top payees for each month instead, which is
 * what most questions about a register come down to.
 */
export function aiSnapshot(
  db: DB, viewerMemberId: string, args: { months?: number } = {}, opts: AnalysisOptions = {},
) {
  const months = args.months ?? SNAPSHOT_DEFAULT_MONTHS;
  if (!Number.isInteger(months) || months < 1 || months > SNAPSHOT_MAX_MONTHS) {
    throw new Refusal(`months is a whole number from 1 to ${SNAPSHOT_MAX_MONTHS}.`);
  }
  const member = getMember(db, viewerMemberId);
  if (!member) throw new Missing("That member does not exist.");

  const today = todayIST();
  const current = monthOf(today);
  const monthList: MonthKey[] = [];
  for (let i = months; i >= 0; i--) monthList.push(addMonths(current, -i));
  // A month before the household's first is not refused; it is just empty.
  const inReach = monthList.filter((m) => monthInReach(db, m));

  const hidden = memberScope(db, viewerMemberId).categories;
  const budgets = visibleBudgets(db, viewerMemberId);

  // One query for the whole window; months, envelopes and payees are buckets of it.
  const from = `${monthList[0]!}-01`;
  const outRows = queryTransactions(db, { from, to: today, direction: "out", viewerMemberId });
  const byMonth = new Map<MonthKey, QueryRow[]>();
  for (const r of outRows) {
    const m = monthOf(r.date);
    const list = byMonth.get(m);
    if (list) list.push(r); else byMonth.set(m, [r]);
  }
  const spendingByMonth = monthList.map((m) => {
    const rows = byMonth.get(m) ?? [];
    const cat = groupTotals(rows, "category")
      .map((g) => ({ category_id: g.key === "none" ? null : g.key, name: g.label, spent: inr(Math.abs(g.total)) }))
      .filter((g) => (g.spent ?? 0) > 0)
      .sort((a, b) => (b.spent ?? 0) - (a.spent ?? 0));
    const payees = groupTotals(rows, "payee")
      .map((g) => ({ name: g.label, spent: inr(Math.abs(g.total)), count: g.count }))
      .filter((g) => (g.spent ?? 0) > 0)
      .sort((a, b) => (b.spent ?? 0) - (a.spent ?? 0))
      .slice(0, TOP_PAYEES);
    return {
      month: m,
      partial: m === current,
      total_spent: inr(rows.reduce((s, r) => s - r.amount, 0)),
      by_category: cat,
      top_payees: payees,
    };
  });

  const sectionOf = <T>(fn: () => T): T | { error: string } => {
    try {
      return fn();
    } catch (err) {
      // One section's refusal (a year with no tax rates, say) should not lose
      // the rest of the document. A real fault still throws.
      if (err instanceof Refusal) return { error: err.message };
      throw err;
    }
  };

  return {
    currency: CURRENCY,
    generated_at: nowIST(),
    as_of: today,
    member_name: member.name,
    months_covered: { from: monthList[0], to: current, count: monthList.length },
    about: "Pathayam analysis snapshot: read-only figures as this member sees them on screen. " +
      "Amounts are rupees; negative activity is spending. Other members' private accounts, loans, " +
      "policies and personal budgets are not included anywhere, totals included.",
    overview: sectionOf(() => aiOverview(db, viewerMemberId, {}, opts)),
    accounts: sectionOf(() => aiAccounts(db, viewerMemberId, {}, opts).accounts),
    budget_current_month: sectionOf(() => aiBudgetMonth(db, viewerMemberId, { month: current }, opts).budgets),
    budget_by_month: sectionOf(() => budgets.map((b) => ({
      ...budgetRef(b),
      months: inReach.map((m) => {
        const { budget_id: _i, budget_name: _n, budget_kind: _k, ...rest } = budgetMonth(db, viewerMemberId, b, m, hidden, false);
        return rest;
      }),
    }))),
    spending_by_month: spendingByMonth,
    loans: sectionOf(() => aiLoans(db, viewerMemberId, {}, opts)),
    portfolio: sectionOf(() => aiPortfolio(db, viewerMemberId, {}, opts)),
    net_worth: sectionOf(() => aiNetWorth(db, viewerMemberId, {}, opts)),
    cashflow_30_days: sectionOf(() => aiCashflow(db, viewerMemberId, { days: 30 }, opts)),
    goals: sectionOf(() => aiGoals(db, viewerMemberId, {}, opts).goals),
    insurance: sectionOf(() => aiInsurance(db, viewerMemberId, {}, opts).policies),
    tax_estimate_current_fy: sectionOf(() => aiTaxEstimate(db, viewerMemberId, {}, opts)),
  };
}
