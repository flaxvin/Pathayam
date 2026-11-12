/**
 * ENG-22 · Money borrowed is not money earned.
 *
 * A personal loan of ₹5,00,000 paid into savings is cash to give a job to, so
 * it reaches Ready to Assign like any other receipt (R15.2). It is not income:
 * counted as income, it made FIRE's annual income and savings rate, the
 * Overview's income chart, a month's close and the Tax page's starting figure
 * ₹5,00,000 larger than anything earned.
 *
 * A row is borrowed money when a loan disbursement names it as the money it
 * paid in (loan_disbursements.transaction_id). That covers a loan drawn when
 * it is added, a later tranche or top-up, and the credit a card EMI
 * conversion puts on the card. It is decided by that link, never by a memo.
 *
 * The rest of the ways borrowed or returned money arrives are already not
 * income, because they are transfers: money a family member lends you or
 * repays you (family-loans.ts), and a deposit's proceeds moved to the bank.
 */

import type { DB } from "../db/db.ts";
import { queryAll } from "../db/db.ts";
import type { IsoDate } from "../core/dates.ts";

/** SQL that is true when the transaction aliased `alias` is a loan's money paid in. */
export function borrowedRowSql(alias = "t"): string {
  return `EXISTS (SELECT 1 FROM loan_disbursements bd WHERE bd.transaction_id = ${alias}.id)`;
}

/** The ids of borrowed-money rows dated `from` to `to`, both inclusive. */
export function borrowedTransactionIds(db: DB, from: IsoDate, to: IsoDate): Set<string> {
  return new Set(queryAll<{ id: string }>(
    db,
    `SELECT t.id AS id FROM loan_disbursements d JOIN transactions t ON t.id = d.transaction_id
      WHERE t.date >= ? AND t.date <= ?`,
    from, to,
  ).map((r) => r.id));
}
