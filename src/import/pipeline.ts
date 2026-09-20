/**
 * `04` §2 · The pipeline.
 *
 * Every source terminates here, which is what makes the phasing in `05` safe:
 * adding email or SMS parsing later changes nothing downstream, because they
 * produce the same raw records and land in the same review queue.
 *
 *   normalise → dedupe → rules → auto-approve gate → ledger or review queue
 *
 * I2 is the rule that shapes it: nothing enters the ledger from an automated
 * source without either human confirmation or an explicit auto-approve rule
 * the human created.
 */

import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, registerUndoHandler, type Actor } from "../core/events.ts";
import { nowIST, type IsoDate } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";
import { createTransaction, resolvePayee } from "../domain/transactions.ts";
import { findCardByLast4 } from "../domain/accounts.ts";
import { findDuplicate, type Candidate, type DuplicateMatch } from "./dedupe.ts";
import {
  applyRules, extractNarrationFields, mayAutoApprove,
  type Rule, type RuleSubject,
} from "./rules.ts";
import type { RawRecord, ParseError } from "./csv.ts";
import { createHash } from "node:crypto";
import { Missing, Refusal } from "../core/refusal.ts";

/**
 * The identity of an imported row, for the exact-match tier in `04` §4.
 *
 * Derived from the row's *content*, deliberately: the file name is metadata
 * about where the row came from (IL1 records it on the batch), not part of what
 * the row is. Keying on it meant renaming a download — `statement.csv` to
 * `hdfc-august.csv` — defeated I5 and queued the whole month a second time.
 *
 * `occurrence` is what keeps D2 working. Two genuinely separate identical
 * transactions (two people, same shop, same amount, same day) are two rows in
 * the file, so they take occurrences 0 and 1 and both survive. Re-importing
 * that same file produces the same two occurrences, and both are skipped.
 */
