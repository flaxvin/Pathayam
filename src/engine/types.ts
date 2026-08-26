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
}

export interface CategoryGroupMeta {
  id: string;
  name: string;
  kind: "normal" | "credit-payments" | "loan-payments" | "internal";
  sort: number;
  hidden: boolean;
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
  /** Net change in Budget-account balances, including openings dated here. */
  budgetAccountFlow: Paise;
  /** The categorised portion of that flow. */
  budgetCategorisedFlow: Paise;
  /** The transfer-leg portion of that flow, which never reaches RTA. */
  budgetTransferFlow: Paise;
  /** R11: income explicitly set aside during this month, for the next one. */
  held: Paise;
}

export function emptyMonth(): MonthlyFacts {
  return {
    assigned: {},
    activity: {},
    creditActivity: {},
    creditAccountFlow: {},
    budgetAccountFlow: 0,
    budgetCategorisedFlow: 0,
    budgetTransferFlow: 0,
    held: 0,
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
   * Cumulative credit overspend absorbed at rollovers up to here. This is the
   * part of card debt no envelope is funding (R6) — the figure S2b states as
   * "₹3,200 of this balance isn't funded yet".
   */
  unfundedCreditAbsorbed: Paise;
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
