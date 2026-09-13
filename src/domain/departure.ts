/**
 * 15 §6A · When a member leaves.
 *
 * Removing somebody is already soft — `removeMember` sets `removed_at`, keeps
 * every historical attribution (F1.6), and `inviteMember` brings them back by
 * clearing it — so the person is never really deleted and re-adding them picks up
 * exactly where they left off.
 *
 * What is not automatic is the money. If they kept a budget of their own there is
 * usually a balance outstanding between them and the household, and two things
 * have to happen to it. Neither may be silent:
 *
 * - **Their commitment is released.** Money still sitting in their household
 *   envelope goes back to their own Ready to Assign. It was theirs; they promised
 *   it, and the promise ends with the arrangement.
 * - **What was already spent does not evaporate.** If the household drew on their
 *   commitment — or they paid for more of it than they put aside — that balance
 *   survives them leaving, and becomes an ordinary family-lending arrangement
 *   (`10` §3.5) with them as the counterparty. That is the right destination
 *   rather than a convenient one: family lending is exactly "money between this
 *   household and a person outside it", which is what they have just become, and
 *   the transactional vocabulary R6.n forbids between partners is correct again
 *   because they are no longer partners in the budget.
 *
 * **Every option is offered, never chosen for them** (`15` §6A).
 */

import type { DB } from "../db/db.ts";
import { queryOne } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { monthOf, todayIST, type MonthKey } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import { getMember } from "../auth/sessions.ts";
import { personalBudgetFor, householdBudgetId } from "./budgets.ts";
import { commitmentEnvelope } from "./commitments.ts";
import { setAssigned } from "./budget.ts";
import { callItEven } from "./squaring-up.ts";
import { createFamilyLoan } from "./family-loans.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget } from "../engine/engine.ts";
import { standingOf, type Standing } from "./standing.ts";

export interface Departure {
  memberId: string;
  memberName: string;
  /** Null when they never kept a budget of their own — then there is nothing to settle. */
  budgetId: string | null;
  envelopeId: string | null;
  /** The commitment envelope's balance. Positive: set aside and unspent. */
  balance: Paise;
  standing: Standing;
  /** Always positive. */
  outstanding: Paise;
  /** Which endings make sense for this balance. */
  options: DepartureResolution[];
}

export type DepartureResolution =
  /** Zero the envelope; unspent money returns to their Ready to Assign. */
  | "release"
  /** The household owes them: record it as family lending, to be settled later. */
  | "family-loan"
  /** Close it by agreement, exactly as calling a month even does. */
  | "call-it-even";

export function describeDeparture(db: DB, memberId: string, month: MonthKey = monthOf(todayIST())): Departure {
  const member = getMember(db, memberId);
  if (!member) throw new Refusal("That member does not exist.");

  const budget = personalBudgetFor(db, memberId);
  const envelope = budget ? commitmentEnvelope(db, budget.id) : null;

  const balance = (budget && envelope
    ? computeBudget(loadEngineInput(db, { through: month, budgetId: budget.id }))
        .get(month)?.categories.get(envelope.id)?.balance ?? 0
    : 0) as Paise;

  /*
   * Which endings are honest for this balance. An overfunded commitment is their
   * own money sitting unspent, so releasing it is the only sensible answer and a
   * family loan would invent a debt. An underfunded one is the household having
   * had the use of their money, which is a real obligation and can be recorded,
   * settled or let go.
   */
  const standing = standingOf(balance);
  const options: DepartureResolution[] =
    standing === "even" ? []
      : standing === "overfunded" ? ["release"]
        : ["family-loan", "call-it-even"];

  return {
    memberId,
    memberName: member.name,
    budgetId: budget?.id ?? null,
    envelopeId: envelope?.id ?? null,
    balance,
    standing,
    outstanding: Math.abs(balance) as Paise,
    options,
  };
}

/**
 * Settle what is outstanding, so the member can be removed without a figure being
 * left behind with nobody attached to it.
 *
 * Returns a sentence for the confirmation message: somebody should be able to read
 * afterwards what was decided.
 */
export function settleDeparture(
  db: DB, actor: Actor, memberId: string, resolution: DepartureResolution,
  month: MonthKey = monthOf(todayIST()),
): string {
  const departure = describeDeparture(db, memberId, month);
  if (departure.standing === "even" || !departure.envelopeId) return "Nothing was outstanding.";
  if (!departure.options.includes(resolution)) {
    throw new Refusal(
      `That is not one of the ways this balance can end. ` +
      `Available: ${departure.options.join(", ")}.`,
    );
  }

  const state = computeBudget(loadEngineInput(db, { through: month, budgetId: departure.budgetId! }))
    .get(month)?.categories.get(departure.envelopeId);
  const assigned = (state?.assigned ?? 0) as Paise;

  switch (resolution) {
    case "release": {
      // Take back what was promised and not spent. An ordinary un-assignment, so
      // their Ready to Assign rises by it and the household's claim falls.
      setAssigned(db, actor, month, departure.envelopeId, (assigned - departure.balance) as Paise);
      return `Released ${departure.outstanding} back to ${departure.memberName}'s Ready to Assign.`;
    }
    case "call-it-even": {
      callItEven(db, actor, {
        envelopeId: departure.envelopeId, amount: departure.outstanding, month,
        note: `${departure.memberName} left the household`,
      });
      return `Called it even.`;
    }
    case "family-loan": {
      /*
       * They are outside the household now, so this is ordinary family lending.
       * No cash moves at this moment — the obligation already exists — so the
       * arrangement opens with the balance rather than being built from an
       * advance. Negative: the household owes them.
       */
      createFamilyLoan(db, actor, {
        counterparty: departure.memberName,
        note: `Outstanding when ${departure.memberName} left the household`,
        openingBalance: -departure.outstanding as Paise,
        startedAt: todayIST(),
      });
      /*
       * And the commitment envelope closes out, because the obligation lives in
       * the loan now and leaving both would count it twice. Closing it moves the
       * amount out of the household's claim and into its Ready to Assign, against
       * a tracking account that says it owes them — so the household's position is
       * unchanged and the debt is recorded where somebody can act on it.
       */
      setAssigned(db, actor, month, departure.envelopeId, (assigned - departure.balance) as Paise);
      return `Recorded as family lending with ${departure.memberName}.`;
    }
  }
}

/** Whether removing this member needs a decision first. */
export function needsSettling(db: DB, memberId: string): boolean {
  return describeDeparture(db, memberId).standing !== "even";
}

/** The household budget, for callers that want to name it. */
export function householdOf(db: DB): string {
  return householdBudgetId(db);
}