function sourceIdFor(
  adapter: string, record: RawRecord, occurrence: number,
): string {
  const digest = createHash("sha256")
    .update(`${record.date}\0${record.amount}\0${record.narration}\0${record.reference ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return `${adapter}:${digest}:${occurrence}`;
}

export interface ImportBatch {
  id: string;
  source: string;
  adapter: string;
  account_id: string | null;
  file_name: string | null;
  created_at: string;
  rows_read: number;
  created_count: number;
  duplicate_count: number;
  auto_approved_count: number;
  error_count: number;
  undone_at: string | null;
}

export interface StagedRow {
  id: string;
  batch_id: string;
  account_id: string;
  card_id: string | null;
  date: IsoDate;
  amount: Paise;
  raw_narration: string | null;
  raw_payee: string | null;
  raw_amount: string | null;
  source_id: string | null;
  proposed_payee: string | null;
  payee_id: string | null;
  category_id: string | null;
  memo: string | null;
  duplicate_of_id: string | null;
  duplicate_tier: string | null;
  duplicate_reason: string | null;
  status: string;
  transaction_id: string | null;
  applied_rules_json: string | null;
}

export interface IngestOptions {
  accountId: string;
  source: "csv" | "pdf" | "email" | "sms" | "api";
  adapter: string;
  fileName?: string | null;
  records: RawRecord[];
  errors?: ParseError[];
  rowsRead?: number;
}

export interface IngestResult {
  batch: ImportBatch;
  staged: number;
  autoApproved: number;
  duplicates: number;
  skipped: number;
  errors: number;
}

/**
 * Run raw records through the pipeline into a batch.
 *
 * Re-running the same file is idempotent (I5): each row carries a stable
 * source id, and an exact match is skipped rather than staged again.
 */
export function ingest(db: DB, actor: Actor, opts: IngestOptions): IngestResult {
  return transact(db, () => {
    const batchId = newId();
    const rows = opts.records;

    execute(
      db,
      `INSERT INTO import_batches
         (id,source,adapter,account_id,file_name,member_id,created_at,rows_read,error_count,errors_json)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      batchId, opts.source, opts.adapter, opts.accountId, opts.fileName ?? null,
      actor.memberId, nowIST(), opts.rowsRead ?? rows.length,
      opts.errors?.length ?? 0,
      opts.errors?.length ? JSON.stringify(opts.errors) : null,
    );

    const rules = loadRules(db);
    const existing = loadCandidates(db, opts.accountId);

    // I5 requires zero new transactions *and* zero new review items. A row
    // still waiting in the queue is not in the ledger, so the exact-match tier
    // cannot see it — without this, re-importing a file whose rows have not
    // been approved yet queues every one of them a second time.
    const stagedSourceIds = new Set(
      queryAll<{ source_id: string }>(
        db,
        `SELECT source_id FROM staged_transactions
          WHERE account_id = ? AND status = 'pending' AND source_id IS NOT NULL`,
        opts.accountId,
      ).map((r) => r.source_id),
    );

    let staged = 0;
    let autoApproved = 0;
    let duplicates = 0;
    let skipped = 0;

    // How many times each identical row has been seen in this file, so the
    // second one gets its own identity rather than colliding with the first.
    const occurrences = new Map<string, number>();

    for (const record of rows) {
      const base = sourceIdFor(opts.adapter, record, 0);
      const occurrence = occurrences.get(base) ?? 0;
      occurrences.set(base, occurrence + 1);
      const sourceId = sourceIdFor(opts.adapter, record, occurrence);

      if (stagedSourceIds.has(sourceId)) {
        skipped++;
        continue;
      }

      const extracted = extractNarrationFields(record.narration);
      const cardId = resolveCard(db, opts.accountId, record.narration);

      const subject: RuleSubject = {
        narration: record.narration,
        importedPayee: extracted.merchant,
        payee: extracted.merchant,
        accountId: opts.accountId,
        amount: record.amount,
        date: record.date,
        memo: null,
        tags: [],
        categoryId: null,
        cleared: opts.source === "csv" || opts.source === "pdf", // D5
        source: opts.source,
        cardLast4: null,
        ...extracted,
      };

      const outcome = applyRules(subject, rules);
      if (outcome.ignored) {
        skipped++;
        continue;
      }

      const duplicate = findDuplicate(
        {
          accountId: opts.accountId,
          date: record.date,
          amount: record.amount,
          payee: outcome.subject.payee,
          reference: record.reference ?? extracted.reference,
          source: opts.source,
          sourceId,
        },
        existing,
      );

      if (duplicate?.action === "skip") {
        skipped++;
        continue;
      }

      if (duplicate?.action === "upgrade") {
        upgradeExisting(db, actor, duplicate, record, extracted.reference);
        duplicates++;
        continue;
      }

      if (duplicate) duplicates++;

      // A payee is resolved only when a rule named one; a first-time merchant
      // string is a *proposal*, never an auto-created payee (`04` §3.6).
      const namedByRule = outcome.appliedRuleIds.length > 0 && outcome.subject.payee !== extracted.merchant;
      const payeeId = namedByRule && outcome.subject.payee
        ? resolvePayee(db, actor, outcome.subject.payee, record.narration).id
        : findExistingPayee(db, outcome.subject.payee);

      const canAutoApprove = mayAutoApprove(outcome, {
        payeeExists: payeeId !== null,
        duplicateSuspected: duplicate !== null,
      });

      const stagedId = newId();
      execute(
        db,
        `INSERT INTO staged_transactions
           (id,batch_id,account_id,card_id,row_number,date,amount,raw_narration,raw_payee,raw_amount,
            raw_date,source_id,reference,payee_id,proposed_payee,category_id,memo,tags_json,
            applied_rules_json,duplicate_of_id,duplicate_tier,duplicate_reason,status,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`,
        stagedId, batchId, opts.accountId, cardId, record.rowNumber, record.date, record.amount,
        record.raw.narration, extracted.merchant, record.raw.amount, record.raw.date,
        sourceId, record.reference ?? extracted.reference,
        payeeId, outcome.subject.payee, outcome.subject.categoryId, outcome.subject.memo,
        outcome.subject.tags.length ? JSON.stringify(outcome.subject.tags) : null,
        outcome.appliedRuleIds.length ? JSON.stringify(outcome.appliedRuleIds) : null,
        duplicate?.existing.id ?? null, duplicate?.tier ?? null, duplicate?.reason ?? null,
        nowIST(),
      );
      staged++;
      stagedSourceIds.add(sourceId);

      if (canAutoApprove) {
        approveStaged(db, actor, stagedId, { autoApproved: true });
        autoApproved++;
        // Keep the in-memory candidate list current so two identical rows in
        // one file still see each other.
        existing.push({
          id: stagedId, accountId: opts.accountId, date: record.date, amount: record.amount,
          payee: outcome.subject.payee, reference: record.reference, source: opts.source, sourceId,
        });
      }
    }

    execute(
      db,
      `UPDATE import_batches SET created_count = ?, duplicate_count = ?, auto_approved_count = ? WHERE id = ?`,
      staged, duplicates, autoApproved, batchId,
    );

    const batch = queryOne<ImportBatch>(db, `SELECT * FROM import_batches WHERE id = ?`, batchId)!;

    appendEvent(db, actor, {
      entity: "import-batch",
      entityId: batchId,
      action: "create",
      after: { staged, autoApproved, duplicates, skipped },
      summary:
        `Imported ${opts.fileName ?? "a file"}: ${staged} rows to review` +
        (duplicates ? `, ${duplicates} possible duplicates` : "") +
        (skipped ? `, ${skipped} already present` : ""),
    });

    return { batch, staged, autoApproved, duplicates, skipped, errors: opts.errors?.length ?? 0 };
  });
}

