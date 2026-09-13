/**
 * The engine's inputs and outputs.
 *
 * The engine is pure: it takes plain aggregates and returns plain state. The
 * repository (`repository.ts`) builds the aggregates with SQL; the tests build
 * them by hand. Nothing here touches a database, which is what makes R1–R13
 * testable against the worked ₹ examples in `02` §4 before any UI exists
 * (`05` §8 step 2).
 */

import type { Paise } from "../core/money.ts";
import type { MonthKey, IsoDate } from "../core/dates.ts";

/** Q1: both models ship. `reduce-rta` is Actual's, and the default. */
export type OverspendModel = "reduce-rta" | "carry-negative";

export interface CategoryMeta {
  id: string;
  name: string;
  groupId: string;
  /** F3.2: excluded from auto-assign and from underfunded totals. */
  hidden: boolean;
  /**
   * Set when this is a credit-card payment category (R6). Its activity is
   * derived from that account's transactions and never stored.
   */
  paymentAccountId: string | null;
  /**
   * 15 §3 / §6.1 · Set when this envelope is a commitment to another budget.
   *
   * Such an envelope **never has its negative absorbed at a rollover.** An
   * ordinary envelope that goes red has overspent, and R4 answers that by
   * resetting it and taking the money out of Ready to Assign. A commitment that
   * goes red is a debt between two budgets, and it does not stop existing
   * because the month ended — the other budget is still owed it. Absorbing it
   * made the receiving budget's claim snap back to zero while its own overspend
   * came out of its own Ready to Assign, so the two stopped corresponding and
   * the identity failed by the amount.
   */
  commitsToBudgetId?: string | null;
}

export interface CategoryGroupMeta {
  id: string;
  name: string;
  kind: "normal" | "credit-payments" | "loan-payments" | "internal";
  sort: number;
  hidden: boolean;
  /** 15 · Which budget's envelopes these are. Null on a pre-migration row. */
  budgetId?: string | null;
}

/**
 * Everything that happened in one month, pre-aggregated.
 *
 * Amounts are signed paise; negative means money left. See
 * `docs/dev/01-engine-derivation.md` §2 for the convention and §3 for why
 * transfers are held separately from ordinary flow.
 */
export interface MonthlyFacts {
  /** Net assigned per category this month (R7). Moves are already netted in. */
  assigned: Record<string, Paise>;
  /** Activity per category from every account, signed. */
  activity: Record<string, Paise>;
  /**
   * The portion of `activity` charged to Credit accounts. Needed to tell a
   * credit overspend from a cash one — only the latter destroys cash (R6).
   */
  creditActivity: Record<string, Paise>;
  /**
   * Sum of every transaction on each Credit account this month, excluding its
   * opening balance. Negated, this is the payment category's activity (R6).
   */
  creditAccountFlow: Record<string, Paise>;
  /**
   * Credit-charged activity broken down by category *and* card account.
   * Needed to attribute a credit overspend back to the card that carries the
   * debt — see `unfundedByAccount` on MonthState.
   * Shape: categoryId -> accountId -> signed paise.
   */
  creditActivityByAccount: Record<string, Record<string, Paise>>;
  /**
   * B97 · Card spending with no category on it, per card account.
   *
   * The payment envelope tracks money that a category gave up in order to meet
   * the card's debt. A charge nobody has filed yet gave nothing up, so it must
   * not raise the envelope — and until this existed it did, which broke the
   * identity by the amount of every unreviewed card transaction.
   */
  creditUncategorisedFlow: Record<string, Paise>;
  /** Net change in Budget-account balances, including openings dated here. */
  budgetAccountFlow: Paise;
  /** The categorised portion of that flow. */
  budgetCategorisedFlow: Paise;
  /** The transfer-leg portion of that flow, which never reaches RTA. */
  budgetTransferFlow: Paise;
  /** R11: income explicitly set aside during this month, for the next one. */
  held: Paise;
  /**
   * 15 §4A.4 · Received this month because another budget called a balance even.
   *
   * Income, and for the plainest of reasons: the money was owed and now is not,
   * so this budget is better off by it. The matching expense sits in the giving
   * budget's own envelope, which is why nothing appears from nowhere.
   */
  calledEvenIncome: Paise;
}

export function emptyMonth(): MonthlyFacts {
  return {
    assigned: {},
    activity: {},
    creditActivity: {},
    creditAccountFlow: {},
    creditActivityByAccount: {},
    creditUncategorisedFlow: {},
    budgetAccountFlow: 0,
    budgetCategorisedFlow: 0,
    budgetTransferFlow: 0,
    held: 0,
    calledEvenIncome: 0,
  };
}

