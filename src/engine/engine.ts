/**
 * The budgeting engine — R1 to R13 of `02` §4.
 *
 * Pure functions over pre-aggregated facts. No database, no clock, no I/O, so
 * every rule is testable against the worked ₹ examples before any UI exists
 * (`05` §8 step 2, `09` §8 step 2).
 *
 * The arithmetic and the identity every result must satisfy are worked out in
 * `docs/dev/01-engine-derivation.md`. Read that first if a number here looks
 * arbitrary — it is derived, not chosen.
 */

import type { Paise } from "../core/money.ts";
import { allocate, allocateByWeight } from "../core/money.ts";
import type { MonthKey, IsoDate } from "../core/dates.ts";
import {
  monthOf,
  monthsBetween,
  addMonths,
  daysInMonth,
  daysBetween,
  lastDayOfMonth,
} from "../core/dates.ts";
import {
  emptyMonth,
  type EngineInput,
  type MonthState,
  type BudgetState,
  type CategoryState,
  type CategoryMeta,
  type RtaState,
  type Target,
  type TargetProgress,
  type FundedState,
} from "./types.ts";

// ---------------------------------------------------------------------------
// R1–R4, R6, R11, R13 · The month walk
// ---------------------------------------------------------------------------

/**
 * Walk every month in order, producing category balances and Ready to Assign.
 *
 * A month cannot be computed on its own: a category's opening balance is the
 * previous month's carry (R3), and a cash overspend reduces the *next* month's
 * RTA (R4). R13's rollover is therefore not a scheduled job — it is what this
 * function does when it steps from one month to the next, which means it can
 * never be forgotten, run twice, or run late.
 */