/** R6.e: an alert naming an add-on's last four resolves to that card. */
function resolveCard(db: DB, accountId: string, narration: string): string | null {
  const match = /\b(?:xx|XX|\*+|ending\s+)(\d{4})\b/.exec(narration) ?? /\b(\d{4})\b/.exec(narration);
  if (!match) return null;
  const card = findCardByLast4(db, match[1]!);
  return card && card.account_id === accountId ? card.id : null;
}

function findExistingPayee(db: DB, name: string | null): string | null {
  if (!name) return null;
  return (
    queryOne<{ id: string }>(db, `SELECT id FROM payees WHERE name = ? COLLATE NOCASE`, name)?.id ?? null
  );
}

/**
 * D4 · A statement arriving after an alert **upgrades** the existing record
 * with richer fields rather than duplicating it. Logged, not queued.
 */
function upgradeExisting(
  db: DB, actor: Actor, duplicate: DuplicateMatch, record: RawRecord, reference: string | null,
): void {
  const before = queryOne<Record<string, unknown>>(
    db, `SELECT * FROM transactions WHERE id = ?`, duplicate.existing.id,
  );
  // D5: marking cleared via statement import is how `cleared` gets set at scale.
  execute(
    db,
    `UPDATE transactions
        SET cleared = 1,
            raw_narration = COALESCE(raw_narration, ?),
            memo = COALESCE(memo, ?)
      WHERE id = ?`,
    record.raw.narration, reference ? `Ref ${reference}` : null, duplicate.existing.id,
  );
  appendEvent(db, actor, {
    entity: "transaction", entityId: duplicate.existing.id, action: "upgrade",
    before, after: queryOne(db, `SELECT * FROM transactions WHERE id = ?`, duplicate.existing.id),
    summary: `Matched to a statement row and marked cleared — ${duplicate.reason}`,
  });
}

function loadCandidates(db: DB, accountId: string): Candidate[] {
  return queryAll<{
    id: string; date: string; amount: number; payee: string | null;
    memo: string | null; source: string; source_id: string | null; raw_narration: string | null;
  }>(
    db,
    `SELECT t.id, t.date, t.amount, p.name AS payee, t.memo, t.source, t.source_id, t.raw_narration
       FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
      WHERE t.account_id = ? AND t.deleted_at IS NULL
      ORDER BY t.date DESC LIMIT 2000`,
    accountId,
  ).map((r) => ({
    id: r.id,
    accountId,
    date: r.date,
    amount: r.amount,
    payee: r.payee ?? r.raw_narration,
    reference: extractReference(r.memo, r.raw_narration),
    source: r.source,
    sourceId: r.source_id,
  }));
}

function extractReference(memo: string | null, narration: string | null): string | null {
  const fromMemo = memo ? /Ref (\d{6,})/.exec(memo) : null;
  if (fromMemo) return fromMemo[1]!;
  return narration ? extractNarrationFields(narration).reference : null;
}

