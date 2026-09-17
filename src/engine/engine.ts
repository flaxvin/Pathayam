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
  const absorbedByAccount: Record<string, Paise> = {};
  let pendingOverspendByAccount: Record<string, Paise> = {};

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
    for (const [accountId, amount] of Object.entries(pendingOverspendByAccount)) {
      absorbedByAccount[accountId] = (absorbedByAccount[accountId] ?? 0) + amount;
    }

    /*
     * 15 §3.2 · A commitment from another budget is income to this one.
     *
     * No cash arrives — the rupees stay in the committing member's own account —
     * but the means do, which is the whole point: the household can assign what
     * a member has committed without either of them moving money.
     */
    const toBudget =
      f.budgetAccountFlow - f.budgetCategorisedFlow - f.budgetTransferFlow
      + (input.committedToMe?.[month] ?? 0)
      + f.calledEvenIncome;
    cumulativeIncome += toBudget;
    budgetBalance += f.budgetAccountFlow;

    const assignedThisMonth = sumValues(f.assigned);
    cumulativeAssigned += assignedThisMonth;

    const categoryStates = new Map<string, CategoryState>();
    let nextCarry = new Map<string, Paise>();
    let cashOverspendThisMonth = 0;
    let creditAbsorbedThisMonth = 0;
    const overspendByAccountThisMonth: Record<string, Paise> = {};

    for (const meta of categories) {
      const opening = carryForward.get(meta.id) ?? 0;
      const assigned = f.assigned[meta.id] ?? 0;
      const activity = activityFor(meta, f, paymentCategoryByAccount);
      const balance = opening + assigned + activity;

      let cashOverspend = 0;
      let creditOverspend = 0;
      let carry = balance;

      /*
       * 15 §6.1 · A commitment's negative is a debt, not an overspend.
       *
       * R4 answers an overspent envelope by reopening it at zero and taking the
       * money out of Ready to Assign — the household has spent what it did not
       * have, and the pool pays. A commitment envelope in the red says something
       * else: *this budget owes that one*, and the month ending does not settle
       * it. Absorbing it made the receiving budget's claim snap back to zero
       * while the payer's own Ready to Assign took the hit, so the two figures
       * stopped describing the same obligation and the identity failed by it.
       *
       * So it carries, red and all, and R6.n's "behind" is exactly this figure.
       */
      if (balance < 0 && !meta.commitsToBudgetId) {
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

        // Attribute the shortfall to the card(s) that actually carry the debt,
        // in proportion to what this category charged to each. Without this
        // the figure exists only in aggregate and S2b cannot name a card.
        if (creditOverspend > 0) {
          const byAccount = f.creditActivityByAccount[meta.id] ?? {};
          const outflows = Object.entries(byAccount)
            .map(([accountId, amount]) => [accountId, Math.max(0, -amount)] as const)
            .filter(([, amount]) => amount > 0);
          const totalOutflow = outflows.reduce((sum, [, amount]) => sum + amount, 0);

          if (totalOutflow > 0) {
            let distributed = 0;
            outflows.forEach(([accountId, amount], index) => {
              const share =
                index === outflows.length - 1
                  ? creditOverspend - distributed
                  : Math.round((creditOverspend * amount) / totalOutflow);
              distributed += share;
              overspendByAccountThisMonth[accountId] =
                (overspendByAccountThisMonth[accountId] ?? 0) + share;
            });
          }
        }
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

    /*
     * 15 §3.2 · The claim as it stands at the end of this month. It is reported
     * and it is a term in the identity, but it does not enter Ready to Assign —
     * what was *committed* already did, as income above, and the part since
     * spent is already accounted for on this budget's own envelopes.
     */
    const dueFromOtherBudgets = input.dueFromOtherBudgets?.[month] ?? 0;

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
        committedToMe: input.committedToMe?.[month] ?? 0,
        total: readyToAssign,
      },
      cashOverspendCarriedIn,
      heldForNextMonth: f.held,
      budgetAccountBalance: budgetBalance,
      dueFromOtherBudgets,
      unfundedCreditAbsorbed: cumulativeCreditAbsorbed,
      /*
       * B98 · What this month is short, not every gap ever absorbed.
       *
       * This added `absorbedByAccount`, the running total of every credit
       * overspend absorbed at every past rollover, on the reasoning that once
       * the category reopens at zero that total is the only surviving record of
       * the gap. The record is worth keeping — it is `unfundedCreditAbsorbed`,
       * a term in the identity — but it was never discharged, so as a warning
       * about *this* card *now* it only ever grew. Three years of ordinary use
       * reached ₹6.86L against ₹56,603 of real debt.
       *
       * Case by case, what the household should be told a card is short:
       *
       *   spend filed and funded      envelope = debt, no open overspend  → 0
       *   spend not yet filed         envelope < debt (B97)               → the gap
       *   overspent this month        envelope = debt, category negative  → the overspend
       *   overspent, since paid off   envelope = 0, debt = 0              → 0
       *   overspent, not yet paid     envelope = debt, gap absorbed       → 0
       *
       * The last is the one that changed. Absorbing a gap moves it out of the
       * category and into the identity's own term; the envelope still holds the
       * debt, and paying the card is exactly as affordable as the budget says.
       * Reporting it again here counted it twice.
       */
      unfundedByAccount: overspendByAccountThisMonth,
    });

    carryForward = nextCarry;
    pendingCashOverspend = cashOverspendThisMonth;
    pendingCreditOverspend = creditAbsorbedThisMonth;
    pendingOverspendByAccount = overspendByAccountThisMonth;
  }

  return states;
}