export function computeBudget(input: EngineInput): BudgetState {
  const { months, facts, categories, overspendModel } = input;
  const states: BudgetState = new Map();

  // Payment categories are indexed by the account they settle, so a card's
  // transactions can be turned into its envelope's activity (R6).
  const paymentCategoryByAccount = new Map<string, string>();
  for (const c of categories) {
    if (c.paymentAccountId) paymentCategoryByAccount.set(c.paymentAccountId, c.id);
  }

  const totalAssignedAllMonths = months.reduce(
    (sum, m) => sum + sumValues(facts[m]?.assigned ?? {}),
    0,
  );

  let carryForward = new Map<string, Paise>();
  let cumulativeIncome = 0;
  let cumulativeAssigned = 0;
  let cumulativeCashCarry = 0;
  let cumulativeCreditAbsorbed = 0;
  let budgetBalance = 0;
  let pendingCashOverspend = 0;
  let pendingCreditOverspend = 0;

  for (const month of months) {
    const f = facts[month] ?? emptyMonth();

    // R4: last month's cash overspend lands here. Under `carry-negative` it
    // stayed on the category instead, so nothing arrives (Q1).
    const cashOverspendCarriedIn = overspendModel === "reduce-rta" ? pendingCashOverspend : 0;
    cumulativeCashCarry += cashOverspendCarriedIn;

    // R6: likewise, a credit overspend is absorbed when the category reopens at
    // zero — at *this* rollover, not in the month it was incurred. While the
    // month is still open the shortfall is visible on the category itself.
    cumulativeCreditAbsorbed += pendingCreditOverspend;

    const toBudget = f.budgetAccountFlow - f.budgetCategorisedFlow - f.budgetTransferFlow;
    cumulativeIncome += toBudget;
    budgetBalance += f.budgetAccountFlow;

    const assignedThisMonth = sumValues(f.assigned);
    cumulativeAssigned += assignedThisMonth;

    const categoryStates = new Map<string, CategoryState>();
    let nextCarry = new Map<string, Paise>();
    let cashOverspendThisMonth = 0;
    let creditAbsorbedThisMonth = 0;

    for (const meta of categories) {
      const opening = carryForward.get(meta.id) ?? 0;
      const assigned = f.assigned[meta.id] ?? 0;
      const activity = activityFor(meta, f, paymentCategoryByAccount);
      const balance = opening + assigned + activity;

      let cashOverspend = 0;
      let creditOverspend = 0;
      let carry = balance;

      if (balance < 0) {
        const shortfall = -balance;
        // R6: the part of the negative that was charged to a card created no
        // cash, so it must not reduce RTA. Attribute up to the card outflow
        // in this category this month; whatever is left is cash.
        const creditOutflow = Math.max(0, -(f.creditActivity[meta.id] ?? 0));
        creditOverspend = Math.min(shortfall, creditOutflow);
        cashOverspend = shortfall - creditOverspend;

        // Both kinds of overspent category reopen at zero, except under the
        // YNAB-style model where the cash part rides forward on the category.
        carry = overspendModel === "carry-negative" ? -cashOverspend : 0;

        cashOverspendThisMonth += cashOverspend;
        creditAbsorbedThisMonth += creditOverspend;
      }

      categoryStates.set(meta.id, {
        categoryId: meta.id,
        opening,
        assigned,
        activity,
        balance,
        cashOverspend,
        creditOverspend,
        carry,
      });
      nextCarry.set(meta.id, carry);
    }

    // R2. The full derivation, including why assignments in *every* month are
    // subtracted, is in docs/dev/01-engine-derivation.md §4.
    const assignedFuture = totalAssignedAllMonths - cumulativeAssigned;
    const readyToAssign =
      cumulativeIncome - totalAssignedAllMonths - f.held - cumulativeCashCarry;

    states.set(month, {
      month,
      categories: categoryStates,
      readyToAssign,
      rtaState: rtaStateOf(readyToAssign),
      rtaBreakdown: {
        incomeToDate: cumulativeIncome,
        assignedThisMonthAndEarlier: cumulativeAssigned,
        assignedInFutureMonths: assignedFuture,
        heldForNextMonth: f.held,
        cashOverspendCarried: cumulativeCashCarry,
        total: readyToAssign,
      },
      cashOverspendCarriedIn,
      heldForNextMonth: f.held,
      budgetAccountBalance: budgetBalance,
      unfundedCreditAbsorbed: cumulativeCreditAbsorbed,
    });

    carryForward = nextCarry;
    pendingCashOverspend = cashOverspendThisMonth;
    pendingCreditOverspend = creditAbsorbedThisMonth;
  }

  return states;
}

function activityFor(
  meta: CategoryMeta,
  f: ReturnType<typeof emptyMonth>,
  paymentCategoryByAccount: Map<string, string>,
): Paise {
  if (meta.paymentAccountId) {
    // R6: the payment envelope tracks the change in the debt, so its activity
    // is the negation of everything that happened on the card. One rule covers
    // purchases, payments, fees and refunds alike.
    void paymentCategoryByAccount;
    return -(f.creditAccountFlow[meta.paymentAccountId] ?? 0);
  }
  return f.activity[meta.id] ?? 0;
}

function rtaStateOf(rta: Paise): RtaState {
  if (rta === 0) return "zero";
  return rta > 0 ? "positive" : "negative";
}

function sumValues(record: Record<string, Paise>): Paise {
  let total = 0;
  for (const v of Object.values(record)) total += v;
  return total;
}

/**
 * The identity from `docs/dev/01-engine-derivation.md` §1. Should be exactly
 * zero after every operation; the test suite asserts it after each scenario,
 * which is the cheapest guard against the `05` §7 risk of the engine going
 * subtly wrong and surfacing in month four.
 */
export function identityResidual(state: MonthState, assignedInFutureMonths?: Paise): Paise {
  const future = assignedInFutureMonths ?? state.rtaBreakdown.assignedInFutureMonths;
  let categoryTotal = 0;
  for (const c of state.categories.values()) categoryTotal += c.balance;

  return (
    state.budgetAccountBalance -
    (categoryTotal +
      state.readyToAssign +
      state.heldForNextMonth +
      future -
      state.unfundedCreditAbsorbed)
  );
}