export function loadRules(db: DB): Rule[] {
  return queryAll<{
    id: string; name: string; stage: string; conditions_json: string;
    actions_json: string; enabled: number;
  }>(db, `SELECT * FROM rules WHERE enabled = 1 AND proposed = 0`).map((r) => {
    const conditions = JSON.parse(r.conditions_json) as { match?: "all" | "any"; conditions?: unknown[] } | unknown[];
    const isWrapped = !Array.isArray(conditions);
    return {
      id: r.id,
      name: r.name,
      stage: r.stage as Rule["stage"],
      match: isWrapped ? (conditions.match ?? "all") : "all",
      conditions: (isWrapped ? conditions.conditions ?? [] : conditions) as Rule["conditions"],
      actions: JSON.parse(r.actions_json) as Rule["actions"],
      enabled: r.enabled === 1,
    };
  });
}

// ---------------------------------------------------------------------------
// The review queue (S4)
// ---------------------------------------------------------------------------

export function listStaged(db: DB, opts: { batchId?: string } = {}): StagedRow[] {
  return queryAll<StagedRow>(
    db,
    `SELECT * FROM staged_transactions
      WHERE status = 'pending' ${opts.batchId ? "AND batch_id = ?" : ""}
      ORDER BY duplicate_tier IS NULL, date DESC`,
    ...(opts.batchId ? [opts.batchId] : []),
  );
}

/** B99 · Thrown when an expense would enter the ledger with no envelope. */
export class StagedNeedsCategory extends Refusal {}

export function approveStaged(
  db: DB, actor: Actor, stagedId: string,
  patch: { categoryId?: string | null; payeeName?: string | null; memo?: string | null; autoApproved?: boolean } = {},
): string {
  return transact(db, () => {
    const row = queryOne<StagedRow>(db, `SELECT * FROM staged_transactions WHERE id = ?`, stagedId);
    if (!row) throw new Missing("That review item no longer exists.");
    if (row.status !== "pending") throw new Refusal("That review item has already been dealt with.");

    /*
     * B99 · An expense names the envelope it came out of.
     *
     * This is the chokepoint into the ledger — manual approval and auto-approval
     * both come through here — so the rule lives here rather than on a form.
     * Money *in* is exempt: its job is to arrive in Ready to Assign and wait to
     * be given one, which is the whole model, and forcing a category on income
     * would be asking the household to answer a question the app has already
     * answered correctly.
     *
     * The queue itself stays the place an unfiled row waits. Refusing at import
     * would only mean losing the row.
     */
    const categoryId = patch.categoryId ?? row.category_id ?? null;
    if (row.amount < 0 && !categoryId) {
      throw new StagedNeedsCategory(
        "Choose an envelope for this one before adding it — money out has to come from somewhere. Money in doesn't need one.",
      );
    }

    const payeeName = patch.payeeName ?? row.proposed_payee;
    const payeeId = row.payee_id
      ?? (payeeName ? resolvePayee(db, actor, payeeName, row.raw_narration ?? undefined).id : null);

    const transaction = createTransaction(db, actor, {
      accountId: row.account_id,
      cardId: row.card_id,
      amount: row.amount,
      date: row.date,
      payeeId,
      categoryId: patch.categoryId !== undefined ? patch.categoryId : row.category_id,
      memo: patch.memo ?? row.memo,
      cleared: true,
      source: "csv",
      // I5 depends on this reaching the ledger: the exact-match tier compares
      // against transactions, not staged rows, so without it re-importing the
      // same file would queue every row again. The unique index on
      // (source, source_id) enforces the same thing at the database.
      sourceId: row.source_id,
      importBatchId: row.batch_id,
      raw: {
        narration: row.raw_narration ?? undefined,
        payee: row.raw_payee ?? undefined,
        amount: row.raw_amount ?? undefined,
      },
    });

    if (patch.autoApproved) {
      execute(db, `UPDATE transactions SET auto_approved_at = ? WHERE id = ?`, nowIST(), transaction.id);
    }

    // R-E4: record which rules touched it, for the details pane.
    for (const ruleId of JSON.parse(row.applied_rules_json ?? "[]") as string[]) {
      execute(
        db,
        `INSERT OR IGNORE INTO rule_applications (transaction_id, rule_id, at) VALUES (?,?,?)`,
        transaction.id, ruleId, nowIST(),
      );
      execute(db, `UPDATE rules SET times_applied = times_applied + 1 WHERE id = ?`, ruleId);
    }

    execute(
      db,
      `UPDATE staged_transactions SET status = 'approved', resolved_at = ?, resolved_by = ?, transaction_id = ?
        WHERE id = ?`,
      nowIST(), actor.memberId, transaction.id, stagedId,
    );

    return transaction.id;
  });
}