export interface EngineInput {
  /**
   * Contiguous ascending months, from the first with any data through the last
   * month carrying an assignment or being viewed. The engine must walk them in
   * order because a rollover depends on the month before it (R3, R4, R13).
   */
  months: MonthKey[];
  facts: Record<MonthKey, MonthlyFacts>;
  categories: CategoryMeta[];
  overspendModel: OverspendModel;
  /** Opening balances of Credit accounts — starting debt (R6). */
  creditOpeningBalances?: Record<string, Paise>;
  /**
   * 15 §3.2 · The claim on other budgets at the end of each month: the balance of
   * every envelope committing to this one. A **level**, and the term that joins
   * the left of the identity beside the account balances.
   *
   * Omitted for a personal budget: nothing commits to one, and the personal
   * identity needs no new term.
   */
  dueFromOtherBudgets?: Record<MonthKey, Paise>;
  /**
   * 15 §3.2 · What was *assigned into* those envelopes in each month: a **flow**,
   * and income to this budget.
   *
   * The two have to be separate, and getting that wrong cost an afternoon. A
   * commitment arrives as means — the household could not assign it otherwise —
   * so it belongs in income. But the claim then *falls* as the money is spent,
   * and that spending is already recorded as activity on this budget's own
   * envelopes. Adding the balance to income as well counted the spending twice,
   * and the identity failed by it in exactly the case that matters: a member who
   * has paid for more of the household than they put aside for.
   */
  committedToMe?: Record<MonthKey, Paise>;
}

export interface CategoryState {
  categoryId: string;
  /** Balance carried in from the previous month (R3, R4). */
  opening: Paise;
  assigned: Paise;
  activity: Paise;
  /** opening + assigned + activity (`02` §3). */
  balance: Paise;
  /** Of a negative balance, the part caused by spending from a Budget account. */
  cashOverspend: Paise;
  /** Of a negative balance, the part charged to a card — never reduces RTA. */
  creditOverspend: Paise;
  /** What this category will open next month with. */
  carry: Paise;
}

/** R2's display states, so the UI never re-derives the thresholds. */
export type RtaState = "positive" | "zero" | "negative";

export interface RtaBreakdown {
  /** Σ to_budget for every month up to and including this one. */
  incomeToDate: Paise;
  assignedThisMonthAndEarlier: Paise;
  assignedInFutureMonths: Paise;
  heldForNextMonth: Paise;
  cashOverspendCarried: Paise;
  /**
   * 15 §3.2 · Committed to this budget in this month, and counted in
   * `incomeToDate` from here on. Reported separately so the RTA explanation can
   * say *"₹38,000 of this is Ravi's commitment"* rather than folding it into
   * income as though it had arrived in an account.
   */
  committedToMe: Paise;
  total: Paise;
}

export interface MonthState {
  month: MonthKey;
  categories: Map<string, CategoryState>;
  readyToAssign: Paise;
  rtaState: RtaState;
  rtaBreakdown: RtaBreakdown;
  /** Cash overspend carried in from the previous month (R4, `reduce-rta`). */
  cashOverspendCarriedIn: Paise;
  /** R11: amount set aside during this month for the next one. */
  heldForNextMonth: Paise;
  /** Budget-account balance at the end of this month. */
  budgetAccountBalance: Paise;
  /**
   * 15 §3.2 · The claim on other budgets at the end of this month: the sum of
   * their commitment envelopes. Zero for a personal budget, and for a household
   * nobody has committed to.
   */
  dueFromOtherBudgets: Paise;
  /**
   * Cumulative credit overspend absorbed at rollovers up to here. This is the
   * part of card debt no envelope is funding (R6) — the figure S2b states as
   * "₹3,200 of this balance isn't funded yet".
   */
  unfundedCreditAbsorbed: Paise;
  /**
   * Per Credit account, how much of its balance no envelope is really
   * covering (R6). This is *not* derivable by comparing the payment
   * category's balance against the debt: those two move together by
   * construction, so the comparison is always zero. A credit overspend
   * inflates the payment envelope with money the spending category never
   * had, and this is the figure that records it.
   */
  unfundedByAccount: Record<string, Paise>;
}

export type BudgetState = Map<MonthKey, MonthState>;

// ---------------------------------------------------------------------------
// Targets (R8)
// ---------------------------------------------------------------------------

export type TargetType =
  | "monthly"
  | "refill"
  | "refill-hold"
  | "spending-period"
  | "by-date"
  | "by-date-repeating"
  | "debt-payoff"
  | "schedule-linked";

export interface Target {
  categoryId: string;
  type: TargetType;
  amount: Paise | null;
  targetDate: IsoDate | null;
  period: "day" | "week" | "month" | null;
  /** For schedule-linked targets: the next occurrence's amount and due date. */
  scheduleAmount?: Paise | null;
  scheduleDue?: IsoDate | null;
}

export type FundedState = "unfunded" | "partial" | "funded" | "over-funded";

export interface TargetProgress {
  categoryId: string;
  /** What this target wants in this category, this month. */
  needed: Paise;
  /** needed − assigned, never negative. The "underfunded" figure (R8). */
  underfunded: Paise;
  state: FundedState;
}
