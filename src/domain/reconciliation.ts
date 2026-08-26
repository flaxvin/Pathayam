/**
 * F9 · Reconciliation, and the Q5 collision resolved in `09` §5.
 *
 * A reconciliation asserts: *this account's cleared balance in the app equalled
 * the bank's stated balance on this date.* That assertion is the only thing
 * worth protecting, and R7.f is emphatic that the app must never quietly
 * repair it.
 *
 * ## The Q5 tension
 *
 * Q5 chose "any past month, always editable". F9.3 says a reconciliation
 * creates a locked checkpoint. `09` §5 resolves it by allowing the edit but
 * never quietly: explicit confirmation naming the checkpoint (R7.b), the
 * checkpoint marked **broken** (R7.c), a Review item until resolved (R7.d),
 * and both values in the event log (R7.e).
 *
 * ## One deliberate narrowing
 *
 * `09` §5 opens with "an assignment changed in a reconciled month makes the
 * checkpoint's assertion false". It does not. A reconciliation asserts an
 * *account* balance; an assignment moves money between envelopes and leaves
 * every account balance untouched. Only a transaction on the reconciled
 * account, dated on or before the checkpoint, can falsify it.
 *
 * So assignments do not break checkpoints here. Breaking one on every
 * past-month assignment edit would fire constantly without anything being
 * wrong, and a warning that cries wolf is a warning nobody reads — which is
 * the precise failure R38.3 is written to avoid elsewhere. The flexibility Q5
 * asked for is preserved either way; what is protected is the one property
 * that makes reconciling worth doing.
 */

import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, registerUndoHandler, type Actor } from "../core/events.ts";
import { nowIST, todayIST, formatDate, daysBetween, type IsoDate } from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import { getAccount } from "./accounts.ts";
import { createTransaction, getTransaction } from "./transactions.ts";

export interface Checkpoint {
  id: string;
  account_id: string;
  as_of: IsoDate;
  bank_balance: Paise;
  app_balance: Paise;
  adjustment_transaction_id: string | null;
  created_at: string;
  created_by: string | null;
  broken_at: string | null;
  broken_reason: string | null;
}

/** F9.1: the bank's balance against the app's cleared balance, on a date. */
export interface ReconciliationPreview {
  accountId: string;
  asOf: IsoDate;
  bankBalance: Paise;
  clearedBalance: Paise;
  /** bank − app. Zero means it balances. */
  difference: Paise;
  balances: boolean;
  /** F9.2: the uncleared items that could account for the difference. */
  uncleared: {
    id: string; date: IsoDate; amount: Paise; payee: string | null; memo: string | null;
  }[];
}

/**
 * The app's **cleared** balance as of a date. Uncleared items are excluded by
 * definition — they have not reached the bank, so they cannot be part of what
 * the bank is asserting.
 */
export function clearedBalanceAsOf(db: DB, accountId: string, asOf: IsoDate): Paise {
  const account = getAccount(db, accountId);
  if (!account) throw new Error("That account does not exist.");

  const opening = account.opening_date <= asOf ? account.opening_balance : 0;
  const sum =
    queryOne<{ total: number }>(
      db,
      `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
        WHERE account_id = ? AND deleted_at IS NULL AND cleared = 1 AND date <= ?`,
      accountId, asOf,
    )?.total ?? 0;

  return opening + sum;
}

export function previewReconciliation(
  db: DB, accountId: string, bankBalance: Paise, asOf: IsoDate,
): ReconciliationPreview {
  const clearedBalance = clearedBalanceAsOf(db, accountId, asOf);
  return {
    accountId,
    asOf,
    bankBalance,
    clearedBalance,
    difference: bankBalance - clearedBalance,
    balances: bankBalance === clearedBalance,
    uncleared: queryAll<{
      id: string; date: string; amount: number; payee: string | null; memo: string | null;
    }>(
      db,
      `SELECT t.id, t.date, t.amount, p.name AS payee, t.memo
         FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
        WHERE t.account_id = ? AND t.deleted_at IS NULL AND t.cleared = 0 AND t.date <= ?
        ORDER BY t.date DESC`,
      accountId, asOf,
    ),
  };
}

export interface ReconcileInput {
  accountId: string;
  bankBalance: Paise;
  asOf: IsoDate;
  /** F9.2: items the user ticked as having cleared. */
  clearTransactionIds?: string[];
  /** F9.2: where a balancing adjustment should be categorised, if one is needed. */
  adjustmentCategoryId?: string | null;
  /** Set once the user has accepted an adjustment they were shown. */
  allowAdjustment?: boolean;
}

export type ReconcileResult =
  | { status: "reconciled"; checkpoint: Checkpoint; adjustment: Paise }
  | { status: "needs-decision"; preview: ReconciliationPreview };

/**
 * F9.1–F9.3 · Complete a reconciliation.
 *
 * Refuses to invent an adjustment the user has not seen: a mismatch comes back
 * as `needs-decision` with the uncleared list, and only a second call carrying
 * `allowAdjustment` will write a balancing entry.
 */
