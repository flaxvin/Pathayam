/**
 * 15 §4A.1 · How a commitment's balance is said out loud.
 *
 * Two rules, and the second was learned the hard way.
 *
 * **Not the language of debt.** The app already has transactional words —
 * *owes you*, *write off*, *forgiven* — and they are right where they live:
 * `10` §3.5's family lending is money lent to a cousin, which genuinely is a
 * debt with a creditor. Between two people running a household it is the wrong
 * register entirely. Nobody says their partner is in default on the electricity.
 *
 * **And one subject, not two.** The first cut said *"₹36,640 ahead"* in one
 * table and *"the household is ₹36,640 behind with Ravi"* two inches below it.
 * Both were true and they read as a contradiction, because one described the
 * member and the other the household. So everything here describes **the
 * commitment**, and borrows the budget screen's own words for an envelope with
 * too little or too much in it:
 *
 * | Envelope | Word | What happened |
 * |---|---|---|
 * | below zero | **underfunded** | more of the household's spending was paid from their money than they put aside |
 * | above zero | **overfunded** | more was set aside for the household than has been spent |
 * | zero | **square** | nothing outstanding either way |
 */

import { formatPaise, type Paise } from "../core/money.ts";

export type Standing = "overfunded" | "underfunded" | "even";

/**
 * Which way a commitment envelope's balance points.
 *
 * A **positive** balance is money committed and not yet spent — more has been
 * put aside than has gone out, so the commitment is overfunded. A **negative**
 * balance means household spending has outrun what was put aside for it, which
 * is the same thing the budget screen calls underfunded.
 */
export function standingOf(envelopeBalance: Paise): Standing {
  if (envelopeBalance > 0) return "overfunded";
  if (envelopeBalance < 0) return "underfunded";
  return "even";
}

/** Always positive: how much is outstanding, whichever way it points. */
export function outstanding(envelopeBalance: Paise): Paise {
  return Math.abs(envelopeBalance) as Paise;
}

/** The one word for a row or a chip. */
export function standingLabel(envelopeBalance: Paise): string {
  switch (standingOf(envelopeBalance)) {
    case "underfunded": return "underfunded";
    case "overfunded": return "overfunded";
    default: return "square";
  }
}

/**
 * One sentence, about the commitment rather than about a person's standing.
 *
 * `who` is whose commitment it is; pass null for the reader's own.
 */
export function standingSentence(
  envelopeBalance: Paise, who: string | null, other = "the household",
): string {
  const amount = formatPaise(outstanding(envelopeBalance));
  const whose = who === null ? "Your" : `${who}'s`;
  const they = who === null ? "you" : "they";

  switch (standingOf(envelopeBalance)) {
    /*
     * Both halves, because either on its own is misread. "Gone to the household"
     * sounds like cash was handed over; "gone from the household" sounds like the
     * household paid. What actually happened is that the household's spending was
     * paid out of one person's money, and the sentence says so.
     */
    case "underfunded":
      return (
        `${whose} commitment to ${other} is ${amount} underfunded — that much more ` +
        `of ${other}'s spending has been paid out of ${who === null ? "your" : "their"} ` +
        `money than ${they} put aside for it.`
      );
    case "overfunded":
      return (
        `${whose} commitment to ${other} is ${amount} overfunded — that much has ` +
        `been set aside for ${other} and not yet spent.`
      );
    default:
      return `${whose} commitment to ${other} is square: nothing outstanding either way.`;
  }
}

/** The label on the button that resolves a commitment in the red (15 §4A.2). */
export const PUT_IT_DOWN_TO_ME = "Put it down to me";

/**
 * What that button means, because the name alone does not say it.
 *
 * Funding your own household commitment is not forgiving anybody anything: it is
 * deciding that your share this month was larger. That distinction is the whole
 * reason this wording exists rather than R4's *cover overspending*.
 */
export const PUT_IT_DOWN_TO_ME_HINT =
  "Fund it from your own Ready to Assign. Your share of the household this month " +
  "goes up by this much; nothing is forgiven and nobody else is asked for anything.";

export const PICK_IT_UP = "I'll pick it up";
export const PICK_IT_UP_HINT =
  "You commit this much on top of what you have already, so the shortfall is " +
  "funded from your budget instead of theirs.";

export const CALL_IT_EVEN = "Call it even";
export const CALL_IT_EVEN_HINT =
  "Nobody funds it. It becomes spending on your side — so it needs an envelope, " +
  "the same as anything else the household spends on.";
