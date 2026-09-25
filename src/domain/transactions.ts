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
import { Missing, Refusal } from "../core/refusal.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import { getAccount, DERIVED_VALUE_SUBTYPES, MANAGED_SUBTYPES } from "./accounts.ts";
import { prepareClaim } from "./commitments.ts";

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

export class FiledIntoPaymentCategory extends Refusal {}

/**
 * R6 · A payment category's activity is *derived* from spending on its card —
 * never stored. A transaction stored against one is therefore invisible to
 * the envelope while still moving the account, and the accounting identity
 * breaks by exactly that amount. The pickers hide payment categories; this is
 * the rule itself, so no other door — review, rules, the API, a schedule's
 * split lines — can slip one through.
 */
export function refusePaymentCategories(db: DB, categoryIds: (string | null | undefined)[]): void {
  for (const id of categoryIds) {
    if (!id) continue;
    const paying = queryOne<{ name: string }>(
      db, `SELECT name FROM categories WHERE id = ? AND payment_account_id IS NOT NULL`, id,
    );
    if (paying) {
      throw new FiledIntoPaymentCategory(
        `"${paying.name}" is a card's payment envelope — it fills itself from spending ` +
          `on that card, so nothing can be filed to it directly. Pick another envelope.`,
      );
    }
  }
}

