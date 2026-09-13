/**
 * Assembles everything the budget screen needs, in one place.
 *
 * Kept separate from rendering so the numbers can be asserted without parsing
 * HTML, and so a page never reaches past it into the engine or the database.
 */

import type { DB } from "../db/db.ts";
import { queryAll } from "../db/db.ts";
import type { Paise } from "../core/money.ts";
import type { MonthKey, IsoDate } from "../core/dates.ts";
import { todayIST, monthOf } from "../core/dates.ts";
import { budgetsFor } from "../domain/budgets.ts";
import {
  computeBudget, targetProgress, totalUnderfunded, computeBuffer, isFullyFunded,
  cardFunding, futureMonthCaveat, type CardFunding, type Buffer,
} from "../engine/engine.ts";
import type { CategoryState, MonthState, TargetProgress, Target } from "../engine/types.ts";
import {
  loadEngineInput, loadCategoryGroups, loadTargets, averageDailySpend,
  creditOutstanding, householdSettings,
} from "../engine/repository.ts";

export interface CategoryView {
  id: string;
  name: string;
  groupId: string;
  hidden: boolean;
  isPaymentCategory: boolean;
  paymentAccountId: string | null;
  /**
   * 15 §3 · Set when this envelope is a commitment to another budget. It reads
   * differently from every other envelope: in the red it is not an overspend but
   * a bigger share than planned (15 §4A.2), and the words follow from that.
   */
  commitsToBudgetId: string | null;
  /** 15 · Which budget's envelope this is, so a picker can say whose. */
  budgetId: string | null;
  state: CategoryState;
  target: Target | null;
  progress: TargetProgress | null;
  /** A2: a word for the state, so colour is never the only signal. */
  stateLabel: string;
  stateClass: string;
  /** Only a cash overspend is the user's to cover from another envelope (R5). */
  needsCover: boolean;
}

export interface GroupView {
  id: string;
  name: string;
  kind: string;
  categories: CategoryView[];
  assigned: Paise;
  activity: Paise;
  balance: Paise;
}

export interface BudgetView {
  month: MonthKey;
  currentMonth: MonthKey;
  today: IsoDate;
  monthState: MonthState;
  groups: GroupView[];
  categories: Map<string, CategoryView>;
  underfunded: { amount: Paise; categoryCount: number };
  buffer: Buffer;
  fullyFunded: boolean;
  cards: CardFunding[];
  /** R10: "based on money you have today", or null in the present or past. */
  futureCaveat: string | null;
  overspentCategories: CategoryView[];
}