// ---------------------------------------------------------------------------
// R6 · Credit-card funding
// ---------------------------------------------------------------------------

export interface CardFunding {
  accountId: string;
  /** Negative while money is owed. */
  outstanding: Paise;
  /** What the payment category currently holds. */
  funded: Paise;
  /** How much of the outstanding no envelope is covering. Never negative. */
  unfunded: Paise;
}

/**
 * R6's warning figure: *"₹3,200 of your HDFC balance is not funded"*.
 *
 * Starting debt is included here deliberately. The payment category opens at
 * ₹0 on account creation, so an existing balance shows as unfunded until a
 * payoff target fills it — which R6 says is a debt figure, never a budgeting
 * error, and so it is reported separately from RTA.
 */
export function cardFunding(
  accountId: string,
  outstanding: Paise,
  paymentCategoryBalance: Paise,
): CardFunding {
  const owed = Math.max(0, -outstanding);
  return {
    accountId,
    outstanding,
    funded: paymentCategoryBalance,
    unfunded: Math.max(0, owed - paymentCategoryBalance),
  };
}

// ---------------------------------------------------------------------------
// R8 · Targets
// ---------------------------------------------------------------------------

/**
 * What a target wants in this category this month, and how far short it is.
 *
 * `today` matters only for the pro-rated spending target; every other type is
 * a function of the month alone.
 */
export function targetProgress(
  target: Target,
  state: CategoryState,
  month: MonthKey,
  today: IsoDate,
): TargetProgress {
  const amount = target.amount ?? 0;
  const assigned = state.assigned;
  // Balance before this month's spending, which is what "refill to X" refers
  // to: topping a category up should not chase money already spent from it.
  const balanceForRefill = state.opening + state.assigned;

  let needed: Paise;

  switch (target.type) {
    case "monthly":
    case "debt-payoff":
      needed = amount;
      break;

    case "refill":
      needed = Math.max(0, amount - state.opening);
      break;

    case "refill-hold":
      // Never claws back a surplus — a refund that pushed the category over
      // its target must not reduce what this month asks for below zero.
      needed = Math.max(0, amount - Math.max(state.opening, 0));
      break;

    case "spending-period": {
      // Pro-rate by how much of the period has elapsed (R8).
      const elapsed = elapsedPeriods(target.period ?? "month", month, today);
      needed = Math.max(0, Math.round(amount * elapsed));
      break;
    }

    case "by-date":
    case "by-date-repeating": {
      if (!target.targetDate) {
        needed = amount;
        break;
      }
      const remaining = Math.max(0, amount - state.opening);
      const monthsLeft = monthsBetween(month, monthOf(target.targetDate)) + 1;
      if (monthsLeft <= 1) {
        needed = remaining;
      } else {
        // allocate() so the monthly figures sum back to exactly the target.
        needed = allocate(remaining, monthsLeft)[0] ?? 0;
      }
      break;
    }

    case "schedule-linked": {
      const due = target.scheduleAmount ?? amount;
      const remaining = Math.max(0, due - state.opening);
      const monthsLeft = target.scheduleDue
        ? Math.max(1, monthsBetween(month, monthOf(target.scheduleDue)) + 1)
        : 1;
      needed = monthsLeft <= 1 ? remaining : (allocate(remaining, monthsLeft)[0] ?? 0);
      break;
    }

    default:
      needed = amount;
  }

  const underfunded = Math.max(0, needed - assigned);
  return { categoryId: state.categoryId, needed, underfunded, state: fundedState(assigned, needed) };
}

function fundedState(assigned: Paise, needed: Paise): FundedState {
  if (needed <= 0) return "funded";
  if (assigned <= 0) return "unfunded";
  if (assigned < needed) return "partial";
  return assigned > needed ? "over-funded" : "funded";
}

