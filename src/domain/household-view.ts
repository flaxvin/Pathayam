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
import { householdBudgetId } from "./budgets.ts";
import { commitmentSources } from "./commitments.ts";
import { standingOf, outstanding, standingSentence, type Standing } from "./standing.ts";

export interface MemberCommitment {
  memberId: string | null;
  budgetId: string;
  /** The committing budget's name, which is the member's own name. */
  name: string;
  categoryId: string;
  /** What is standing in the envelope now: committed and not yet spent. */
  available: Paise;
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
  /** Anybody the household is behind with, which is who a month-end owes. */
  aheadOfUs: MemberCommitment[];
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
      assignedThisMonth: assigned,
      // Activity is negative when money leaves; report it as a positive figure.
      spentThisMonth: Math.max(0, -(envelope?.activity ?? 0)) as Paise,
      target,
      shortOfTarget: (target === null ? 0 : Math.max(0, target - assigned)) as Paise,
      standing: standingOf(balance),
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
    aheadOfUs: members.filter((m) => m.standing === "ahead"),
  };
}