export function buildBudgetView(
  db: DB, month?: MonthKey, budgetId?: string,
  /**
   * 15 · Who is looking, so a picker never offers somebody else's envelopes.
   *
   * "Nobody sees anybody else's accounts, balances or other envelopes" is what
   * the household screen promises, in those words. An unscoped view carries
   * every budget's categories, and five screens handed that straight to a
   * dropdown — Add, Move, the transaction page, the prepayment funding list and
   * the review queue all offered one member's private envelopes to the rest of
   * the household, by name.
   *
   * Omitted means every budget, which is what the digest and the month close
   * want; a screen passes the authenticated member.
   */
  viewerMemberId?: string | null,
): BudgetView {
  const today = todayIST();
  const currentMonth = monthOf(today);
  const target = month ?? currentMonth;

  /*
   * 15 · Which budget's grid this is. Omitted means every budget at once, which
   * is what a household with only the shared one has always seen — and what the
   * month-close ritual and the digest still ask for until P5 scopes them.
   */
  const input = loadEngineInput(db, { through: target, budgetId });
  const budget = computeBudget(input);
  const monthState = budget.get(target) ?? budget.get(input.months.at(-1)!)!;

  const targets = new Map(loadTargets(db).map((t) => [t.categoryId, t]));
  const groupMetas = loadCategoryGroups(db).filter(
    (g) => budgetId === undefined || g.budgetId === undefined || g.budgetId === budgetId,
  );
  const groupById = new Map(groupMetas.map((g) => [g.id, g]));

  const visibleBudgets = viewerMemberId === undefined
    ? null
    : new Set(budgetsFor(db, viewerMemberId ?? null).map((b) => b.id));

  const categories = new Map<string, CategoryView>();
  const progressList: TargetProgress[] = [];

  for (const meta of input.categories) {
    const state = monthState.categories.get(meta.id);
    if (!state) continue;

    /*
     * 15 · Only this budget's envelopes.
     *
     * The engine is handed every category — it costs nothing, because a category
     * from another budget has no facts in this budget's input and computes to
     * zero — but the *view* is what screens read, and a screen that walks
     * `categories` looking for, say, a card's payment envelope would find another
     * budget's and show its bill. The grid was already filtered by group, which
     * hid the problem without fixing it.
     */
    // `groupById` is already this budget's groups, so a category whose group is
    // not in it belongs to another budget.
    if (budgetId !== undefined && !groupById.has(meta.groupId)) continue;

    // And whoever is looking sees the household's envelopes and their own.
    const owner = groupById.get(meta.groupId)?.budgetId ?? null;
    if (visibleBudgets && owner !== null && !visibleBudgets.has(owner)) continue;

    const t = targets.get(meta.id) ?? null;
    // F3.2: a hidden category leaves the underfunded totals.
    const progress = t && !meta.hidden ? targetProgress(t, state, target, today) : null;
    if (progress) progressList.push(progress);

    const view: CategoryView = {
      id: meta.id,
      name: meta.name,
      groupId: meta.groupId,
      hidden: meta.hidden,
      isPaymentCategory: meta.paymentAccountId !== null,
      commitsToBudgetId: meta.commitsToBudgetId ?? null,
      budgetId: groupById.get(meta.groupId)?.budgetId ?? null,
      paymentAccountId: meta.paymentAccountId,
      state,
      target: t,
      progress,
      ...describeState(state, progress, Boolean(meta.commitsToBudgetId)),
    };
    categories.set(meta.id, view);
  }

  const groups: GroupView[] = [];
  for (const g of groupMetas) {
    if (g.hidden) continue;
    const members = [...categories.values()].filter((c) => c.groupId === g.id && !c.hidden);
    if (members.length === 0 && g.kind !== "normal") continue;
    groups.push({
      id: g.id,
      name: g.name,
      kind: g.kind,
      categories: members,
      assigned: members.reduce((sum, c) => sum + c.state.assigned, 0),
      activity: members.reduce((sum, c) => sum + c.state.activity, 0),
      balance: members.reduce((sum, c) => sum + c.state.balance, 0),
    });
  }

  const outstanding = creditOutstanding(db);
  const cards: CardFunding[] = [];
  for (const c of categories.values()) {
    if (!c.paymentAccountId) continue;
    cards.push(
      cardFunding(
        c.paymentAccountId,
        outstanding.get(c.paymentAccountId) ?? 0,
        c.state.balance,
        monthState.unfundedByAccount[c.paymentAccountId] ?? 0,
      ),
    );
  }

  return {
    month: target,
    currentMonth,
    today,
    monthState,
    groups,
    categories,
    underfunded: totalUnderfunded(progressList),
    buffer: computeBuffer(monthState.categories, input.categories, averageDailySpend(db, today)),
    fullyFunded: isFullyFunded(progressList, monthState.readyToAssign),
    cards,
    futureCaveat: futureMonthCaveat(target, currentMonth),
    overspentCategories: [...categories.values()].filter((c) => c.state.balance < 0),
  };
}

/**
 * A2: colour must never be the only signal for a funded or overspent state, so
 * every state carries a word as well as a class.
 */