function elapsedPeriods(period: "day" | "week" | "month", month: MonthKey, today: IsoDate): number {
  if (period === "month") return 1;
  const start = `${month}-01`;
  const end = lastDayOfMonth(month);
  // Before or after the month being viewed, the whole month has elapsed.
  const cursor = today < start ? start : today > end ? end : today;
  const dayOfMonth = daysBetween(start, cursor) + 1;
  if (period === "day") return dayOfMonth;
  return Math.ceil(dayOfMonth / 7);
}

/** R8's global line: *"₹14,200 underfunded across 6 categories"*. */
export function totalUnderfunded(
  progress: TargetProgress[],
): { amount: Paise; categoryCount: number } {
  let amount = 0;
  let categoryCount = 0;
  for (const p of progress) {
    if (p.underfunded > 0) {
      amount += p.underfunded;
      categoryCount++;
    }
  }
  return { amount, categoryCount };
}

// ---------------------------------------------------------------------------
// R5 · Covering an overspend
// ---------------------------------------------------------------------------

export interface CoverSource {
  categoryId: string;
  available: Paise;
  reason: string;
}

/**
 * Rank candidates to cover a red category (R5). Suggestions are advisory only
 * — the user may move money from anywhere to anywhere.
 *
 * Ranked by: largest positive balance, then a met target, then categories this
 * one has historically been covered from.
 */
