/**
 * F4 · Transactions, splits and transfers · F5 · Payees.
 *
 * The invariant that matters most here is P4/N4: the original imported record
 * is never overwritten. `raw_*` columns are written once and never touched
 * again, so a cleaned payee can always be traced back to the string the bank
 * actually sent.
 */

import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, registerUndoHandler, type Actor } from "../core/events.ts";
import { nowIST, todayIST, formatDate, addDays, type IsoDate } from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import { getAccount } from "./accounts.ts";

export type TransactionSource = "manual" | "csv" | "pdf" | "email" | "sms" | "api" | "schedule";

export interface Transaction {
  id: string;
  account_id: string;
  card_id: string | null;
  date: IsoDate;
  amount: Paise;
  payee_id: string | null;
  category_id: string | null;
  is_split: number;
  memo: string | null;
  cleared: number;
  owner_member_id: string | null;
  transfer_pair_id: string | null;
  reimbursable: number;
  source: TransactionSource;
  import_batch_id: string | null;
  source_id: string | null;
  raw_payee: string | null;
  raw_amount: string | null;
  raw_date: string | null;
  raw_narration: string | null;
  auto_approved_at: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  deleted_at: string | null;
}

export interface SplitInput {
  categoryId: string | null;
  amount: Paise;
  memo?: string | null;
}

export interface CreateTransactionInput {
  accountId: string;
  /** Signed paise relative to the account. Negative means money left it. */
  amount: Paise;
  date?: IsoDate;
  payeeId?: string | null;
  payeeName?: string | null;
  categoryId?: string | null;
  splits?: SplitInput[];
  memo?: string | null;
  tags?: string[];
  /** R6.c: which card this was made on. Defaults to the account's primary. */
  cardId?: string | null;
  /** H2: who spent it. Defaults to the entering member, or the card's holder. */
  ownerMemberId?: string | null;
  cleared?: boolean;
  reimbursable?: boolean;
  source?: TransactionSource;
  sourceId?: string | null;
  importBatchId?: string | null;
  raw?: { payee?: string; amount?: string; date?: string; narration?: string };
}

