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

import { formatPaise, type Paise } from "../core/money.ts";
import type { IsoDate } from "../core/dates.ts";
import type { DB } from "../db/db.ts";
import { queryAll } from "../db/db.ts";
import type { CardFunding } from "../engine/engine.ts";

/**
 * Decision 9 (UI-7) · What has been paid to each card since it was added, up to
 * a date: transfers into the card on or after its opening date. They clear the
 * opening balance first, so `cardFunding` takes them off the part that "came
 * with the card".
 *
 * A loan or EMI plan paying a card down (a card EMI conversion) is left out:
 * it replaces one charge with a plan, and is not the household paying off the
 * balance the card arrived with.
 */
export function cardPaymentsSinceOpening(db: DB, through: IsoDate): Map<string, Paise> {
  return new Map(
    queryAll<{ account_id: string; paid: number }>(
      db,
      `SELECT t.account_id, SUM(t.amount) AS paid
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN transactions o ON o.transfer_pair_id = t.transfer_pair_id AND o.id <> t.id
         JOIN accounts oa ON oa.id = o.account_id
        WHERE a.kind = 'credit' AND t.amount > 0 AND t.transfer_pair_id IS NOT NULL
          AND t.deleted_at IS NULL AND o.deleted_at IS NULL
          AND t.date >= a.opening_date AND t.date <= ?
          AND oa.subtype NOT IN ('loan', 'emi')
        GROUP BY t.account_id`,
      through,
    ).map((r) => [r.account_id, r.paid]),
  );
}

export function cameWithTheCard(funding: CardFunding): string | null {
  if (funding.startingDebt <= 0 || funding.unfunded <= 0) return null;
  // UI-1 · Overspending on the card is spending, with a register line to file;
  // only what is left of the shortfall after it can have come with the card.
  const part = Math.min(funding.startingDebt, funding.unfunded - funding.fromOverspend);
  if (part <= 0) return null;
  return part >= funding.unfunded
    ? "It came with the card when you added it, so there is no spending to file — "
      + "it clears when you put money in the envelope."
    : `${formatPaise(part)} of it came with the card when you added it, so there is `
      + "no spending to file for that part — it clears when you put money in the envelope.";
}