function describeState(
  state: CategoryState,
  progress: TargetProgress | null,
  /** 15 §4A.1 · A commitment reads differently from every other envelope. */
  isCommitment = false,
): { stateLabel: string; stateClass: string; needsCover: boolean } {
  /*
   * A commitment envelope in the red has not been *overspent* — the word R6.n
   * rules out between partners, and the wrong one anyway. More has gone to the
   * household than was put aside for it, which is what the budget screen calls
   * underfunded everywhere else. Covering it is still the right action, so the
   * affordance stays; only the word changes.
   */
  if (isCommitment) {
    if (state.balance < 0) {
      return { stateLabel: "Underfunded", stateClass: "state-overspent", needsCover: true };
    }
    return {
      stateLabel: state.balance > 0 ? "Committed" : "Square",
      stateClass: "",
      needsCover: false,
    };
  }
  if (state.balance < 0) {
    // R6: a credit overspend created no cash, so it is not covered from
    // another envelope the way a cash overspend is — the two need different
    // words and different actions.
    if (state.creditOverspend > 0 && state.cashOverspend === 0) {
      return { stateLabel: "Overspent on a card", stateClass: "state-overspent", needsCover: false };
    }
    return { stateLabel: "Overspent", stateClass: "state-overspent", needsCover: true };
  }
  if (!progress) {
    return { stateLabel: state.balance > 0 ? "Funded" : "Empty", stateClass: "", needsCover: false };
  }
  switch (progress.state) {
    case "unfunded": return { stateLabel: "Not funded", stateClass: "", needsCover: false };
    case "partial": return { stateLabel: "Partly funded", stateClass: "", needsCover: false };
    case "over-funded": return { stateLabel: "Over-funded", stateClass: "", needsCover: false };
    default: return { stateLabel: "Funded", stateClass: "", needsCover: false };
  }
}

/**
 * S4's badge: everything that needs a human, counted in one place so the
 * number in the nav and the number on the page cannot disagree.
 */
export function reviewCount(db: DB): number {
  const staged =
    queryAll<{ n: number }>(
      db, `SELECT COUNT(*) AS n FROM staged_transactions WHERE status = 'pending'`,
    )[0]?.n ?? 0;

  /*
   * B94 · Money *in* with no category is not a pending decision.
   *
   * In an envelope budget, income's job is to arrive in Ready to Assign and
   * wait to be given one — that is the model, and the engine already treats it
   * exactly so. Counting it as "uncategorised" then asked the household to
   * resolve something the app had already resolved correctly.
   *
   * Over three years of real data this was the *entire* queue: 109 items, every
   * one of them a salary or NEFT credit, and not a single piece of genuinely
   * uncategorised spending among them. The one thing the queue is for was
   * buried under the one thing it should never have contained.
   *
   * A refund that ought to go back to the category it came from is the real
   * exception, and it is a minority the app cannot pick out by itself. It stays
   * findable on Query rather than shouting here.
   */
  const uncategorised =
    queryAll<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE t.deleted_at IS NULL AND t.is_split = 0 AND t.category_id IS NULL
          AND t.transfer_pair_id IS NULL AND a.kind != 'tracking'
          AND t.amount < 0`,
    )[0]?.n ?? 0;

  const brokenCheckpoints =
    queryAll<{ n: number }>(
      db, `SELECT COUNT(*) AS n FROM reconciliations WHERE broken_at IS NOT NULL`,
    )[0]?.n ?? 0;

  const proposedRules =
    queryAll<{ n: number }>(
      db, `SELECT COUNT(*) AS n FROM rules WHERE proposed = 1 AND dismissed_at IS NULL`,
    )[0]?.n ?? 0;

  /*
   * B79 · The badge counted four of the six things the Review page lists, so
   * the sidebar said "1" while the page it links to said "3". The two it missed
   * — an overspent category and a card balance with no money behind it — are
   * the two most worth acting on, and a household seeing "1" had no reason to
   * go and look.
   *
   * These need the month's derived state rather than a row count, which is why
   * they were left out. That is cheap now (B73–B75), and a badge that
   * disagrees with the page it points at is worse than the millisecond.
   */
  const view = buildBudgetView(db);
  const overspent = view.overspentCategories.length;

  // The same reckoning the Review page itself does — cardFunding weighs what
  // the card actually owes against what its envelope holds, and counting the
  // raw unfunded figure instead was how these two disagreed in the first place.
  const outstanding = creditOutstanding(db);
  const unfundedCards = [...view.categories.values()]
    .filter((c) => c.paymentAccountId)
    .filter(
      (c) =>
        cardFunding(
          c.paymentAccountId!,
          outstanding.get(c.paymentAccountId!) ?? 0,
          c.state.balance,
          view.monthState.unfundedByAccount[c.paymentAccountId!] ?? 0,
        ).unfunded > 0,
    ).length;

  return staged + uncategorised + brokenCheckpoints + proposedRules + overspent + unfundedCards;
}

export function isSetupComplete(db: DB): boolean {
  return householdSettings(db)?.setup_completed_at !== null;
}