export function rejectStaged(db: DB, actor: Actor, stagedId: string, reason = "dismissed"): void {
  transact(db, () => {
    execute(
      db,
      `UPDATE staged_transactions SET status = 'rejected', resolved_at = ?, resolved_by = ? WHERE id = ?`,
      nowIST(), actor.memberId, stagedId,
    );
    appendEvent(db, actor, {
      entity: "staged-transaction", entityId: stagedId, action: "reject",
      summary: `Dismissed an imported row (${reason})`,
    });
  });
}

/**
 * D3 · Merging preserves both raw records and is reversible. The manual
 * entry's category is kept; the import's payee and reference are added.
 */
export function mergeStaged(db: DB, actor: Actor, stagedId: string): void {
  transact(db, () => {
    const row = queryOne<StagedRow>(db, `SELECT * FROM staged_transactions WHERE id = ?`, stagedId);
    if (!row?.duplicate_of_id) throw new Refusal("That row has nothing to merge with.");

    const before = queryOne<Record<string, unknown>>(
      db, `SELECT * FROM transactions WHERE id = ?`, row.duplicate_of_id,
    );

    execute(
      db,
      `UPDATE transactions
          SET cleared = 1,
              payee_id = COALESCE(payee_id, ?),
              raw_narration = COALESCE(raw_narration, ?),
              raw_amount = COALESCE(raw_amount, ?)
        WHERE id = ?`,
      row.payee_id, row.raw_narration, row.raw_amount, row.duplicate_of_id,
    );

    execute(
      db,
      `UPDATE staged_transactions SET status = 'merged', resolved_at = ?, resolved_by = ?, transaction_id = ?
        WHERE id = ?`,
      nowIST(), actor.memberId, row.duplicate_of_id, stagedId,
    );

    appendEvent(db, actor, {
      entity: "transaction", entityId: row.duplicate_of_id, action: "merge",
      before, after: queryOne(db, `SELECT * FROM transactions WHERE id = ?`, row.duplicate_of_id),
      summary: `Merged an imported row into the transaction you had already entered`,
    });
  });
}

// ---------------------------------------------------------------------------
// IL2 · Batch undo
// ---------------------------------------------------------------------------

export interface UndoBatchResult {
  removed: number;
  /** Records the batch created that have since been edited, and so were left. */
  keptBecauseEdited: string[];
}

export function undoBatch(db: DB, actor: Actor, batchId: string): UndoBatchResult {
  return transact(db, () => {
    const created = queryAll<{ id: string; created_at: string; updated_at: string }>(
      db,
      `SELECT id, created_at, updated_at FROM transactions
        WHERE import_batch_id = ? AND deleted_at IS NULL`,
      batchId,
    );

    const keptBecauseEdited: string[] = [];
    let removed = 0;

    for (const t of created) {
      // IL2: an edited record is listed and left alone with an explanation.
      if (t.updated_at !== t.created_at) {
        keptBecauseEdited.push(t.id);
        continue;
      }
      execute(db, `UPDATE transactions SET deleted_at = ? WHERE id = ?`, nowIST(), t.id);
      removed++;
    }

    execute(
      db,
      `UPDATE staged_transactions SET status = 'rejected', resolved_at = ?
        WHERE batch_id = ? AND status = 'pending'`,
      nowIST(), batchId,
    );
    execute(db, `UPDATE import_batches SET undone_at = ? WHERE id = ?`, nowIST(), batchId);

    appendEvent(db, actor, {
      entity: "import-batch", entityId: batchId, action: "undo",
      after: { removed, kept: keptBecauseEdited.length },
      summary:
        `Undid an import: removed ${removed} transactions` +
        (keptBecauseEdited.length
          ? `, left ${keptBecauseEdited.length} that had been edited since`
          : ""),
    });

    return { removed, keptBecauseEdited };
  });
}

export function listBatches(db: DB, limit = 30): ImportBatch[] {
  return queryAll<ImportBatch>(
    db, `SELECT * FROM import_batches ORDER BY created_at DESC LIMIT ?`, limit,
  );
}

registerUndoHandler("import-batch", (db, event, actor) => {
  const result = undoBatch(db, actor, event.entityId!);
  return `Removed ${result.removed} imported transactions`;
});
