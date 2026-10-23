/**
 * DEPOSITS · A deposit's terms, and what they make it worth.
 *
 * A fixed or recurring deposit, a PPF or an EPF was worth its register or a
 * figure somebody retyped from a passbook. Given its terms — principal or
 * instalment, rate, compounding, start, maturity, payout — it is worth what
 * the arithmetic in `deposits/accrual.ts` says on whatever day is asked about,
 * and net worth, allocation, FIRE and the valuations screen all read that.
 *
 * ## The figure, or a hand valuation
 *
 * The computed figure rests on what it was computed from: the terms (as last
 * saved), the start date and, for the kinds that read the register (PPF, EPF,
 * other), the latest contribution. The latest of those dates is the **basis
 * date**. A hand valuation dated on or after it is newer information and wins;
 * one dated before it is superseded. So a passbook figure typed in today beats
 * the arithmetic, and the next contribution — or saving the terms again —
 * hands the account back to the arithmetic. `assets.ts#standingValuation`
 * applies the rule; this module supplies the computed side.
 *
 * Terms belong to a plain tracking asset account (fixed deposit, recurring
 * deposit, other asset), because those are the accounts whose register can
 * hold contributions. Nothing here posts a transaction: a maturity is shown on
 * the calendar and the overview, and the money is recorded when it moves.
 */

import type { DB } from "../db/db.ts";
import { transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, registerUndoHandler, type Actor } from "../core/events.ts";
import { nowIST, todayIST, formatDate, type IsoDate } from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import { Missing, Refusal } from "../core/refusal.ts";
import { getAccount, hiddenAccountIds } from "./accounts.ts";
import {
  checkTerms, depositValueOn, maturity, READS_REGISTER, DEPOSIT_KIND_LABELS, COMPOUNDING_LABELS,
  type DepositTerms, type Contribution, type DepositKind, type Compounding, type Payout,
} from "../deposits/accrual.ts";

/** The account subtypes a deposit's terms can be attached to. */
export const DEPOSIT_SUBTYPES: ReadonlySet<string> = new Set(["fixed-deposit", "recurring-deposit", "asset"]);

export interface StoredTerms extends DepositTerms {
  accountId: string;
  /** The day the terms were last saved. */
  basisDate: IsoDate;
}

interface TermsRow {
  account_id: string; kind: string; principal: number; instalment: number | null; rate_bp: number;
  compounding: string; start_date: string; maturity_date: string | null; payout: string;
  basis_date: string; created_at: string; created_by: string | null; updated_at: string;
}

function hydrate(row: TermsRow): StoredTerms {
  return {
    accountId: row.account_id,
    kind: row.kind as DepositKind,
    principal: row.principal,
    instalment: row.instalment,
    rateBp: row.rate_bp,
    compounding: row.compounding as Compounding,
    startDate: row.start_date,
    maturityDate: row.maturity_date,
    payout: row.payout as Payout,
    basisDate: row.basis_date,
  };
}

function rowFor(db: DB, accountId: string): TermsRow | null {
  return queryOne<TermsRow>(db, `SELECT * FROM deposit_terms WHERE account_id = ?`, accountId);
}

export function getDepositTerms(db: DB, accountId: string): StoredTerms | null {
  const row = rowFor(db, accountId);
  return row ? hydrate(row) : null;
}

/** "₹1,00,000 at 7.00% compounded quarterly from 01-01-2026, maturing 01-01-2027". */
export function describeTerms(terms: DepositTerms): string {
  const what = terms.kind === "rd"
    ? `${formatPaise(terms.instalment ?? 0)} a month`
    : formatPaise(terms.principal);
  return `${what} at ${(terms.rateBp / 100).toFixed(2)}% ${COMPOUNDING_LABELS[terms.compounding]}` +
    ` from ${formatDate(terms.startDate)}` +
    (terms.maturityDate ? `, maturing ${formatDate(terms.maturityDate)}` : "") +
    (terms.payout === "periodic" ? ", interest paid out" : "");
}

export interface DepositTermsInput {
  kind: string;
  principal?: Paise | null;
  instalment?: Paise | null;
  rateBp: number;
  compounding?: string | null;
  startDate: string;
  maturityDate?: string | null;
  payout?: string | null;
}

/** Refuses an account that cannot carry terms. */
function refuseIneligible(account: { name: string; kind: string; subtype: string; closed_at: string | null }): void {
  if (account.kind !== "tracking" || !DEPOSIT_SUBTYPES.has(account.subtype)) {
    throw new Refusal(
      `${account.name} is not a deposit. Terms go on a tracking account that is a fixed deposit, ` +
      "a recurring deposit or an other asset.",
    );
  }
  if (account.closed_at) throw new Refusal(`${account.name} is closed. Reopen it to change its terms.`);
}

/** Set or replace an account's deposit terms. One event, undoable. */
export function setDepositTerms(
  db: DB, actor: Actor, accountId: string, input: DepositTermsInput, today = todayIST(),
): StoredTerms {
  const terms = checkTerms(input);
  return transact(db, () => {
    const account = getAccount(db, accountId);
    if (!account) throw new Missing("That account does not exist.");
    refuseIneligible(account);
    const before = rowFor(db, accountId);
    const now = nowIST();
    execute(
      db,
      `INSERT INTO deposit_terms
         (account_id,kind,principal,instalment,rate_bp,compounding,start_date,maturity_date,payout,
          basis_date,created_at,created_by,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(account_id) DO UPDATE SET
         kind = excluded.kind, principal = excluded.principal, instalment = excluded.instalment,
         rate_bp = excluded.rate_bp, compounding = excluded.compounding,
         start_date = excluded.start_date, maturity_date = excluded.maturity_date,
         payout = excluded.payout, basis_date = excluded.basis_date, updated_at = excluded.updated_at`,
      accountId, terms.kind, terms.principal, terms.instalment, terms.rateBp, terms.compounding,
      terms.startDate, terms.maturityDate, terms.payout, today, now, actor.memberId, now,
    );
    const after = rowFor(db, accountId)!;
    appendEvent(db, actor, {
      entity: "deposit-terms", entityId: accountId, action: "set",
      before: before ?? undefined,
      after,
      summary: `${before ? "Changed" : "Set"} the terms of ${account.name}: ${describeTerms(terms)}`,
    });
    return hydrate(after);
  });
}