function activityFor(
  meta: CategoryMeta,
  f: ReturnType<typeof emptyMonth>,
  paymentCategoryByAccount: Map<string, string>,
): Paise {
  if (meta.paymentAccountId) {
    /*
     * R6: the payment envelope tracks the change in the debt, so its activity
     * is the negation of what happened on the card — purchases, payments, fees
     * and refunds under one rule.
     *
     * B97 · Except a charge nobody has filed yet. The envelope holds money a
     * category gave up in order to meet the debt; an uncategorised charge took
     * nothing from any category, so there is nothing to hold. Counting it
     * raised the envelope with no matching fall anywhere, which put the
     * identity out by the amount of every unreviewed card transaction — the
     * ordinary state of a card import between landing and being reviewed.
     *
     * The debt still grows. It simply shows as unbudgeted, which is true, and
     * is what the card's funding warning is for.
     */
    void paymentCategoryByAccount;
    const all = f.creditAccountFlow[meta.paymentAccountId] ?? 0;
    const unfiled = f.creditUncategorisedFlow[meta.paymentAccountId] ?? 0;
    return -(all - unfiled);
  }
  return f.activity[meta.id] ?? 0;
}

function rtaStateOf(rta: Paise): RtaState {
  if (rta === 0) return "zero";
  return rta > 0 ? "positive" : "negative";
}

function mergeAmounts(
  a: Record<string, Paise>,
  b: Record<string, Paise>,
): Record<string, Paise> {
  const out: Record<string, Paise> = { ...a };
  for (const [key, value] of Object.entries(b)) out[key] = (out[key] ?? 0) + value;
  return out;
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

  // 15 §3.2 · The claim on other budgets sits beside the account balances: what
  // they have committed is as much a part of this budget's means as its cash.
  return (
    state.budgetAccountBalance +
    state.dueFromOtherBudgets -
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
  /**
   * N7 · How much of what is owed arrived with the card.
   *
   * An opening balance is not a transaction — there is nothing in the register
   * to file, so a household reading "₹6,200 has no envelope behind it" can look
   * at the card, find no spending that accounts for it, and conclude the
   * warning is broken. It is not: the money is owed and nothing is set aside.
   * Saying where it came from is the difference between a warning and wallpaper.
   */
  startingDebt: Paise;
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
  /**
   * Credit overspend attributed to this card — `MonthState.unfundedByAccount`.
   * Without it the shortfall from a credit overspend is invisible: the payment
   * envelope and the debt move together, so comparing them always gives zero.
   */
  attributedOverspend: Paise = 0,
  /**
   * N7 · The balance the card was added with, so the shortfall can say which
   * part of itself has no transaction behind it. Zero when the caller does not
   * have it, which is every caller that does not word a warning.
   */
  openingBalance: Paise = 0,
): CardFunding {
  const owed = Math.max(0, -outstanding);
  const reallyFunded = paymentCategoryBalance - attributedOverspend;
  return {
    accountId,
    outstanding,
    funded: paymentCategoryBalance,
    // Bounded by the debt for B92's reason: a household can disprove a figure
    // larger than the balance it describes, and that costs more than it buys.
    startingDebt: Math.min(owed, Math.max(0, -openingBalance)),
    /*
     * B92 · Bounded by the debt itself. However the shortfall is arrived at, a
     * card cannot be short by more than it owes — and a figure larger than the
     * balance it describes is one a household can disprove with arithmetic,
     * which costs more trust than the warning was ever worth.
     */
    unfunded: Math.min(owed, Math.max(0, owed - reallyFunded)),
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
//
// B67: R9 originally planned the month from a table of per-category rules,
// with eleven rule types and a plain-language describer. That was replaced by
// funding each category straight to its target, which reads `targets` and
// lives in `app.ts` — and the rule engine has been unreachable ever since,
// because nothing ever wrote a row to `autoassign_rules` for it to read. Its
// tests kept passing, which is exactly what made it easy to miss.
//
// What a plan *is* stays here, because the preview R9 requires is still built
// from it.
// ---------------------------------------------------------------------------

export interface AutoAssignProposal {
  categoryId: string;
  from: Paise;
  to: Paise;
  delta: Paise;
  reason: string;
  /** True when the target wanted more than the money left (R9). */
  limitedByAvailableFunds: boolean;
}

export interface AutoAssignPlan {
  proposals: AutoAssignProposal[];
  totalAssigned: Paise;
  rtaBefore: Paise;
  rtaAfter: Paise;
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
    reading: `${days} days of typical spending already assigned.`,
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