export function createTransaction(
  db: DB,
  actor: Actor,
  input: CreateTransactionInput,
): Transaction {
  return transact(db, () => {
    const account = getAccount(db, input.accountId);
    if (!account) throw new Error("That account does not exist.");

    // F4.3: splits must sum to the total, or the ledger stops adding up.
    if (input.splits && input.splits.length > 0) {
      const total = input.splits.reduce((sum, s) => sum + s.amount, 0);
      if (total !== input.amount) {
        throw new Error(
          `The splits add up to ${formatPaise(total)}, but the transaction is ${formatPaise(input.amount)}.`,
        );
      }
    }

    const payeeId = input.payeeId ?? (input.payeeName ? resolvePayee(db, actor, input.payeeName, input.raw?.payee).id : null);
    const cardId = input.cardId ?? defaultCardFor(db, account.kind, input.accountId);
    const ownerMemberId =
      input.ownerMemberId ?? cardHolderOf(db, cardId) ?? actor.memberId ?? null;

    const id = newId();
    const isSplit = (input.splits?.length ?? 0) > 0;
    const now = nowIST();

    execute(
      db,
      `INSERT INTO transactions
         (id,account_id,card_id,date,amount,payee_id,category_id,is_split,memo,cleared,
          owner_member_id,reimbursable,source,import_batch_id,source_id,
          raw_payee,raw_amount,raw_date,raw_narration,created_at,created_by,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.accountId,
      cardId,
      input.date ?? todayIST(),
      input.amount,
      payeeId,
      isSplit ? null : (input.categoryId ?? null),
      isSplit ? 1 : 0,
      input.memo ?? null,
      input.cleared ? 1 : 0,
      ownerMemberId,
      input.reimbursable ? 1 : 0,
      input.source ?? "manual",
      input.importBatchId ?? null,
      input.sourceId ?? null,
      input.raw?.payee ?? null,
      input.raw?.amount ?? null,
      input.raw?.date ?? null,
      input.raw?.narration ?? null,
      now,
      actor.memberId,
      now,
    );

    if (isSplit) {
      input.splits!.forEach((s, i) => {
        execute(
          db,
          `INSERT INTO transaction_splits (id,transaction_id,category_id,amount,memo,sort)
           VALUES (?,?,?,?,?,?)`,
          newId(), id, s.categoryId, s.amount, s.memo ?? null, i,
        );
      });
    }

    if (input.tags?.length) setTags(db, id, input.tags);

    const created = getTransaction(db, id)!;
    appendEvent(db, actor, {
      entity: "transaction",
      entityId: id,
      action: "create",
      after: created,
      summary: `${input.amount < 0 ? "Spent" : "Received"} ${formatPaise(Math.abs(input.amount))} on ${formatDate(created.date)}`,
    });
    return created;
  });
}

function defaultCardFor(db: DB, kind: string, accountId: string): string | null {
  if (kind !== "credit") return null;
  return (
    queryOne<{ id: string }>(
      db,
      `SELECT id FROM cards WHERE account_id = ? AND is_primary = 1 AND closed_at IS NULL`,
      accountId,
    )?.id ?? null
  );
}

function cardHolderOf(db: DB, cardId: string | null): string | null {
  if (!cardId) return null;
  return (
    queryOne<{ holder_member_id: string | null }>(
      db, `SELECT holder_member_id FROM cards WHERE id = ?`, cardId,
    )?.holder_member_id ?? null
  );
}

export function getTransaction(db: DB, id: string): Transaction | null {
  return queryOne<Transaction>(db, `SELECT * FROM transactions WHERE id = ?`, id);
}

export function getSplits(db: DB, transactionId: string) {
  return queryAll<{ id: string; category_id: string | null; amount: Paise; memo: string | null }>(
    db,
    `SELECT id, category_id, amount, memo FROM transaction_splits WHERE transaction_id = ? ORDER BY sort`,
    transactionId,
  );
}

export interface UpdateTransactionInput {
  date?: IsoDate;
  amount?: Paise;
  payeeId?: string | null;
  categoryId?: string | null;
  splits?: SplitInput[] | null;
  memo?: string | null;
  cleared?: boolean;
  ownerMemberId?: string | null;
  cardId?: string | null;
  reimbursable?: boolean;
  tags?: string[];
}

export function updateTransaction(
  db: DB, actor: Actor, id: string, patch: UpdateTransactionInput,
): Transaction {
  return transact(db, () => {
    const before = getTransaction(db, id);
    if (!before) throw new Error("That transaction does not exist.");

    if (patch.splits) {
      const amount = patch.amount ?? before.amount;
      const total = patch.splits.reduce((sum, s) => sum + s.amount, 0);
      if (total !== amount) {
        throw new Error(
          `The splits add up to ${formatPaise(total)}, but the transaction is ${formatPaise(amount)}.`,
        );
      }
    }

    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const set = (col: string, value: string | number | null) => {
      sets.push(`${col} = ?`);
      params.push(value);
    };

    if (patch.date !== undefined) set("date", patch.date);
    if (patch.amount !== undefined) set("amount", patch.amount);
    if (patch.payeeId !== undefined) set("payee_id", patch.payeeId);
    if (patch.memo !== undefined) set("memo", patch.memo);
    if (patch.cleared !== undefined) set("cleared", patch.cleared ? 1 : 0);
    if (patch.ownerMemberId !== undefined) set("owner_member_id", patch.ownerMemberId);
    if (patch.cardId !== undefined) set("card_id", patch.cardId);
    if (patch.reimbursable !== undefined) set("reimbursable", patch.reimbursable ? 1 : 0);

    if (patch.splits !== undefined) {
      execute(db, `DELETE FROM transaction_splits WHERE transaction_id = ?`, id);
      if (patch.splits && patch.splits.length > 0) {
        set("is_split", 1);
        set("category_id", null);
        patch.splits.forEach((s, i) => {
          execute(
            db,
            `INSERT INTO transaction_splits (id,transaction_id,category_id,amount,memo,sort) VALUES (?,?,?,?,?,?)`,
            newId(), id, s.categoryId, s.amount, s.memo ?? null, i,
          );
        });
      } else {
        set("is_split", 0);
      }
    }
    if (patch.categoryId !== undefined && !patch.splits?.length) {
      set("category_id", patch.categoryId);
      if (before.is_split) {
        set("is_split", 0);
        execute(db, `DELETE FROM transaction_splits WHERE transaction_id = ?`, id);
      }
    }

    set("updated_at", nowIST());
    execute(db, `UPDATE transactions SET ${sets.join(", ")} WHERE id = ?`, ...params, id);

    if (patch.tags !== undefined) setTags(db, id, patch.tags);

    const after = getTransaction(db, id)!;
    appendEvent(db, actor, {
      entity: "transaction", entityId: id, action: "update", before, after,
      summary: describeChange(before, after),
    });
    return after;
  });
}

function describeChange(before: Transaction, after: Transaction): string {
  const parts: string[] = [];
  if (before.amount !== after.amount) {
    parts.push(`amount ${formatPaise(before.amount)} → ${formatPaise(after.amount)}`);
  }
  if (before.date !== after.date) parts.push(`date ${formatDate(before.date)} → ${formatDate(after.date)}`);
  if (before.category_id !== after.category_id) parts.push("category changed");
  if (before.cleared !== after.cleared) parts.push(after.cleared ? "marked cleared" : "marked uncleared");
  return parts.length ? `Edited: ${parts.join(", ")}` : "Edited transaction";
}

/** F4.8: soft for 30 days with restore, then hard. */
export function deleteTransaction(db: DB, actor: Actor, id: string): void {
  transact(db, () => {
    const before = getTransaction(db, id);
    if (!before) throw new Error("That transaction does not exist.");

    const ids = before.transfer_pair_id
      ? queryAll<{ id: string }>(
          db, `SELECT id FROM transactions WHERE transfer_pair_id = ?`, before.transfer_pair_id,
        ).map((r) => r.id)
      : [id];

    for (const target of ids) {
      execute(db, `UPDATE transactions SET deleted_at = ? WHERE id = ?`, nowIST(), target);
    }

    appendEvent(db, actor, {
      entity: "transaction", entityId: id, action: "delete", before,
      summary: `Deleted ${formatPaise(Math.abs(before.amount))} on ${formatDate(before.date)}`,
    });
  });
}

export function restoreTransaction(db: DB, actor: Actor, id: string): void {
  transact(db, () => {
    const before = getTransaction(db, id);
    if (!before) throw new Error("That transaction does not exist.");
    execute(db, `UPDATE transactions SET deleted_at = NULL WHERE id = ?`, id);
    if (before.transfer_pair_id) {
      execute(
        db, `UPDATE transactions SET deleted_at = NULL WHERE transfer_pair_id = ?`,
        before.transfer_pair_id,
      );
    }
    appendEvent(db, actor, {
      entity: "transaction", entityId: id, action: "restore", before,
      after: getTransaction(db, id),
      summary: `Restored the deleted transaction`,
    });
  });
}

/** Hard-delete anything soft-deleted longer than the window (F4.8). */
export function purgeDeleted(db: DB, olderThanDays = 30, today = todayIST()): number {
  const cutoff = addDays(today, -olderThanDays);
  return execute(db, `DELETE FROM transactions WHERE deleted_at IS NOT NULL AND deleted_at < ?`, cutoff);
}

// ---------------------------------------------------------------------------
// Transfers — F4.4, and card payments under R6
// ---------------------------------------------------------------------------

export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  /** A positive amount: what leaves the source account. */
  amount: Paise;
  date?: IsoDate;
  memo?: string | null;
  cleared?: boolean;
}

/**
 * Create both legs of a transfer (F4.4).
 *
 * A transfer to a Credit account is a card payment: it reduces that card's
 * payment category and touches no spending category (R6). That falls out of
 * the engine's derivation rather than needing a special case here — see
 * `docs/dev/01-engine-derivation.md` §5.
 */
export function createTransfer(db: DB, actor: Actor, input: TransferInput): [Transaction, Transaction] {
  if (input.amount <= 0) throw new Error("Enter an amount greater than zero to transfer.");
  if (input.fromAccountId === input.toAccountId) throw new Error("Pick two different accounts.");

  return transact(db, () => {
    const from = getAccount(db, input.fromAccountId);
    const to = getAccount(db, input.toAccountId);
    if (!from || !to) throw new Error("That account does not exist.");

    const pairId = newId();
    const date = input.date ?? todayIST();
    const isCardPayment = to.kind === "credit";
    const memo = input.memo ?? (isCardPayment ? `Card payment — ${to.name}` : `Transfer to ${to.name}`);

    const out = createTransaction(db, actor, {
      accountId: input.fromAccountId,
      amount: -input.amount,
      date, memo, cleared: input.cleared,
    });
    const back = createTransaction(db, actor, {
      accountId: input.toAccountId,
      amount: input.amount,
      date,
      memo: isCardPayment ? `Card payment from ${from.name}` : `Transfer from ${from.name}`,
      cleared: input.cleared,
    });

    execute(db, `UPDATE transactions SET transfer_pair_id = ? WHERE id IN (?, ?)`, pairId, out.id, back.id);

    appendEvent(db, actor, {
      entity: "transfer", entityId: pairId, action: "create",
      after: { from: from.name, to: to.name, amount: input.amount, date },
      summary: isCardPayment
        ? `Paid ${formatPaise(input.amount)} to ${to.name} from ${from.name}`
        : `Moved ${formatPaise(input.amount)} from ${from.name} to ${to.name}`,
    });

    return [getTransaction(db, out.id)!, getTransaction(db, back.id)!];
  });
}

// ---------------------------------------------------------------------------
// Payees — F5
// ---------------------------------------------------------------------------

export interface Payee {
  id: string;
  name: string;
  default_category_id: string | null;
  default_account_id: string | null;
  merged_into_id: string | null;
}

/**
 * Find or create a payee by clean name, recording the raw string it came from
 * (F5.1, P4). Every raw string ever mapped is retained forever.
 */
export function resolvePayee(db: DB, actor: Actor, name: string, raw?: string | null): Payee {
  const clean = name.trim();
  if (!clean) throw new Error("A payee needs a name.");

  return transact(db, () => {
    if (raw) {
      const viaAlias = queryOne<Payee>(
        db,
        `SELECT p.* FROM payee_aliases a JOIN payees p ON p.id = a.payee_id WHERE a.raw = ?`,
        raw,
      );
      if (viaAlias) return followMerge(db, viaAlias);
    }

    let payee = queryOne<Payee>(db, `SELECT * FROM payees WHERE name = ? COLLATE NOCASE`, clean);
    if (!payee) {
      const id = newId();
      execute(db, `INSERT INTO payees (id,name,created_at) VALUES (?,?,?)`, id, clean, nowIST());
      payee = queryOne<Payee>(db, `SELECT * FROM payees WHERE id = ?`, id)!;
      appendEvent(db, actor, {
        entity: "payee", entityId: id, action: "create", after: payee,
        summary: `Added the payee "${clean}"`,
      });
    }

    if (raw) addAlias(db, payee.id, raw);
    return followMerge(db, payee);
  });
}

function followMerge(db: DB, payee: Payee): Payee {
  let current = payee;
  for (let i = 0; i < 10 && current.merged_into_id; i++) {
    const next = queryOne<Payee>(db, `SELECT * FROM payees WHERE id = ?`, current.merged_into_id);
    if (!next) break;
    current = next;
  }
  return current;
}

function addAlias(db: DB, payeeId: string, raw: string): void {
  const existing = queryOne<{ id: string }>(db, `SELECT id FROM payee_aliases WHERE raw = ?`, raw);
  if (existing) return;
  execute(
    db, `INSERT INTO payee_aliases (id,payee_id,raw,created_at) VALUES (?,?,?,?)`,
    newId(), payeeId, raw, nowIST(),
  );
}

export function listPayees(db: DB): Payee[] {
  return queryAll<Payee>(db, `SELECT * FROM payees WHERE merged_into_id IS NULL ORDER BY name`);
}

export function getPayee(db: DB, id: string): Payee | null {
  return queryOne<Payee>(db, `SELECT * FROM payees WHERE id = ?`, id);
}

/** F5.2: merging preserves all history and mappings. */
export function mergePayees(db: DB, actor: Actor, loserId: string, winnerId: string): void {
  if (loserId === winnerId) throw new Error("Pick two different payees.");
  transact(db, () => {
    const loser = getPayee(db, loserId);
    const winner = getPayee(db, winnerId);
    if (!loser || !winner) throw new Error("That payee does not exist.");

    execute(db, `UPDATE transactions SET payee_id = ? WHERE payee_id = ?`, winnerId, loserId);
    execute(db, `UPDATE payee_aliases SET payee_id = ? WHERE payee_id = ?`, winnerId, loserId);
    // Kept rather than deleted, so the old name still resolves.
    execute(db, `UPDATE payees SET merged_into_id = ? WHERE id = ?`, winnerId, loserId);

    appendEvent(db, actor, {
      entity: "payee", entityId: loserId, action: "merge", before: loser,
      after: winner,
      summary: `Merged "${loser.name}" into "${winner.name}"`,
    });
  });
}

export interface PayeeStats {
  count: number;
  total: Paise;
  average: Paise;
  firstSeen: IsoDate | null;
  lastSeen: IsoDate | null;
  lastAmount: Paise | null;
  usualCategoryId: string | null;
}

/** F5.3, F5.4: what the entry sheet shows when a payee is chosen. */
export function payeeStats(db: DB, payeeId: string): PayeeStats {
  const agg = queryOne<{
    count: number; total: number; first_seen: string | null; last_seen: string | null;
  }>(
    db,
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS total,
            MIN(date) AS first_seen, MAX(date) AS last_seen
       FROM transactions WHERE payee_id = ? AND deleted_at IS NULL`,
    payeeId,
  );

  const last = queryOne<{ amount: number }>(
    db,
    `SELECT amount FROM transactions WHERE payee_id = ? AND deleted_at IS NULL
      ORDER BY date DESC, created_at DESC LIMIT 1`,
    payeeId,
  );

  const usual = queryOne<{ category_id: string }>(
    db,
    `SELECT category_id FROM transactions
      WHERE payee_id = ? AND deleted_at IS NULL AND category_id IS NOT NULL
      GROUP BY category_id ORDER BY COUNT(*) DESC LIMIT 1`,
    payeeId,
  );

  const count = agg?.count ?? 0;
  const total = agg?.total ?? 0;
  return {
    count,
    total,
    average: count > 0 ? Math.round(total / count) : 0,
    firstSeen: agg?.first_seen ?? null,
    lastSeen: agg?.last_seen ?? null,
    lastAmount: last?.amount ?? null,
    usualCategoryId: usual?.category_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tags — F12
// ---------------------------------------------------------------------------

export function setTags(db: DB, transactionId: string, names: string[]): void {
  execute(db, `DELETE FROM transaction_tags WHERE transaction_id = ?`, transactionId);
  for (const raw of names) {
    const name = raw.trim().replace(/^#/, "");
    if (!name) continue;
    let tag = queryOne<{ id: string }>(db, `SELECT id FROM tags WHERE name = ? COLLATE NOCASE`, name);
    if (!tag) {
      const id = newId();
      execute(db, `INSERT INTO tags (id,name,created_at) VALUES (?,?,?)`, id, name, nowIST());
      tag = { id };
    }
    execute(
      db,
      `INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?,?)`,
      transactionId, tag.id,
    );
  }
}

export function tagsFor(db: DB, transactionId: string): string[] {
  return queryAll<{ name: string }>(
    db,
    `SELECT t.name FROM transaction_tags tt JOIN tags t ON t.id = tt.tag_id
      WHERE tt.transaction_id = ? ORDER BY t.name`,
    transactionId,
  ).map((r) => r.name);
}

// ---------------------------------------------------------------------------

/**
 * B65 · Rows elsewhere that point at a transaction and must not be orphaned.
 *
 * Splits and tags belong to the transaction and cascade with it. These do not:
 * each records that the transaction is load-bearing for something derived — an
 * instalment against a loan, a lot in the portfolio, a reconciliation's
 * adjustment. Deleting the transaction under them would leave that derived
 * figure quietly wrong, so undo refuses and says which one is holding it.
 */
const TRANSACTION_DEPENDANTS: { table: string; column: string; describe: string }[] = [
  { table: "loan_payments", column: "transaction_id", describe: "a loan instalment" },
  { table: "lots", column: "transaction_id", describe: "a portfolio lot" },
  { table: "holding_events", column: "transaction_id", describe: "a portfolio transaction" },
  { table: "reconciliations", column: "adjustment_transaction_id", describe: "a reconciliation adjustment" },
  { table: "family_loans", column: "write_off_transaction_id", describe: "a family-loan write-off" },
];

/** Thrown when an undo is refused for a reason the household can act on. */
export class UndoRefused extends Error {}

registerUndoHandler("transaction", (db, event) => {
  const before = event.before as Transaction | undefined;
  if (!before) {
    const id = event.entityId!;

    for (const dep of TRANSACTION_DEPENDANTS) {
      const n = queryOne<{ n: number }>(
        db, `SELECT COUNT(*) AS n FROM ${dep.table} WHERE ${dep.column} = ?`, id,
      )?.n ?? 0;
      if (n > 0) {
        throw new UndoRefused(
          `That transaction is recorded as ${dep.describe}, so removing it would ` +
          `leave that wrong. Undo or delete ${dep.describe} first.`,
        );
      }
    }

    // An imported row that was approved into this transaction goes back to
    // waiting in the review queue: the ledger entry is gone, so the import is
    // unresolved again rather than approved-into-nothing.
    execute(
      db,
      `UPDATE staged_transactions
          SET status = 'pending', transaction_id = NULL, resolved_at = NULL, resolved_by = NULL
        WHERE transaction_id = ?`,
      id,
    );
    // A later import may have been flagged as a duplicate *of* this one.
    execute(db, `UPDATE staged_transactions SET duplicate_of_id = NULL WHERE duplicate_of_id = ?`, id);

    execute(db, `DELETE FROM transaction_splits WHERE transaction_id = ?`, id);
    execute(db, `DELETE FROM transaction_tags WHERE transaction_id = ?`, id);
    execute(db, `DELETE FROM transactions WHERE id = ?`, id);
    return `Removed the transaction that was added`;
  }
  execute(
    db,
    `UPDATE transactions SET account_id=?, card_id=?, date=?, amount=?, payee_id=?, category_id=?,
            is_split=?, memo=?, cleared=?, owner_member_id=?, reimbursable=?, deleted_at=?, updated_at=?
      WHERE id = ?`,
    before.account_id, before.card_id, before.date, before.amount, before.payee_id,
    before.category_id, before.is_split, before.memo, before.cleared, before.owner_member_id,
    before.reimbursable, before.deleted_at, nowIST(), event.entityId!,
  );
  return `Restored the transaction of ${formatPaise(Math.abs(before.amount))}`;
});

registerUndoHandler("transfer", (db, event) => {
  execute(db, `UPDATE transactions SET deleted_at = ? WHERE transfer_pair_id = ?`, nowIST(), event.entityId!);
  return `Reversed the transfer`;
});

registerUndoHandler("payee", (db, event) => {
  const before = event.before as Payee | undefined;
  if (event.action === "merge" && before) {
    execute(db, `UPDATE payees SET merged_into_id = NULL WHERE id = ?`, before.id);
    return `Un-merged "${before.name}"`;
  }
  execute(db, `DELETE FROM payees WHERE id = ?`, event.entityId!);
  return `Removed the payee that was added`;
});
