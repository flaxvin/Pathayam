/**
 * ENG-22 · Money borrowed is not money earned.
 *
 * A personal loan of ₹5,00,000 paid into savings is cash to give a job to, so
 * it reaches Ready to Assign like any other receipt (R15.2). It is not income:
 * counted as income, it made FIRE's annual income and savings rate, the
 * Overview's income chart, a month's close and the Tax page's starting figure
 * ₹5,00,000 larger than anything earned.
 *
 * ENG-23 · Nor is money coming back. Selling ₹3,00,000 of a fund, or a gold
 * coin, turns something you already owned into cash: return of capital, not
 * earnings. The gain inside it is reported where gains are (the Tax page adds
 * realised gains on their own, so counting the proceeds as well counted the
 * gain twice there).
 *
 * A row is left out of income when something links it as such, never by its
 * memo:
 *   · a loan disbursement names it as the money it paid in
 *     (loan_disbursements.transaction_id) — a loan drawn when it is added, a
 *     later tranche or top-up, and the credit a card EMI conversion puts on
 *     the card;
 *   · a portfolio sale names it as its proceeds (holding_events.transaction_id,
 *     kind 'sale');
 *   · a hand-valued asset's sale names it as its proceeds
 *     (asset_valuations.proceeds_transaction_id).
 *
 * The rest of the ways borrowed or returned money arrives are already not
 * income, because they are transfers: money a family member lends you or
 * repays you (family-loans.ts), and a deposit's proceeds moved to the bank.
 * A dividend stays income: it is earned.
 */

import type { DB } from "../db/db.ts";
import { queryAll } from "../db/db.ts";
import type { IsoDate } from "../core/dates.ts";

/** SQL that is true when the transaction aliased `alias` is borrowed or returned money. */
export function notIncomeRowSql(alias = "t"): string {
  return `(EXISTS (SELECT 1 FROM loan_disbursements bd WHERE bd.transaction_id = ${alias}.id)
       OR EXISTS (SELECT 1 FROM holding_events he WHERE he.transaction_id = ${alias}.id AND he.kind = 'sale')
       OR EXISTS (SELECT 1 FROM asset_valuations av WHERE av.proceeds_transaction_id = ${alias}.id))`;
}

/** The ids of borrowed or returned money dated `from` to `to`, both inclusive. */
export function notIncomeTransactionIds(db: DB, from: IsoDate, to: IsoDate): Set<string> {
  return new Set(queryAll<{ id: string }>(
    db,
    `SELECT t.id AS id FROM transactions t
      WHERE t.date >= ? AND t.date <= ? AND ${notIncomeRowSql("t")}`,
    from, to,
  ).map((r) => r.id));
}
