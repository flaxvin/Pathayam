/**
 * 15 §4A.1 · How a balance between two people is said out loud.
 *
 * The app already has transactional language — *owes you*, *write off*,
 * *forgiven* — and it is right where it lives: `10` §3.5's family lending is
 * money lent to a cousin, which genuinely is a debt with a creditor.
 *
 * Between two people running a household it is the wrong register entirely.
 * Nobody says their partner is in default on the electricity; what they say is
 * that one of them has put in more this month. So:
 *
 * | Not this | This |
 * |---|---|
 * | debt, claim, liability | what's outstanding between you, the balance |
 * | Ravi owes the household ₹2,000 | the household is ₹2,000 behind with Ravi |
 * | creditor, debtor | ahead, behind |
 * | forgive, write off | call it even |
 * | settle the debt | square up |
 *
 * The arithmetic inside the engine can keep whichever words are clearest there.
 * This module exists so that every word a person reads comes from one place.
 */

import { formatPaise, type Paise } from "../core/money.ts";

export type Standing = "ahead" | "behind" | "even";

/**
 * Which way a commitment envelope's balance points.
 *
 * A **positive** balance is money committed and not yet spent: its owner has
 * said it is the household's but has not handed it over, so they are *behind*
 * with the household. A **negative** balance means they have paid for more of
 * the household than they put aside, so they are *ahead*.
 */
export function standingOf(envelopeBalance: Paise): Standing {
  if (envelopeBalance > 0) return "behind";
  if (envelopeBalance < 0) return "ahead";
  return "even";
}

/** Always positive: how much is outstanding, whichever way it points. */
export function outstanding(envelopeBalance: Paise): Paise {
  return Math.abs(envelopeBalance) as Paise;
}

/**
 * One sentence, addressed to whoever is reading it.
 *
 * `who` is the member the balance belongs to, in the third person; pass null for
 * the reader's own balance and it uses *you*.
 */
export function standingSentence(
  envelopeBalance: Paise, who: string | null, other = "the household",
): string {
  const amount = formatPaise(outstanding(envelopeBalance));
  const they = who ?? "You";
  const lower = who ?? "you";

  switch (standingOf(envelopeBalance)) {
    case "ahead":
      return who === null
        ? `You are ${amount} ahead — you have paid for more of ${other} than you put aside for it.`
        : `${other === "the household" ? "The household" : other} is ${amount} behind with ${they}.`;
    case "behind":
      return who === null
        ? `You have ${amount} set aside for ${other} that has not been spent yet.`
        : `${they} has ${amount} committed to ${other} and not yet spent.`;
    default:
      return who === null ? `You are square with ${other}.` : `${they} is square with ${other}.`;
  }
}

/** The label on the button that resolves an envelope in the red (15 §4A.2). */
export const PUT_IT_DOWN_TO_ME = "Put it down to me";

/**
 * What that button means, because the name alone does not say it.
 *
 * Covering your own household envelope is not forgiving anybody anything: it is
 * deciding that your share this month was larger. That distinction is the whole
 * reason this wording exists rather than R4's *cover overspending*.
 */
export const PUT_IT_DOWN_TO_ME_HINT =
  "Your share of the household this month goes up by this much. Nothing is " +
  "forgiven and nobody else is asked for anything.";

export const PICK_IT_UP = "I'll pick it up";
export const PICK_IT_UP_HINT =
  "You commit this much on top of what you have already, and the household " +
  "stops being behind with them.";

export const CALL_IT_EVEN = "Call it even";
export const CALL_IT_EVEN_HINT =
  "Nobody pays it. It becomes spending on your side — so it needs an envelope, " +
  "the same as anything else the household spends on.";