/** Take an account's terms off; it goes back to its balance or its hand valuations. */
export function removeDepositTerms(db: DB, actor: Actor, accountId: string): void {
  transact(db, () => {
    const account = getAccount(db, accountId);
    if (!account) throw new Missing("That account does not exist.");
    const before = rowFor(db, accountId);
    if (!before) throw new Refusal(`${account.name} has no deposit terms to remove.`);
    execute(db, `DELETE FROM deposit_terms WHERE account_id = ?`, accountId);
    appendEvent(db, actor, {
      entity: "deposit-terms", entityId: accountId, action: "remove",
      before,
      summary: `Removed the terms of ${account.name}; it is worth its balance again`,
    });
  });
}

function restoreRow(db: DB, row: TermsRow): void {
  execute(db, `DELETE FROM deposit_terms WHERE account_id = ?`, row.account_id);
  execute(
    db,
    `INSERT INTO deposit_terms
       (account_id,kind,principal,instalment,rate_bp,compounding,start_date,maturity_date,payout,
        basis_date,created_at,created_by,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.account_id, row.kind, row.principal, row.instalment, row.rate_bp, row.compounding,
    row.start_date, row.maturity_date, row.payout, row.basis_date, row.created_at, row.created_by,
    row.updated_at,
  );
}

registerUndoHandler("deposit-terms", (db, event) => {
  const id = event.entityId!;
  const before = event.before as TermsRow | undefined;
  if (before) {
    if (!getAccount(db, id)) throw new Refusal("That account no longer exists.");
    restoreRow(db, before);
    return event.action === "remove" ? "Put the deposit terms back" : "Put back the terms as they were";
  }
  execute(db, `DELETE FROM deposit_terms WHERE account_id = ?`, id);
  return "Removed the deposit terms that were set";
}, ["set", "remove"]);

/** The register's movements a kind reads: every live transaction from the start date. */
export function contributionsFor(db: DB, accountId: string, from: IsoDate, through: IsoDate): Contribution[] {
  return queryAll<{ date: string; amount: number }>(
    db,
    `SELECT date, SUM(amount) AS amount FROM transactions
      WHERE account_id = ? AND deleted_at IS NULL AND date >= ? AND date <= ?
      GROUP BY date ORDER BY date`,
    accountId, from, through,
  ).map((r) => ({ date: r.date, amount: r.amount }));
}

export interface ComputedDeposit {
  terms: StoredTerms;
  value: Paise;
  /** A hand valuation dated on or after this wins over `value`. */
  basisDate: IsoDate;
  maturity: { date: IsoDate; amount: Paise } | null;
}

/** The account's value on `asOf` from its terms, or null if it has none. */
export function computedDepositValue(db: DB, accountId: string, asOf = todayIST()): ComputedDeposit | null {
  const terms = getDepositTerms(db, accountId);
  if (!terms) return null;
  const reads = READS_REGISTER.has(terms.kind);
  const horizon = terms.maturityDate && terms.maturityDate > asOf ? terms.maturityDate : asOf;
  const register = reads ? contributionsFor(db, accountId, terms.startDate, horizon) : [];
  const known = register.filter((c) => c.date <= asOf);

  let basisDate = terms.basisDate > terms.startDate ? terms.basisDate : terms.startDate;
  const lastPaid = known.at(-1)?.date;
  if (lastPaid && lastPaid > basisDate) basisDate = lastPaid;

  return {
    terms,
    value: depositValueOn(terms, asOf, known),
    basisDate,
    maturity: maturity(terms, known),
  };
}

export interface Maturing {
  accountId: string;
  name: string;
  date: IsoDate;
  amount: Paise;
  kind: DepositKind;
}

/**
 * Deposits maturing between `from` and `to`, both inclusive, that the viewer
 * may see. Open accounts only: a closed deposit has already been dealt with.
 */
export function listMaturities(
  db: DB, opts: { from: IsoDate; to: IsoDate; viewerMemberId?: string | null },
): Maturing[] {
  const hidden = opts.viewerMemberId === undefined
    ? new Set<string>()
    : hiddenAccountIds(db, opts.viewerMemberId ?? null);
  return queryAll<{ account_id: string; name: string; nickname: string | null }>(
    db,
    `SELECT d.account_id, a.name, a.nickname FROM deposit_terms d
       JOIN accounts a ON a.id = d.account_id
      WHERE a.closed_at IS NULL AND d.maturity_date IS NOT NULL
        AND d.maturity_date >= ? AND d.maturity_date <= ?
      ORDER BY d.maturity_date, a.name`,
    opts.from, opts.to,
  )
    .filter((r) => !hidden.has(r.account_id))
    .flatMap((r) => {
      const computed = computedDepositValue(db, r.account_id, opts.from);
      if (!computed?.maturity) return [];
      return [{
        accountId: r.account_id, name: r.nickname || r.name,
        date: computed.maturity.date, amount: computed.maturity.amount, kind: computed.terms.kind,
      }];
    });
}

export { DEPOSIT_KIND_LABELS };