export function createTransaction(
  db: DB,
  actor: Actor,
  input: CreateTransactionInput,
): Transaction {
  return transact(db, () => {
    const account = getAccount(db, input.accountId);
    /*
       * A Refusal, not an Error. Somebody named an account that is not there —
       * a stale link, a typo, an API caller with an old id. As a plain Error it
       * was recorded as a server fault, and a fault in the last 24 hours used
       * to take the whole instance out of rotation.
       */
    if (!account) throw new Refusal("That account does not exist.");

    // F4.3: splits must sum to the total, or the ledger stops adding up.
    if (input.splits && input.splits.length > 0) {
      const total = input.splits.reduce((sum, s) => sum + s.amount, 0);
      if (total !== input.amount) {
        /*
         * A Refusal, not an Error. Somebody typed figures that do not
         * reconcile, which is a thing to tell them — as an Error it was a 500
         * reading "Something went wrong on the server", and the one piece of
         * information they needed (by how much, and which way) was in a message
         * nobody ever saw.
         */
        throw new Refusal(
          `The lines add up to ${formatPaise(total)}, but the transaction is ` +
          `${formatPaise(input.amount)}. They have to match.`,
        );
      }
    }

    /*
     * F4 · A transaction is money moving. Zero is not a movement: it changes
     * no balance, no envelope and no total, so it can only ever be a slip of
     * the keyboard or a statement line that is really a notice. Accepting it
     * left rows in the register that no figure on any screen accounts for.
     */
    if (input.amount === 0) {
      throw new Refusal("A transaction has to move some money. Enter an amount above zero.");
    }

    refusePaymentCategories(db, [
      input.categoryId, ...(input.splits ?? []).map((s) => s.categoryId),
    ]);

    /*
     * 15 §3A.4 / R6.l · A filing that crosses budgets raises a claim, so the
     * envelope that carries it has to exist before the transaction does — and the
     * two budgets have to be allowed to owe each other at all.
     *
     * Per line, not per transaction: one supermarket receipt can be half the
     * household's groceries and half somebody's own things (15 §4).
     */
    for (const line of input.splits?.length ? input.splits : [{ categoryId: input.categoryId }]) {
      claimFilingFor(db, actor, account, line.categoryId ?? null);
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

/**
 * What undoing an edit needs to put back.
 *
 * The event used to record the transaction row and nothing else. Split lines
 * live in their own table and an edit rewrites them, so undo restored the row
 * and left the lines as the edit had made them: a split ₹900 charge flattened
 * to one envelope and then "undone" came back as `is_split = 1` with no lines
 * at all, and the ₹900 was in no envelope anywhere. A transfer leg is the same
 * shape of problem — its amount and date are shared with its partner, so an
 * edit changes two rows and the undo has to know about both.
 */
export interface EditSnapshot extends Transaction {
  splits: { category_id: string | null; amount: Paise; memo: string | null }[];
  partner?: Transaction;
}

function editSnapshot(db: DB, id: string): EditSnapshot | null {
  const row = getTransaction(db, id);
  if (!row) return null;
  const splits = getSplits(db, id).map(({ category_id, amount, memo }) => ({ category_id, amount, memo }));
  const partner = row.transfer_pair_id
    ? queryOne<Transaction>(
      db, `SELECT * FROM transactions WHERE transfer_pair_id = ? AND id <> ?`, row.transfer_pair_id, id,
    ) ?? undefined
    : undefined;
  return { ...row, splits, ...(partner ? { partner } : {}) };
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
    const before = editSnapshot(db, id);
    if (!before) throw new Missing("That transaction does not exist.");

    /*
     * A transfer leg is half of one movement, not a transaction of its own.
     *
     * The edit screen offered the full form for one, and this function wrote
     * whatever it was given to that row alone. Raising the outgoing side of a
     * ₹1,000 transfer to ₹3,000 left the incoming side at ₹1,000: two thousand
     * rupees left one account and arrived nowhere, and the identity was out by
     * that much in every month from then on. Flipping one side's direction did
     * the same thing in the other sign.
     *
     * So the amount and the date belong to the pair and move together, the
     * direction cannot change (that would make it a different transfer), and a
     * leg is never filed to an envelope — the money did not leave the
     * household. Cleared, memo and tags stay per-leg: each bank statement
     * clears its own side.
     */
    const partner = before.partner;
    if (before.transfer_pair_id) {
      if ((patch.categoryId ?? null) !== null || (patch.splits && patch.splits.length > 0)) {
        throw new Refusal(
          "This is one side of a transfer, so it has no envelope — the money moved " +
          "between your own accounts rather than being spent.",
        );
      }
      if (patch.amount !== undefined && Math.sign(patch.amount) !== Math.sign(before.amount)) {
        throw new Refusal(
          "A transfer's direction is fixed by which account it left. To send it the " +
          "other way, delete it and record the transfer in that direction.",
        );
      }
      // Nothing to write to the envelope columns of a leg.
      patch = { ...patch, categoryId: undefined, splits: undefined };
    }

    if (patch.splits) {
      const amount = patch.amount ?? before.amount;
      const total = patch.splits.reduce((sum, s) => sum + s.amount, 0);
      if (total !== amount) {
        throw new Refusal(
          `The lines add up to ${formatPaise(total)}, but the transaction is ` +
          `${formatPaise(amount)}. They have to match.`,
        );
      }
    }

    // The same rule as creating: an edit cannot empty a transaction either.
    if (patch.amount === 0) {
      throw new Refusal("A transaction has to move some money. Enter an amount above zero.");
    }

    refusePaymentCategories(db, [
      patch.categoryId, ...(patch.splits ?? []).map((s) => s.categoryId),
    ]);

    // R6.l · Recategorising can cross budgets just as creating can.
    if (patch.categoryId !== undefined || patch.splits) {
      const account = getAccount(db, before.account_id);
      if (account) {
        const lines = patch.splits?.length
          ? patch.splits.map((sp) => sp.categoryId ?? null)
          : [patch.categoryId ?? null];
        for (const categoryId of lines) claimFilingFor(db, actor, account, categoryId);
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

    // The partner takes the same amount, opposite sign, and the same date.
    if (partner && (patch.amount !== undefined || patch.date !== undefined)) {
      execute(
        db,
        `UPDATE transactions SET amount = ?, date = ?, updated_at = ? WHERE id = ?`,
        patch.amount !== undefined ? -patch.amount : partner.amount,
        patch.date ?? partner.date,
        nowIST(), partner.id,
      );
    }

    if (patch.tags !== undefined) setTags(db, id, patch.tags);

    const after = editSnapshot(db, id)!;
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
    if (!before) throw new Missing("That transaction does not exist.");

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
    if (!before) throw new Missing("That transaction does not exist.");
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
  /**
   * Set only by the code that manages a derived account (family lending), for
   * which a transfer *is* how its value is recorded. See the guard in
   * createTransfer.
   */
  managedBy?: "family-loans";
  /** A positive amount: what arrives in the destination account. */
  amount: Paise;
  date?: IsoDate;
  memo?: string | null;
  cleared?: boolean;
  /**
   * What the bank took for moving it: an IMPS or NEFT charge, a demat transfer
   * fee, the markup on a currency conversion.
   *
   * Charged to the source account on top of `amount`, so ₹10,000 sent with a
   * ₹5 fee leaves ₹10,005 and delivers ₹10,000 — which is what the statement
   * will say. It needs a category because it is spending: money leaving the
   * budget accounts with no envelope against it would move Ready to Assign
   * instead, and the household would find its unassigned money quietly
   * shrinking with no line item to explain it.
   */
  fee?: { amount: Paise; categoryId: string } | null;
}

/**
 * Create both legs of a transfer (F4.4).
 *
 * A transfer to a Credit account is a card payment: it reduces that card's
 * payment category and touches no spending category (R6). That falls out of
 * the engine's derivation rather than needing a special case here — see
 * `docs/dev/01-engine-derivation.md` §5.
 */
export interface CategoryLine {
  categoryId: string | null;
  /** Null on the first line, which takes whatever the others leave. */
  amount: Paise | null;
}

export interface ResolvedLines {
  categoryId: string | null;
  splits: SplitInput[] | null;
}

/**
 * Category lines into either one category or a set of splits.
 *
 * There is no "main" category and never really was — a transaction has
 * envelopes, and usually one. Asking for a category *and* a split section
 * meant a box that silently meant nothing while the section was open, and a
 * long tail of bugs about what it should say, whether it was required, and
 * what happened to what you had typed in it.
 *
 * So: lines. The **first carries no amount** and takes whatever the others
 * leave. One line is an ordinary single-envelope transaction. Add a ₹900 line
 * to a ₹2,400 total and the first quietly becomes ₹1,500.
 *
 * That is also why the lines can no longer fail to add up. The remainder is
 * computed rather than typed, so the arithmetic that used to be the person's
 * problem — and the refusal when they got it wrong — stops existing. What can
 * still go wrong is claiming *more* than the transaction holds, and that is
 * refused with the figures.
 */
export function resolveCategoryLines(total: Paise, lines: CategoryLine[]): ResolvedLines {
  const first = lines[0] ?? { categoryId: null, amount: null };
  const rest = lines.slice(1).filter((l) => l.amount !== null && l.amount !== 0);

  if (rest.length === 0) return { categoryId: first.categoryId, splits: null };

  const claimed = rest.reduce((sum, l) => sum + (l.amount ?? 0), 0);
  const remainder = (total - claimed) as Paise;

  /*
   * The remainder has to be real money on the same side of zero as the
   * transaction. Claiming more than there is would otherwise make the first
   * line negative — money appearing in an envelope because two others took too
   * much — which is exactly the kind of quiet impossibility the identity exists
   * to prevent.
   *
   * The two ways to get here are different mistakes and take different
   * sentences. One message covered both and was wrong about one of them: told
   * that ₹6,000 of lines "leaves nothing" out of ₹5,000, the reader has to work
   * out for themselves that they are ₹1,000 over. And "give the later lines
   * less than the total" is no help at all to somebody whose actual intent was
   * to file the whole amount into one envelope — the fix there is to move it up
   * to the first line, which the old wording never mentioned.
   */
  if (remainder === 0) {
    throw new Refusal(
      `Those lines come to the whole ${formatPaise(Math.abs(total) as Paise)}, leaving ` +
      "nothing for the first one. " +
      (rest.length === 1
        ? "If all of it goes to one envelope, choose it on the first line and clear the amount below."
        : "Give them less than the total, or move one up to the first line and clear its amount."),
    );
  }
  if ((total < 0) !== (remainder < 0)) {
    throw new Refusal(
      `Those lines come to ${formatPaise(Math.abs(claimed) as Paise)}, which is ` +
      `${formatPaise(Math.abs(remainder) as Paise)} more than the ` +
      `${formatPaise(Math.abs(total) as Paise)} being filed. Give them less than the ` +
      "total — the first line takes whatever is left.",
    );
  }

  return {
    categoryId: null,
    splits: [
      { categoryId: first.categoryId, amount: remainder },
      ...rest.map((l) => ({ categoryId: l.categoryId, amount: l.amount as Paise })),
    ],
  };
}

/**
 * B99, checked against the lines rather than only the single-envelope case.
 *
 * `hasSplits` was treated as satisfying the rule on its own: an entry that is
 * split obviously names its envelopes, since the lines carry them. That stopped
 * being true when the first line became one that may legitimately be blank —
 * blank means Ready to Assign, which is right for income and is uncategorised
 * spending for anything else. A ₹5,000 expense with ₹1,000 named and the first
 * line left empty was accepted, and filed ₹4,000 against no envelope at all:
 * precisely the queue of unrecorded spending B99 exists to prevent, now arriving
 * through the split path instead of the box that used to offer it.
 *
 * Income stays exempt for B99's own reason — its job is to land in Ready to
 * Assign and wait to be given one.
 */
export function outgoingLacksEnvelope(total: Paise, filed: ResolvedLines): boolean {
  if (total >= 0) return false;
  return filed.splits
    ? filed.splits.some((line) => !line.categoryId)
    : !filed.categoryId;
}

export function createTransfer(db: DB, actor: Actor, input: TransferInput): [Transaction, Transaction] {
  if (input.amount <= 0) throw new Refusal("Enter an amount greater than zero to transfer.");
  if (input.fromAccountId === input.toAccountId) throw new Refusal("Pick two different accounts.");

  return transact(db, () => {
    const from = getAccount(db, input.fromAccountId);
    const to = getAccount(db, input.toAccountId);
    if (!from || !to) throw new Missing("That account does not exist.");

    /*
     * A derived account is worth what its own records say — holdings for a
     * demat, a schedule for a loan, dated valuations for gold — so a plain
     * transfer into one is stored and then counted nowhere. ₹5,000 moved from
     * the bank into an investment account left the bank and never appeared in
     * the investment's value: net worth fell by exactly ₹5,000 and nothing
     * said why. The Add form already kept these accounts out; the transfer form
     * offered them. Each has its own screen that records the money properly.
     *
     * Family loans are the exception that proves it: their value is *derived
     * from* the transfers behind them, so the lending code passes managedBy.
     */
    for (const account of [from, to]) {
      if (!DERIVED_VALUE_SUBTYPES.has(account.subtype)) continue;
      if (account.subtype === "family-loan" && input.managedBy === "family-loans") continue;
      const where = MANAGED_SUBTYPES[account.subtype]?.label ?? "the Portfolio page";
      throw new Refusal(
        `"${account.name}" is valued from its own records, so money moved into or out ` +
        `of it here would be counted nowhere. Record it on ${where} instead.`,
      );
    }

    const pairId = newId();
    const date = input.date ?? todayIST();
    const isCardPayment = to.kind === "credit";
    const memo = input.memo ?? (isCardPayment ? `Card payment — ${to.name}` : `Transfer to ${to.name}`);

    const fee = input.fee && input.fee.amount > 0 ? input.fee : null;
    if (fee) {
      if (fee.amount < 0) throw new Refusal("A fee cannot be negative.");
      refusePaymentCategories(db, [fee.categoryId]);
    }

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

    /*
     * The fee is a third transaction, not a bigger outgoing leg, and it is
     * deliberately left outside the transfer pair. Inside it, the two legs
     * would no longer cancel and every report that excludes transfers would
     * quietly swallow a real expense. Outside it, the fee behaves like any
     * other categorised spend — it shows up in the envelope, in the reports and
     * in the month's spending, which is where somebody would go looking for it.
     */
    if (fee) {
      createTransaction(db, actor, {
        accountId: input.fromAccountId,
        amount: -fee.amount as Paise,
        date,
        categoryId: fee.categoryId,
        memo: isCardPayment ? `Charge on payment to ${to.name}` : `Charge on transfer to ${to.name}`,
        cleared: input.cleared,
      });
    }

    appendEvent(db, actor, {
      entity: "transfer", entityId: pairId, action: "create",
      after: {
        from: from.name, to: to.name, amount: input.amount, date,
        ...(fee ? { fee: fee.amount } : {}),
      },
      summary:
        (isCardPayment
          ? `Paid ${formatPaise(input.amount)} to ${to.name} from ${from.name}`
          : `Moved ${formatPaise(input.amount)} from ${from.name} to ${to.name}`) +
        (fee ? `, plus ${formatPaise(fee.amount)} in charges` : ""),
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
  default_account_id: string | null;
  merged_into_id: string | null;
}

/**
 * Find or create a payee by clean name, recording the raw string it came from
 * (F5.1, P4). Every raw string ever mapped is retained forever.
 */
export function resolvePayee(db: DB, actor: Actor, name: string, raw?: string | null): Payee {
  const clean = name.trim();
  if (!clean) throw new Refusal("A payee needs a name.");

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

export function listPayees(db: DB, viewerMemberId?: string | null): Payee[] {
  /*
   * 15 · A payee is a household-wide name, and mostly that is right: the same
   * DMart is everybody's DMart. But one that has only ever been seen on a
   * private account is not a shared fact at all — it is where one member spent,
   * and offering it in everybody's payee list and every Add form gave that away
   * one merchant at a time.
   *
   * Visible means: used at least once somewhere the viewer can see, or used
   * nowhere yet (a payee somebody typed and has not spent against is nobody's
   * secret). Omitted viewer means every payee, which is what an export wants.
   */
  if (viewerMemberId === undefined) {
    return queryAll<Payee>(db, `SELECT * FROM payees WHERE merged_into_id IS NULL ORDER BY name`);
  }
  return queryAll<Payee>(
    db,
    `SELECT p.* FROM payees p
      WHERE p.merged_into_id IS NULL
        AND (
          NOT EXISTS (SELECT 1 FROM transactions t WHERE t.payee_id = p.id)
          OR EXISTS (
            SELECT 1 FROM transactions t
              JOIN accounts a ON a.id = t.account_id
             WHERE t.payee_id = p.id
               AND (a.visibility <> 'private' OR a.holder_member_id IS ?)
          )
        )
      ORDER BY p.name`,
    viewerMemberId,
  );
}

/**
 * The ids of the payees above, for a caller that needs to test one — plus the
 * payees merged into a visible one.
 *
 * A merged payee drops out of every list, which is right for choosing a payee
 * and wrong for deciding whether somebody may see an event about one. The
 * activity log asks this, and the loser of a merge is exactly the payee a merge
 * event names: without this, no member could see — or undo — a merge at all.
 * A merged payee is as visible as the payee it now resolves to.
 */
export function visiblePayeeIds(db: DB, viewerMemberId: string | null): Set<string> {
  const visible = new Set(listPayees(db, viewerMemberId).map((p) => p.id));
  const merged = queryAll<{ id: string; merged_into_id: string }>(
    db, `SELECT id, merged_into_id FROM payees WHERE merged_into_id IS NOT NULL`,
  );
  for (const m of merged) if (visible.has(m.merged_into_id)) visible.add(m.id);
  return visible;
}

export function getPayee(db: DB, id: string): Payee | null {
  return queryOne<Payee>(db, `SELECT * FROM payees WHERE id = ?`, id);
}

/** F5.2: merging preserves all history and mappings. */
export function mergePayees(db: DB, actor: Actor, loserId: string, winnerId: string): void {
  if (loserId === winnerId) throw new Refusal("Pick two different payees.");
  transact(db, () => {
    const loser = getPayee(db, loserId);
    const winner = getPayee(db, winnerId);
    if (!loser || !winner) throw new Missing("That payee does not exist.");

    /*
     * Record exactly what moves, so the merge can be undone. The event used to
     * hold only the two payees, and undo could do no more than clear
     * merged_into_id: the loser reappeared in the list with none of its
     * transactions and none of its aliases, which had all stayed with the
     * winner. "Un-merged" said the undo; it had un-merged a name.
     */
    const movedTransactionIds = queryAll<{ id: string }>(
      db, `SELECT id FROM transactions WHERE payee_id = ?`, loserId,
    ).map((r) => r.id);
    const movedAliasIds = queryAll<{ id: string }>(
      db, `SELECT id FROM payee_aliases WHERE payee_id = ?`, loserId,
    ).map((r) => r.id);

    execute(db, `UPDATE transactions SET payee_id = ? WHERE payee_id = ?`, winnerId, loserId);
    execute(db, `UPDATE payee_aliases SET payee_id = ? WHERE payee_id = ?`, winnerId, loserId);
    // Kept rather than deleted, so the old name still resolves.
    execute(db, `UPDATE payees SET merged_into_id = ? WHERE id = ?`, winnerId, loserId);

    appendEvent(db, actor, {
      entity: "payee", entityId: loserId, action: "merge", before: loser,
      after: { ...winner, movedTransactionIds, movedAliasIds },
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
  const id = event.entityId!;
  const snapshot = before as Partial<EditSnapshot>;

  /*
   * Undo used to be one statement for every kind of event: write every column
   * of `before` back onto the row. Three different things went wrong with it.
   *
   * A delete of one transfer leg deletes both (deleteTransaction), and undoing
   * it brought back only the leg the event named — so the "restore for 30 days"
   * the delete screen promises restored half a transfer, and the other half's
   * ₹1,000 was simply gone from the household's money.
   *
   * An edit rewrites the split lines, which are not columns of this row, so
   * undoing an edit restored the row and left the lines as the edit had made
   * them. A split charge flattened and then undone came back marked split with
   * no lines at all.
   *
   * And not every event records the whole row. Marking a line cleared while
   * reconciling records `{ cleared: 0 }`, and writing every column from that
   * wrote NULL into account_id — a 500, on an undo the activity page kept
   * offering and that failed every time.
   */
  if (event.action === "delete" || event.action === "restore") {
    // Put deleted_at back as it was, on the row and — for a transfer — its pair.
    const pairId = snapshot.transfer_pair_id ?? null;
    execute(
      db,
      `UPDATE transactions SET deleted_at = ?, updated_at = ?
        WHERE id = ? OR (? IS NOT NULL AND transfer_pair_id = ?)`,
      snapshot.deleted_at ?? null, nowIST(), id, pairId, pairId,
    );
    return event.action === "delete"
      ? `Restored the deleted transaction${pairId ? " and the other side of its transfer" : ""}`
      : `Deleted the transaction again`;
  }

  // Refuse before writing anything: an older edit event that cannot restore
  // its lines must not half-restore the row first.
  if (!Array.isArray(snapshot.splits) && snapshot.is_split === 1 && getSplits(db, id).length === 0) {
    throw new UndoRefused(
      "That edit was recorded before split lines were kept with it, so undoing it " +
      "cannot put the lines back. Open the transaction and split it again instead.",
    );
  }

  const COLUMNS = [
    "account_id", "card_id", "date", "amount", "payee_id", "category_id",
    "is_split", "memo", "cleared", "owner_member_id", "reimbursable", "deleted_at",
  ] as const;
  const present = COLUMNS.filter((c) => c in snapshot);
  if (present.length === 0) return `Nothing to restore`;
  execute(
    db,
    `UPDATE transactions SET ${present.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
    ...present.map((c) => (snapshot as Record<string, unknown>)[c] as string | number | null),
    nowIST(), id,
  );

  // Split lines, when the event recorded them.
  if (Array.isArray(snapshot.splits)) {
    execute(db, `DELETE FROM transaction_splits WHERE transaction_id = ?`, id);
    snapshot.splits.forEach((line, i) => {
      execute(
        db,
        `INSERT INTO transaction_splits (id,transaction_id,category_id,amount,memo,sort) VALUES (?,?,?,?,?,?)`,
        newId(), id, line.category_id, line.amount, line.memo ?? null, i,
      );
    });
  } else if (snapshot.is_split === 0) {
    // An older event, from before lines were recorded. Unsplit is unambiguous.
    execute(db, `DELETE FROM transaction_splits WHERE transaction_id = ?`, id);
  }

  // The other side of a transfer moves back with it.
  if (snapshot.partner) {
    execute(
      db,
      `UPDATE transactions SET amount = ?, date = ?, updated_at = ? WHERE id = ?`,
      snapshot.partner.amount, snapshot.partner.date, nowIST(), snapshot.partner.id,
    );
  }

  return typeof snapshot.amount === "number"
    ? `Restored the transaction of ${formatPaise(Math.abs(snapshot.amount) as Paise)}`
    : `Restored the transaction`;
});

registerUndoHandler("transfer", (db, event) => {
  execute(db, `UPDATE transactions SET deleted_at = ? WHERE transfer_pair_id = ?`, nowIST(), event.entityId!);
  return `Reversed the transfer`;
});

registerUndoHandler("payee", (db, event) => {
  const before = event.before as Payee | undefined;
  if (event.action === "merge" && before) {
    const after = event.after as { id?: string; movedTransactionIds?: string[]; movedAliasIds?: string[] } | undefined;
    // Move back only what the merge moved, and only if it still sits with the
    // winner — anything re-filed since is the household's later decision.
    for (const tid of after?.movedTransactionIds ?? []) {
      execute(db, `UPDATE transactions SET payee_id = ? WHERE id = ? AND payee_id = ?`, before.id, tid, after!.id ?? null);
    }
    for (const aliasId of after?.movedAliasIds ?? []) {
      execute(db, `UPDATE payee_aliases SET payee_id = ? WHERE id = ? AND payee_id = ?`, before.id, aliasId, after!.id ?? null);
    }
    execute(db, `UPDATE payees SET merged_into_id = NULL WHERE id = ?`, before.id);
    const moved = after?.movedTransactionIds?.length ?? 0;
    return moved > 0
      ? `Un-merged "${before.name}" and moved its ${moved} transaction${moved === 1 ? "" : "s"} back`
      : `Un-merged "${before.name}"`;
  }
  execute(db, `DELETE FROM payees WHERE id = ?`, event.entityId!);
  return `Removed the payee that was added`;
});

/**
 * 15 §3A.4 · The claim raised by filing this account's money to that envelope.
 *
 * A no-op in the ordinary case, which is every filing a household with one
 * budget has ever made.
 */
function claimFilingFor(
  db: DB, actor: Actor, account: { id: string; budget_id: string | null }, categoryId: string | null,
): void {
  if (!categoryId || !account.budget_id) return;
  const categoryBudget = queryOne<{ budget_id: string | null }>(
    db, `SELECT budget_id FROM categories WHERE id = ?`, categoryId,
  )?.budget_id ?? null;
  prepareClaim(db, actor, account.id, account.budget_id, categoryBudget);
}
