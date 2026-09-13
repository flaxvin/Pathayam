/**
 * P3 · The household screen: who has put in what, and what is left to cover.
 *
 * Everything here is read from the commitment envelopes (`15` §3). There is no
 * settlement table and no second ledger — *committed* is an envelope's balance
 * and *spent* is its activity, so the two can never disagree with the budget
 * screen either member is looking at.
 *
 * What one member learns about another is deliberately bounded: how much they
 * committed, and how much of it has gone. Never the balance it came out of, nor
 * which account, nor what else is in their budget (`15` §3.3).
 */

import type { DB } from "../db/db.ts";
import type { MonthKey } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget } from "../engine/engine.ts";
import { loadTargets } from "../engine/repository.ts";
import { householdBudgetId, getBudget } from "./budgets.ts";
import { commitmentSources } from "./commitments.ts";
import { listCategories } from "./budget.ts";
import { GIVEN_UP_CATEGORY } from "./squaring-up.ts";
import { standingOf, outstanding, standingSentence, type Standing } from "./standing.ts";

export interface MemberCommitment {
  memberId: string | null;
  budgetId: string;
  /** The committing budget's name, which is the member's own name. */
  name: string;
  categoryId: string;
  /** What is standing in the envelope now: committed and not yet spent. */
  available: Paise;
  /**
   * What the balance was at the start of this month.
   *
   * Without it the row is a level sitting between two flows and the arithmetic
   * visibly does not work: ₹40,000 in and ₹43,320 out does not make ₹36,640.
   * It makes ₹3,320 — on top of the ₹33,320 that was already there.
   */
  broughtForward: Paise;
  /** Assigned into it this month. */
  assignedThisMonth: Paise;
  /** Spent out of it this month — household spending paid from their own money. */
  spentThisMonth: Paise;
  /** A standing monthly figure, if they set one (R8). */
  target: Paise | null;
  /** How far short of that target this month is. Zero when there is no target. */
  shortOfTarget: Paise;
  /** 15 §4A.1 · Which way the balance points, in the household's own words. */
  standing: Standing;
  /** Always positive: how much is outstanding, whichever way it points. */
  outstanding: Paise;
  /** One sentence a person can read, third person. */
  sentence: string;
  /**
   * 15 §4A.4 · Where a called-even amount would be spent from, and in whose
   * budget. Named on the page, because "it becomes spending on your side" does
   * not tell anybody which envelope is about to go into the red.
   */
  givingUp: {
    budgetName: string;
    categoryName: string;
    exists: boolean;
    /**
     * 15 §4A.5 · What is given up is an expense for the one giving it and
     * **income for the one receiving it**. The receiving side is the half nobody
     * thinks to ask about, and leaving it unsaid makes the whole thing look like
     * money vanishing.
     */
    receiverName: string;
    /** The giving budget's ordinary envelopes, so it need not be the default. */
    choices: { id: string; name: string }[];
  } | null;
}

export interface HouseholdView {
  month: MonthKey;
  /** Σ of every commitment envelope: the claim in the household's identity. */
  due: Paise;
  committedThisMonth: Paise;
  spentThisMonth: Paise;
  members: MemberCommitment[];
  /** Whether anybody keeps a separate budget at all. */
  separateBudgets: boolean;
  /**
   * Whose commitment is short — the rows with something to settle, and the only
   * ones the squaring-up options apply to.
   */
  underfunded: MemberCommitment[];
}

export function buildHouseholdView(db: DB, month: MonthKey): HouseholdView {
  const household = householdBudgetId(db);
  const sources = commitmentSources(db, household);
  const targets = new Map(loadTargets(db).map((t) => [t.categoryId, t]));

  const members: MemberCommitment[] = sources.map((source) => {
    /*
     * Each committing budget is computed in its entirety and one envelope read
     * off it. That is the same reckoning the engine does for the claim itself —
     * see loadClaim — and doing it the same way is the point: two ways of
     * working out what Ravi has committed is one way too many.
     */
    const state = computeBudget(
      loadEngineInput(db, { through: month, budgetId: source.budgetId }),
    ).get(month);
    const envelope = state?.categories.get(source.categoryId);
    const balance = (envelope?.balance ?? 0) as Paise;
    const target = targets.get(source.categoryId)?.amount ?? null;
    const assigned = (envelope?.assigned ?? 0) as Paise;

    return {
      memberId: source.memberId,
      budgetId: source.budgetId,
      name: source.budgetName,
      categoryId: source.categoryId,
      available: balance,
      broughtForward: (envelope?.opening ?? 0) as Paise,
      assignedThisMonth: assigned,
      // Activity is negative when money leaves; report it as a positive figure.
      spentThisMonth: Math.max(0, -(envelope?.activity ?? 0)) as Paise,
      target,
      shortOfTarget: (target === null ? 0 : Math.max(0, target - assigned)) as Paise,
      standing: standingOf(balance),
      givingUp: describeGivingUp(db, source.budgetId, balance),
      outstanding: outstanding(balance),
      sentence: standingSentence(balance, source.budgetName),
    };
  });

  return {
    month,
    due: members.reduce((sum, m) => sum + m.available, 0) as Paise,
    committedThisMonth: members.reduce((sum, m) => sum + m.assignedThisMonth, 0) as Paise,
    spentThisMonth: members.reduce((sum, m) => sum + m.spentThisMonth, 0) as Paise,
    members,
    separateBudgets: sources.length > 0,
    underfunded: members.filter((m) => m.standing === "underfunded"),
  };
}

/**
 * Which envelope a called-even amount would land in, without creating it.
 *
 * Whoever is *overfunded* is the one giving something up, and the sign says which
 * that is. Read-only on purpose: this runs on a GET, and a page render must not
 * quietly make an envelope somebody may never use.
 */
function describeGivingUp(
  db: DB, envelopeBudgetId: string, balance: Paise,
): MemberCommitment["givingUp"] {
  if (balance === 0) return null;
  const household = householdBudgetId(db);
  // Underfunded: the envelope's own budget paid for more than it set aside, so it
  // is the one letting it go. Overfunded: the other budget is.
  const givingId = balance < 0 ? envelopeBudgetId : household;
  const receivingId = givingId === household ? envelopeBudgetId : household;
  const giving = getBudget(db, givingId);
  const receiving = getBudget(db, receivingId);
  if (!giving || !receiving) return null;

  const existing = listCategories(db, { includeHidden: true, budgetId: givingId })
    .find((c) => c.name === GIVEN_UP_CATEGORY);
  return {
    budgetName: giving.kind === "household" ? "the household budget" : `${giving.name}'s budget`,
    categoryName: GIVEN_UP_CATEGORY,
    exists: Boolean(existing),
    receiverName: receiving.kind === "household" ? "the household" : receiving.name,
    // Ordinary envelopes only: a commitment or a card's payment envelope is not
    // somewhere the household gets to book this.
    choices: listCategories(db, { budgetId: givingId })
      .filter((c) => !c.commits_to_budget_id && !c.payment_account_id)
      .map((c) => ({ id: c.id, name: c.name })),
  };
}