export function suggestCoverSources(
  needy: string,
  states: Map<string, CategoryState>,
  opts: {
    metTargets?: Set<string>;
    /** Category ids previously raided to cover this one, most recent first. */
    historicalSources?: string[];
    categoryNames?: Map<string, string>;
    limit?: number;
  } = {},
): CoverSource[] {
  const { metTargets = new Set(), historicalSources = [], categoryNames, limit = 5 } = opts;
  const historyRank = new Map(historicalSources.map((id, i) => [id, i]));

  const candidates: (CoverSource & { score: number })[] = [];
  for (const [id, s] of states) {
    if (id === needy || s.balance <= 0) continue;

    const reasons: string[] = [];
    let score = s.balance;
    if (metTargets.has(id)) {
      reasons.push("target already met");
      score += 1_000_00; // ₹1,000 nudge — enough to break ties, not to dominate
    }
    if (historyRank.has(id)) {
      reasons.push("you've covered this from here before");
      score += (historicalSources.length - historyRank.get(id)!) * 500_00;
    }
    if (reasons.length === 0) reasons.push("largest balance");

    candidates.push({
      categoryId: id,
      available: s.balance,
      reason: `${categoryNames?.get(id) ?? id} — ${reasons.join(", ")}`,
      score,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit).map(({ score, ...rest }) => {
    void score;
    return rest;
  });
}

// ---------------------------------------------------------------------------
// R9 · Auto-assign
// ---------------------------------------------------------------------------

export type AutoAssignRuleType =
  | "fixed"
  | "fixed-ceiling"
  | "refill"
  | "refill-hold"
  | "rate-limited"
  | "periodic"
  | "by-date"
  | "percent-income"
  | "average-history"
  | "copy"
  | "remainder-sweep";

export interface AutoAssignRule {
  categoryId: string;
  type: AutoAssignRuleType;
  /** Band 1 is highest. Sweeps always run last regardless of band. */
  priority: number;
  amount?: Paise;
  ceiling?: Paise;
  percent?: number;
  months?: number;
  adjustPercent?: number;
  adjustAmount?: Paise;
  weight?: number;
  targetDate?: IsoDate;
  startDate?: IsoDate;
  everyN?: number;
  unit?: "day" | "week" | "month" | "year";
}

export interface AutoAssignProposal {
  categoryId: string;
  from: Paise;
  to: Paise;
  delta: Paise;
  reason: string;
  /** True when the rule wanted more than the money left (R9). */
  limitedByAvailableFunds: boolean;
}

export interface AutoAssignPlan {
  proposals: AutoAssignProposal[];
  totalAssigned: Paise;
  rtaBefore: Paise;
  rtaAfter: Paise;
}

export interface AutoAssignContext {
  month: MonthKey;
  readyToAssign: Paise;
  states: Map<string, CategoryState>;
  categories: CategoryMeta[];
  /** Income that reached RTA in this month, for percent-of-income rules. */
  incomeThisMonth: Paise;
  /** assigned[categoryId] for prior months, for average-of-history and copy. */
  historicalAssigned: Map<MonthKey, Record<string, Paise>>;
  today: IsoDate;
}

/**
 * Plan the month's assignments (R9).
 *
 * Never commits — it returns proposals for the preview that R9 requires before
 * anything is applied, and it spends only money actually available (R1),
 * stopping cleanly when it runs out rather than driving RTA negative.
 */
export function planAutoAssign(
  rules: AutoAssignRule[],
  ctx: AutoAssignContext,
): AutoAssignPlan {
  const hiddenIds = new Set(ctx.categories.filter((c) => c.hidden).map((c) => c.id));
  // F3.2: a hidden category is excluded from auto-assign.
  const active = rules.filter((r) => !hiddenIds.has(r.categoryId));

  const order = new Map(ctx.categories.map((c, i) => [c.id, i]));
  const sweeps = active.filter((r) => r.type === "remainder-sweep");
  const banded = active
    .filter((r) => r.type !== "remainder-sweep")
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        (order.get(a.categoryId) ?? 0) - (order.get(b.categoryId) ?? 0),
    );

  let remaining = ctx.readyToAssign;
  const proposals: AutoAssignProposal[] = [];

  for (const rule of banded) {
    if (remaining <= 0) break;
    const state = ctx.states.get(rule.categoryId);
    if (!state) continue;

    const { want, reason } = wantedFor(rule, state, ctx);
    if (want <= 0) continue;

    const grant = Math.min(want, remaining);
    if (grant <= 0) continue;

    remaining -= grant;
    proposals.push({
      categoryId: rule.categoryId,
      from: state.assigned,
      to: state.assigned + grant,
      delta: grant,
      reason,
      limitedByAvailableFunds: grant < want,
    });
  }

  // Remainder sweeps run last regardless of band (R9), splitting what is left
  // by weight. Ceilings still apply, so a sweep cannot overfill a category.
  if (remaining > 0 && sweeps.length > 0) {
    const weights = sweeps.map((r) => r.weight ?? 1);
    const shares = allocateByWeight(remaining, weights);
    sweeps.forEach((rule, i) => {
      const state = ctx.states.get(rule.categoryId);
      if (!state) return;
      let share = shares[i] ?? 0;
      if (rule.ceiling !== undefined) {
        const headroom = Math.max(0, rule.ceiling - (state.opening + state.assigned));
        share = Math.min(share, headroom);
      }
      if (share <= 0) return;
      remaining -= share;
      proposals.push({
        categoryId: rule.categoryId,
        from: state.assigned,
        to: state.assigned + share,
        delta: share,
        reason: "share of what was left over",
        limitedByAvailableFunds: false,
      });
    });
  }

  const totalAssigned = proposals.reduce((sum, p) => sum + p.delta, 0);
  return {
    proposals,
    totalAssigned,
    rtaBefore: ctx.readyToAssign,
    rtaAfter: ctx.readyToAssign - totalAssigned,
  };
}

function wantedFor(
  rule: AutoAssignRule,
  state: CategoryState,
  ctx: AutoAssignContext,
): { want: Paise; reason: string } {
  const already = state.assigned;
  const balanceBeforeSpending = state.opening + state.assigned;

  switch (rule.type) {
    case "fixed":
      return { want: Math.max(0, (rule.amount ?? 0) - already), reason: "fixed monthly amount" };

    case "fixed-ceiling": {
      const headroom = Math.max(0, (rule.ceiling ?? 0) - balanceBeforeSpending);
      return {
        want: Math.min(Math.max(0, (rule.amount ?? 0) - already), headroom),
        reason: "fixed amount, up to the ceiling",
      };
    }

    case "refill":
      return {
        want: Math.max(0, (rule.amount ?? 0) - balanceBeforeSpending),
        reason: "top up to the target balance",
      };

    case "refill-hold":
      return {
        want: Math.max(0, (rule.amount ?? 0) - Math.max(balanceBeforeSpending, 0)),
        reason: "top up to the target balance, keeping any surplus",
      };

    case "rate-limited": {
      const periods = rule.startDate
        ? Math.max(0, Math.floor(daysBetween(rule.startDate, ctx.today) / periodDays(rule.unit)) + 1)
        : 1;
      const ceiling = (rule.amount ?? 0) * periods;
      return {
        want: Math.max(0, Math.min(ceiling - balanceBeforeSpending, (rule.amount ?? 0) * periods - already)),
        reason: "scaled by how much of the period has passed",
      };
    }

    case "periodic": {
      if (!rule.startDate || !rule.everyN) {
        return { want: Math.max(0, (rule.amount ?? 0) - already), reason: "on cycle" };
      }
      const elapsed = monthsBetween(monthOf(rule.startDate), ctx.month);
      const stride = rule.unit === "year" ? rule.everyN * 12 : rule.everyN;
      const due = elapsed >= 0 && elapsed % stride === 0;
      return {
        want: due ? Math.max(0, (rule.amount ?? 0) - already) : 0,
        reason: due ? "due this cycle" : "not due this cycle",
      };
    }

    case "by-date": {
      if (!rule.targetDate) return { want: 0, reason: "no target date" };
      const remaining = Math.max(0, (rule.amount ?? 0) - balanceBeforeSpending);
      const monthsLeft = Math.max(1, monthsBetween(ctx.month, monthOf(rule.targetDate)) + 1);
      const share = monthsLeft <= 1 ? remaining : (allocate(remaining, monthsLeft)[0] ?? 0);
      return { want: share, reason: `spread over ${monthsLeft} month(s) to the target date` };
    }

    case "percent-income": {
      const want = Math.round((ctx.incomeThisMonth * (rule.percent ?? 0)) / 100);
      return { want: Math.max(0, want - already), reason: `${rule.percent}% of this month's income` };
    }

    case "average-history": {
      const n = rule.months ?? 3;
      const values: Paise[] = [];
      for (let i = 1; i <= n; i++) {
        const m = addMonths(ctx.month, -i);
        values.push(ctx.historicalAssigned.get(m)?.[rule.categoryId] ?? 0);
      }
      let avg = values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
      if (rule.adjustPercent) avg = Math.round(avg * (1 + rule.adjustPercent / 100));
      if (rule.adjustAmount) avg += rule.adjustAmount;
      return { want: Math.max(0, avg - already), reason: `average of the last ${n} months` };
    }

    case "copy": {
      const m = addMonths(ctx.month, -(rule.months ?? 1));
      const amount = ctx.historicalAssigned.get(m)?.[rule.categoryId] ?? 0;
      return { want: Math.max(0, amount - already), reason: `same as ${m}` };
    }

    default:
      return { want: 0, reason: "no rule" };
  }
}

function periodDays(unit: AutoAssignRule["unit"]): number {
  switch (unit) {
    case "day": return 1;
    case "week": return 7;
    case "year": return 365;
    default: return 30;
  }
}

/**
 * R9's non-negotiable UX requirement: a plain-language preview, so no member
 * ever has to learn a template syntax (Q9 — form only in P0).
 */
export function describeAutoAssignRule(rule: AutoAssignRule, format: (p: Paise) => string): string {
  switch (rule.type) {
    case "fixed":
      return `Assign ${format(rule.amount ?? 0)} every month`;
    case "fixed-ceiling":
      return `Assign ${format(rule.amount ?? 0)} every month, stopping when this category holds ${format(rule.ceiling ?? 0)}`;
    case "refill":
      return `Top this category up to ${format(rule.amount ?? 0)} every month`;
    case "refill-hold":
      return `Top this category up to ${format(rule.amount ?? 0)} every month, and never remove a surplus`;
    case "rate-limited":
      return `Allow ${format(rule.amount ?? 0)} per ${rule.unit ?? "month"}, scaled by how much time has passed`;
    case "periodic":
      return `Assign ${format(rule.amount ?? 0)} every ${rule.everyN ?? 1} ${rule.unit ?? "month"}(s)`;
    case "by-date":
      return `Save ${format(rule.amount ?? 0)} by ${rule.targetDate}, spread across the months remaining`;
    case "percent-income":
      return `Assign ${rule.percent ?? 0}% of the income received this month`;
    case "average-history":
      return `Assign the average of the last ${rule.months ?? 3} months`;
    case "copy":
      return `Assign the same as ${rule.months ?? 1} month(s) ago`;
    case "remainder-sweep":
      return rule.ceiling !== undefined
        ? `Sweep whatever is left over into this category, stopping at ${format(rule.ceiling)}`
        : `Sweep whatever is left over into this category`;
    default:
      return "No rule";
  }
}

// ---------------------------------------------------------------------------
// R12 · Buffer, and the fully-funded month
// ---------------------------------------------------------------------------

export interface Buffer {
  days: number;
  assignedTotal: Paise;
  averageDailySpend: Paise;
  /** The plain-language reading R12 requires. */
  reading: string;
}

/**
 * R12, in place of YNAB's Age of Money.
 *
 * Credit-card payment categories are excluded: that money is already committed
 * to debt already incurred, so counting it would overstate how long the
 * household could actually keep spending.
 *
 * Deliberately arithmetic the user can verify by hand, which R12 says matters
 * more than sophistication.
 */
export function computeBuffer(
  states: Map<string, CategoryState>,
  categories: CategoryMeta[],
  averageDailySpend: Paise,
): Buffer {
  const paymentCategories = new Set(
    categories.filter((c) => c.paymentAccountId).map((c) => c.id),
  );

  let assignedTotal = 0;
  for (const [id, s] of states) {
    if (paymentCategories.has(id)) continue;
    assignedTotal += Math.max(0, s.balance);
  }

  if (averageDailySpend <= 0) {
    return {
      days: 0,
      assignedTotal,
      averageDailySpend,
      reading: "Not enough spending history yet to work out a buffer.",
    };
  }

  const days = Math.floor(assignedTotal / averageDailySpend);
  return {
    days,
    assignedTotal,
    averageDailySpend,
    reading: `You have ${days} days of typical spending already assigned.`,
  };
}

/** R12's secondary metric — the real goal state, and worth celebrating. */
export function isFullyFunded(progress: TargetProgress[], readyToAssign: Paise): boolean {
  return readyToAssign === 0 && progress.every((p) => p.underfunded === 0);
}

// ---------------------------------------------------------------------------
// R10 · Future months
// ---------------------------------------------------------------------------

/**
 * R10: a future month is fully budgetable, but never assumes income that has
 * not arrived (P1). The UI must label the figure accordingly, so the engine
 * hands it the exact sentence rather than leaving it to be re-invented.
 */
export function futureMonthCaveat(month: MonthKey, currentMonth: MonthKey): string | null {
  return month > currentMonth ? "based on money you have today" : null;
}

/** Days in the month, for pro-rating. Exposed so callers need not import both modules. */
export function monthLength(month: MonthKey): number {
  return daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5)));
}