export function reconcile(db: DB, actor: Actor, input: ReconcileInput): ReconcileResult {
  return transact(db, () => {
    const account = getAccount(db, input.accountId);
    if (!account) throw new Error("That account does not exist.");

    for (const id of input.clearTransactionIds ?? []) {
      const t = getTransaction(db, id);
      if (!t || t.account_id !== input.accountId) continue;
      execute(db, `UPDATE transactions SET cleared = 1, updated_at = ? WHERE id = ?`, nowIST(), id);
      appendEvent(db, actor, {
        entity: "transaction", entityId: id, action: "clear",
        before: { cleared: 0 }, after: { cleared: 1 },
        summary: `Marked ${formatPaise(Math.abs(t.amount))} as cleared while reconciling`,
      });
    }

    const preview = previewReconciliation(db, input.accountId, input.bankBalance, input.asOf);

    if (!preview.balances && !input.allowAdjustment) {
      return { status: "needs-decision", preview };
    }

    let adjustmentId: string | null = null;
    const adjustment = preview.difference;

    if (adjustment !== 0) {
      // F9.2: a balancing entry, categorised so it is never invisible.
      const category = input.adjustmentCategoryId ?? ensureReconciliationCategory(db, actor);
      const entry = createTransaction(db, actor, {
        accountId: input.accountId,
        amount: adjustment,
        date: input.asOf,
        categoryId: category,
        memo: `Reconciliation adjustment on ${formatDate(input.asOf)}`,
        cleared: true,
      });
      adjustmentId = entry.id;
    }

    const id = newId();
    execute(
      db,
      `INSERT INTO reconciliations
         (id,account_id,as_of,bank_balance,app_balance,adjustment_transaction_id,created_at,created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      id, input.accountId, input.asOf, input.bankBalance,
      clearedBalanceAsOf(db, input.accountId, input.asOf),
      adjustmentId, nowIST(), actor.memberId,
    );

    const checkpoint = queryOne<Checkpoint>(db, `SELECT * FROM reconciliations WHERE id = ?`, id)!;

    appendEvent(db, actor, {
      entity: "reconciliation", entityId: id, action: "create", after: checkpoint,
      summary:
        `Reconciled ${account.name} to ${formatPaise(input.bankBalance)} as of ${formatDate(input.asOf)}` +
        (adjustment !== 0 ? ` with a ${formatPaise(adjustment)} adjustment` : ""),
    });

    return { status: "reconciled", checkpoint, adjustment };
  });
}

const RECONCILIATION_CATEGORY = "Reconciliation";

function ensureReconciliationCategory(db: DB, actor: Actor): string {
  const existing = queryOne<{ id: string }>(
    db, `SELECT id FROM categories WHERE name = ? AND deleted_at IS NULL`, RECONCILIATION_CATEGORY,
  );
  if (existing) return existing.id;

  let group = queryOne<{ id: string }>(
    db, `SELECT id FROM category_groups WHERE kind = 'internal' LIMIT 1`,
  );
  if (!group) {
    const groupId = newId();
    execute(
      db,
      `INSERT INTO category_groups (id,name,kind,sort,created_at) VALUES (?,?,'internal',99,?)`,
      groupId, "Internal", nowIST(),
    );
    group = { id: groupId };
  }

  const id = newId();
  execute(
    db,
    `INSERT INTO categories (id,group_id,name,sort,created_at) VALUES (?,?,?,0,?)`,
    id, group.id, RECONCILIATION_CATEGORY, nowIST(),
  );
  appendEvent(db, actor, {
    entity: "category", entityId: id, action: "create",
    summary: `Created the ${RECONCILIATION_CATEGORY} category for balancing adjustments`,
  });
  return id;
}

// ---------------------------------------------------------------------------
// R7.a–R7.f · Editing history that a checkpoint has already asserted
// ---------------------------------------------------------------------------

/**
 * The intact checkpoints an edit on this date would falsify (R7.b).
 *
 * Empty means the edit is ordinary and needs no confirmation. Non-empty means
 * the caller must name them to the user and get an explicit yes.
 */
export function checkpointsAffectedBy(db: DB, accountId: string, date: IsoDate): Checkpoint[] {
  return queryAll<Checkpoint>(
    db,
    `SELECT * FROM reconciliations
      WHERE account_id = ? AND as_of >= ? AND broken_at IS NULL
      ORDER BY as_of DESC`,
    accountId, date,
  );
}

export class CheckpointConfirmationRequired extends Error {
  readonly checkpoints: Checkpoint[];
  constructor(checkpoints: Checkpoint[], accountName: string) {
    const list = checkpoints
      .map((c) => `${formatDate(c.as_of)} (${formatPaise(c.bank_balance)})`)
      .join(", ");
    super(
      `${accountName} was reconciled on ${list}. Changing something dated on or before ` +
        `that will mean the balance you confirmed no longer holds. Continue?`,
    );
    this.name = "CheckpointConfirmationRequired";
    this.checkpoints = checkpoints;
  }
}

/**
 * R7.b · Guard an edit to reconciled history.
 *
 * Throws unless `confirmed`, so no caller can edit past a checkpoint by
 * accident. Nothing is refused outright — Q5 is explicit that there is no hard
 * freeze (R7.a).
 */
export function guardHistoricalEdit(
  db: DB, accountId: string, date: IsoDate, confirmed: boolean,
): Checkpoint[] {
  const affected = checkpointsAffectedBy(db, accountId, date);
  if (affected.length === 0) return [];
  if (!confirmed) {
    const account = getAccount(db, accountId);
    throw new CheckpointConfirmationRequired(affected, account?.name ?? "That account");
  }
  return affected;
}

/**
 * R7.c, R7.e · Mark checkpoints broken, recording what changed.
 *
 * R7.f: the app never recomputes or silently repairs. A broken checkpoint
 * stays broken until the account is reconciled again.
 */
export function breakCheckpoints(
  db: DB, actor: Actor, checkpoints: Checkpoint[], reason: string,
): void {
  if (checkpoints.length === 0) return;
  transact(db, () => {
    for (const checkpoint of checkpoints) {
      execute(
        db, `UPDATE reconciliations SET broken_at = ?, broken_reason = ? WHERE id = ?`,
        nowIST(), reason, checkpoint.id,
      );
      appendEvent(db, actor, {
        entity: "reconciliation", entityId: checkpoint.id, action: "break",
        // R7.e: both values, so the reconciliation can be reasoned about after.
        before: { asOf: checkpoint.as_of, bankBalance: checkpoint.bank_balance, broken: false },
        after: { broken: true, reason },
        summary:
          `The reconciliation of ${formatDate(checkpoint.as_of)} no longer holds — ${reason}`,
      });
    }
  });
}

/**
 * The whole guard in one call, for a route that has taken the confirmation.
 * Returns how many checkpoints were broken, so the caller can say so.
 */
export function editReconciledHistory(
  db: DB, actor: Actor,
  opts: { accountId: string; date: IsoDate; confirmed: boolean; reason: string },
): number {
  const affected = guardHistoricalEdit(db, opts.accountId, opts.date, opts.confirmed);
  breakCheckpoints(db, actor, affected, opts.reason);
  return affected.length;
}

// ---------------------------------------------------------------------------
// F9.4 · Status per account
// ---------------------------------------------------------------------------

export interface ReconciliationStatus {
  accountId: string;
  lastReconciled: IsoDate | null;
  daysSince: number | null;
  broken: boolean;
  brokenReason: string | null;
  /** F9.4: nudge monthly. */
  shouldNudge: boolean;
}

export function reconciliationStatus(
  db: DB, accountId: string, today = todayIST(),
): ReconciliationStatus {
  const latest = queryOne<Checkpoint>(
    db,
    `SELECT * FROM reconciliations WHERE account_id = ? ORDER BY as_of DESC, created_at DESC LIMIT 1`,
    accountId,
  );

  if (!latest) {
    return {
      accountId, lastReconciled: null, daysSince: null,
      broken: false, brokenReason: null, shouldNudge: true,
    };
  }

  const daysSince = daysBetween(latest.as_of, today);
  return {
    accountId,
    lastReconciled: latest.as_of,
    daysSince,
    broken: latest.broken_at !== null,
    brokenReason: latest.broken_reason,
    shouldNudge: latest.broken_at !== null || daysSince >= 30,
  };
}

export function listCheckpoints(db: DB, accountId: string, limit = 20): Checkpoint[] {
  return queryAll<Checkpoint>(
    db,
    `SELECT * FROM reconciliations WHERE account_id = ? ORDER BY as_of DESC LIMIT ?`,
    accountId, limit,
  );
}

/** R7.d: broken checkpoints appear in Review until resolved. */
export function brokenCheckpoints(db: DB): (Checkpoint & { account_name: string })[] {
  return queryAll<Checkpoint & { account_name: string }>(
    db,
    `SELECT r.*, a.name AS account_name
       FROM reconciliations r JOIN accounts a ON a.id = r.account_id
      WHERE r.broken_at IS NOT NULL ORDER BY r.as_of DESC`,
  );
}

registerUndoHandler("reconciliation", (db, event) => {
  // Undoing a reconciliation removes the checkpoint and its adjustment. The
  // event stays in the log; only the assertion is withdrawn.
  const checkpoint = queryOne<Checkpoint>(
    db, `SELECT * FROM reconciliations WHERE id = ?`, event.entityId!,
  );
  if (checkpoint?.adjustment_transaction_id) {
    execute(
      db, `UPDATE transactions SET deleted_at = ? WHERE id = ?`,
      nowIST(), checkpoint.adjustment_transaction_id,
    );
  }
  execute(db, `DELETE FROM reconciliations WHERE id = ?`, event.entityId!);
  return `Withdrew the reconciliation of ${checkpoint ? formatDate(checkpoint.as_of) : "that date"}`;
});
