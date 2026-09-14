/**
 * N7 · The part of a card's shortfall that has nothing to look at.
 *
 * A card added with an opening balance of −₹6,200 says "₹6,200 of your Swiggy
 * HDFC balance has no envelope behind it", and a household that goes looking for
 * the spending behind it finds none: an opening balance is a fact about the
 * account, not a transaction, so there is nothing in the register to file and
 * nothing to click. The warning is honest and looks broken, which is the worst
 * combination a warning can have — it becomes wallpaper, and the next real one
 * is read the same way (see the card that claimed to be nine days late).
 *
 * It *is* clearable: assigning to the card's payment envelope covers it like
 * anything else. So the warning says where the money came from and what clears
 * it, rather than leaving a household to work out that the app is not broken.
 */

import { formatPaise } from "../core/money.ts";
import type { CardFunding } from "../engine/engine.ts";

export function cameWithTheCard(funding: CardFunding): string | null {
  if (funding.startingDebt <= 0 || funding.unfunded <= 0) return null;
  const part = Math.min(funding.startingDebt, funding.unfunded);
  return part >= funding.unfunded
    ? "It came with the card when you added it, so there is no spending to file — "
      + "it clears when you put money in the envelope."
    : `${formatPaise(part)} of it came with the card when you added it, so there is `
      + "no spending to file for that part — it clears when you put money in the envelope.";
}
