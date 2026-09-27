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
import { listCategories, visibleBudgetIds } from "./budget.ts";
import { GIVEN_UP_CATEGORY, listEvenCalls, calledEvenTotal } from "./squaring-up.ts";
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
    /**
     * BUDGET-11 · Whether the reader may call it even: it belongs to the
     * budget giving something up, so it is theirs only when they can see that
     * budget. Ravi was offered the form for Priya's shortfall — spending in
     * her budget — and every press of it answered 404.
     */
    canAct: boolean;
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
  /**
   * What has already been called even, and by whom.
   *
   * `15` §4A.3 calls this the only one of the three endings that actually lets
   * something go, and an agreement to let money go is exactly the thing a
   * household will want to be able to point at later. It was recorded in full
   * and shown nowhere: `listEvenCalls` and `calledEvenTotal` were written,
   * tested, and read by no screen.
   */
  settled: SettledEntry[];
  settledTotal: Paise;
}

export interface SettledEntry {
  month: MonthKey;
  /** Whose commitment was closed, in the words the rest of the page uses. */
  name: string;
  amount: Paise;
  /** The budget that gave it up, and the envelope it was spent from. */
  givingBudgetName: string;
  /** Null when that envelope is in a budget the reader cannot see (BUDGET-22). */
  givingCategoryName: string | null;
  note: string | null;
}

export function buildHouseholdView(
  db: DB, month: MonthKey,
  /**
   * BUDGET-10 · Who is reading. The page is shared, but what it may say about
   * a budget's *other* envelopes depends on whose budget it is: the member
   * reading it sees their own, and nobody else's. Omitted means no reader —
   * the month close and the digest, which read only the totals.
   */
  viewerMemberId?: string | null,
): HouseholdView {
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
      givingUp: describeGivingUp(db, source.budgetId, balance, viewerMemberId),
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
    settled: describeSettled(db, members, month, viewerMemberId),
    settledTotal: members.reduce(
      (sum, m) => sum + calledEvenTotal(db, m.categoryId, month), 0,
    ) as Paise,
  };
}

/**
 * Everything called even up to and including this month, newest first.
 *
 * Named by whose commitment it closed rather than by envelope id, because the
 * sentence a reader wants is "we agreed to leave ₹2,000 of Ravi's March", not a
 * row of identifiers.
 */
function describeSettled(
  db: DB, members: MemberCommitment[], month: MonthKey, viewerMemberId?: string | null,
): SettledEntry[] {
  const byEnvelope = new Map(members.map((m) => [m.categoryId, m.name]));
  /*
   * BUDGET-22 · Named as the reader may see them. When Priya called her
   * shortfall even from her private "Divorce lawyer fund", Ravi's household
   * page printed "Priya, from Divorce lawyer fund" for good — long after the
   * picker BUDGET-10 closed was gone. Somebody else's envelope is left
   * unnamed; the budget's name says whose it was.
   */
  const categoryNames = new Map(
    listCategories(db, { includeHidden: true, viewerMemberId }).map((c) => [c.id, c.name]),
  );
  const canSee = viewerMemberId === undefined ? null : visibleBudgetIds(db, viewerMemberId ?? null);

  const entries: SettledEntry[] = [];
  for (const envelopeId of byEnvelope.keys()) {
    for (const call of listEvenCalls(db, envelopeId)) {
      if (call.month > month) continue;
      const giving = getBudget(db, call.giving_budget_id);
      entries.push({
        month: call.month,
        name: byEnvelope.get(envelopeId)!,
        amount: call.amount,
        givingBudgetName:
          giving?.kind === "household" ? "the household" : giving?.name ?? "a budget since removed",
        givingCategoryName: categoryNames.get(call.giving_category_id)
          ?? (canSee === null || canSee.has(call.giving_budget_id) ? GIVEN_UP_CATEGORY : null),
        note: call.note,
      });
    }
  }
  return entries.sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
}

/**
 * Which envelope a called-even amount would land in, without creating it.
 *
 * Whoever is *overfunded* is the one giving something up, and the sign says which
 * that is. Read-only on purpose: this runs on a GET, and a page render must not
 * quietly make an envelope somebody may never use.
 */
function describeGivingUp(
  db: DB, envelopeBudgetId: string, balance: Paise, viewerMemberId?: string | null,
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

  /*
   * BUDGET-10 · Read as the viewer. The picker below was every envelope in the
   * giving budget, rendered for everybody who opened the page — so when Priya's
   * commitment was short, Ravi's household page listed her private envelopes by
   * name, which is exactly "what else is in their budget" that the header of
   * this file rules out. He could not use one either: the route 404s an
   * envelope he cannot see. A budget the viewer cannot see offers no choices.
   */
  const asViewer = { budgetId: givingId, viewerMemberId };
  const existing = listCategories(db, { includeHidden: true, ...asViewer })
    .find((c) => c.name === GIVEN_UP_CATEGORY);
  return {
    budgetName: giving.kind === "household" ? "the household budget" : `${giving.name}'s budget`,
    categoryName: GIVEN_UP_CATEGORY,
    exists: Boolean(existing),
    receiverName: receiving.kind === "household" ? "the household" : receiving.name,
    // Ordinary envelopes only: a commitment or a card's payment envelope is not
    // somewhere the household gets to book this.
    choices: listCategories(db, asViewer)
      .filter((c) => !c.commits_to_budget_id && !c.payment_account_id)
      .map((c) => ({ id: c.id, name: c.name })),
    canAct: viewerMemberId === undefined || visibleBudgetIds(db, viewerMemberId ?? null).has(givingId),
  };
}
