/**
 * Where the ledger and the figure on screen disagree.
 *
 * Three kinds of account show a value that is *derived* rather than counted
 * from their transactions, and in each case a transaction recorded against the
 * account from the Accounts screen simply does not appear:
 *
 *   - **A tracking account with a stated valuation.** B56 settled that the
 *     stated figure beats the running balance, because that is the only way to
 *     say what a PPF has grown to. Pay ₹10,000 into that PPF and the stated
 *     figure keeps winning; the contribution vanishes.
 *   - **An investment account.** Net worth sums the market value of its
 *     holdings. A purchase records the cash leaving the *budget* account it
 *     came from, so the demat account's own balance is not part of that sum at
 *     all — money transferred in and not yet invested is counted nowhere.
 *   - **A loan account.** The outstanding comes from the amortisation schedule
 *     and the payments recorded against the loan. A payment entered straight
 *     onto the account is not one of those, so the balance owed does not move.
 *
 * Each of those is defensible on its own and indefensible together: the app
 * accepts a transaction, says nothing, and shows a figure that does not include
 * it.
 *
 * ## Why this reports rather than resolves
 *
 * Adding the movements would be wrong for a revalued flat, where the stated
 * figure already includes everything. Ignoring them is what loses the ₹10,000.
 * There is no rule that is right for both, because the two cases are genuinely
 * different and only the household knows which it meant.
 *
 * So the divergence is surfaced and the person decides — the same thing this
 * app already does when a statement and the ledger disagree, rather than
 * silently adopting either.
 */

import type { DB } from "../db/db.ts";
import { queryAll, queryOne } from "../db/db.ts";
import type { Paise } from "../core/money.ts";
import { formatPaise } from "../core/money.ts";
import { todayIST, type IsoDate } from "../core/dates.ts";
import { SIMPLE_TRACKING_SUBTYPES } from "./accounts.ts";
import { listLoans, projectLoan } from "./loans.ts";

/**
 * Below this, a difference is rounding or a stale price rather than something
 * somebody forgot — the same threshold Q12 set for loan reconciliation.
 */
export const DRIFT_THRESHOLD = 50_000 as Paise; // ₹500

export type DriftKind = "stated-valuation" | "uninvested" | "loan";

export interface AccountDrift {
  accountId: string;
  accountName: string;
  kind: DriftKind;
  /** What the ledger holds that the figure on screen does not. */
  gap: Paise;
  /** The date the shown figure is as of, where there is one. */
  since: IsoDate | null;
  explanation: string;
  fixHref: string;
}

function ledgerBalance(db: DB, accountId: string): Paise {
  return (queryOne<{ total: number }>(
    db,
    `SELECT COALESCE(SUM(t.amount), 0)
            + (SELECT opening_balance FROM accounts WHERE id = ?) AS total
       FROM transactions t WHERE t.account_id = ? AND t.deleted_at IS NULL`,
    accountId, accountId,
  )?.total ?? 0) as Paise;
}

/**
 * Every account whose shown figure and ledger have parted company.
 *
 * Scoped by viewer like every other total: a drift on somebody else's private
 * account is not this person's business, and naming it would disclose that the
 * account exists.
 */
export function accountDrifts(
  db: DB,
  opts: { viewerMemberId?: string | null; asOf?: IsoDate } = {},
): AccountDrift[] {
  const asOf = opts.asOf ?? todayIST();
  const out: AccountDrift[] = [];

  const visible = (extra: string) =>
    opts.viewerMemberId !== undefined
      ? `${extra} AND (visibility = 'household' OR holder_member_id IS ?)`
      : extra;
  const params = opts.viewerMemberId !== undefined ? [opts.viewerMemberId ?? null] : [];

  // 1 · A stated valuation that money has moved past.
  const tracking = queryAll<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM accounts
      WHERE ${visible(`kind = 'tracking' AND closed_at IS NULL
        AND subtype IN (${SIMPLE_TRACKING_SUBTYPES.map(() => "?").join(",")})`)}
      ORDER BY name`,
    ...SIMPLE_TRACKING_SUBTYPES, ...params,
  );
  for (const account of tracking) {
    const valuation = queryOne<{ as_of: string }>(
      db,
      `SELECT as_of FROM asset_valuations WHERE account_id = ?
        ORDER BY as_of DESC, created_at DESC LIMIT 1`,
      account.id,
    );
    if (!valuation) continue;

    const moved = (queryOne<{ total: number }>(
      db,
      `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
        WHERE account_id = ? AND deleted_at IS NULL AND date > ? AND date <= ?`,
      account.id, valuation.as_of, asOf,
    )?.total ?? 0) as Paise;

    if (Math.abs(moved) < DRIFT_THRESHOLD) continue;
    out.push({
      accountId: account.id, accountName: account.name, kind: "stated-valuation",
      gap: moved, since: valuation.as_of as IsoDate,
      explanation:
        `${formatPaise(Math.abs(moved) as Paise)} ${moved > 0 ? "went into" : "came out of"} ` +
        `this account after the valuation dated ${valuation.as_of}, and the stated figure is what ` +
        `net worth shows. If that valuation already accounts for it, nothing is wrong; if not, ` +
        `the figure is out by that much.`,
      fixHref: `/portfolio/asset/${account.id}/revalue`,
    });
  }

  // 2 · Cash sitting in an investment account, invested in nothing.
  const investment = queryAll<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM accounts
      WHERE ${visible(`kind = 'tracking' AND closed_at IS NULL AND subtype = 'investment'`)}
      ORDER BY name`,
    ...params,
  );
  for (const account of investment) {
    const balance = ledgerBalance(db, account.id);
    if (Math.abs(balance) < DRIFT_THRESHOLD) continue;
    out.push({
      accountId: account.id, accountName: account.name, kind: "uninvested",
      gap: balance, since: null,
      explanation:
        `${formatPaise(Math.abs(balance) as Paise)} is recorded against this account but is not ` +
        `in any holding. Net worth counts the holdings, so this is counted nowhere — either it is ` +
        `waiting to be invested, or a purchase was recorded without the cash that paid for it.`,
      fixHref: `/accounts/${account.id}`,
    });
  }

  // 3 · A loan whose ledger and schedule disagree.
  for (const loan of listLoans(db)) {
    const account = queryOne<{ name: string; visibility: string | null; holder_member_id: string | null }>(
      db, `SELECT name, visibility, holder_member_id FROM accounts WHERE id = ?`, loan.account_id,
    );
    if (!account) continue;
    if (
      opts.viewerMemberId !== undefined &&
      account.visibility && account.visibility !== "household" &&
      account.holder_member_id !== (opts.viewerMemberId ?? null)
    ) continue;

    const projection = projectLoan(db, loan.id);
    if (!projection) continue;

    // The ledger's view of the debt is negative; the projection's is positive.
    const owedByLedger = Math.max(0, -ledgerBalance(db, loan.account_id)) as Paise;
    const gap = (owedByLedger - projection.outstanding) as Paise;
    if (Math.abs(gap) < DRIFT_THRESHOLD) continue;

    out.push({
      accountId: loan.account_id,
      accountName: loan.nickname || loan.lender,
      kind: "loan",
      gap, since: null,
      explanation:
        `The ledger says ${formatPaise(owedByLedger)} is owed; the schedule says ` +
        `${formatPaise(projection.outstanding)}. Net worth uses the schedule. A payment entered ` +
        `straight onto the account is not a loan payment, so it does not move the balance owed — ` +
        `record it against the loan instead.`,
      fixHref: `/loans/${loan.id}`,
    });
  }

  return out;
}
