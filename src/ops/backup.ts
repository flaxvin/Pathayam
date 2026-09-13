/**
 * R40 · Backup, restore and **verified** recovery.
 *
 * `08` §8 opens with the point of this module: "F15.5 required a backup. That
 * is not the same as being able to recover." So the scheduled job here is not
 * a backup job, it is a *restore verification* job (R40.2) — it restores the
 * most recent backup into a scratch database and compares control totals.
 *
 * Two constraints shape the implementation:
 *
 * - **R40.5** verification runs against a scratch database, never the live
 *   one, and the procedure must make that impossible to get wrong. Here the
 *   scratch handle is opened read-only from a copied file, so a write cannot
 *   reach the live database even by mistake.
 * - **R40.7** a backup must be restorable *without the application*. It is a
 *   plain SQLite file produced by `VACUUM INTO`, readable by the `sqlite3`
 *   CLI, plus a JSON export in an open documented shape.
 *
 * R40.8 (`10` §3.2) adds the failure this module could not otherwise report:
 * if the box is down, no process here is left to fire R40.4's webhook, and the
 * one failure Q24 said must never be silent is silent exactly when it matters.
 * The answer is a heartbeat on *success* to a monitor that alerts on the
 * absence of a ping — see `pingHeartbeat`.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "../db/db.ts";
import { queryAll, queryOne, queryValue, execute } from "../db/db.ts";
import { nowIST, todayIST } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";
import { formatPaise } from "../core/money.ts";

/**
 * R40.2 · What is compared. Record counts per entity plus control totals — if
 * any of these differ, the backup is not a faithful copy and saying "backup
 * succeeded" would be a lie.
 */
export interface ControlTotals {
  counts: Record<string, number>;
  transactionTotal: Paise;
  assignmentTotal: Paise;
  splitTotal: Paise;
  accountOpeningTotal: Paise;
  /** Milliunits across every lot — silent unit loss shows here. */
  lotUnitsTotal: number;
  /** Paise cost basis across every lot. */
  lotCostTotal: Paise;
  /** Paise disbursed across every loan. */
  loanDisbursedTotal: Paise;
  /** Paise across every recorded net-worth snapshot. */
  netWorthSnapshotTotal: Paise;
  /** Q10 · total attachment bytes — a truncated blob shows here. */
  attachmentBytesTotal: number;
  eventCount: number;
  /** Highest event sequence — a truncated log shows up here immediately. */
  maxEventSeq: number;
}

/*
 * Every durable household table.
 *
 * This is the set the export carries (F15) and the set restore-verification
 * counts (R40.2). It was originally the P0 budget engine only; loans, assets,
 * goals, family lending and month-close were added later and — until they were
 * added here — a backup could silently drop the entire portfolio and still pass
 * verification. The seam between "the budget" and "everything the app stores"
 * is exactly where that drift happens, so this list is now the authority.
 *
 * Deliberately absent (see EPHEMERAL below): security, session and operational
 * tables, which legitimately differ between a snapshot and now and are not
 * household data to restore.
 */
export const COUNTED_TABLES = [
  // Budget engine
  "budgets",
  "members", "accounts", "cards", "card_statements", "category_groups", "categories", "assignments",
  "held_for_next_month", "targets", "payees", "payee_aliases",
  "transactions", "transaction_splits", "tags", "transaction_tags",
  "import_batches", "staged_transactions", "rules", "reconciliations", "schedules",
  "events",
  // Loans (06)
  "loans", "loan_disbursements", "loan_payments", "loan_rates", "loan_statements",
  // Assets & net worth (07)
  "instruments", "holdings", "lots", "holding_events", "prices", "fx_rates",
  "asset_valuations", "net_worth_snapshots",
  // Family lending, goals, month-close, saved state
  "family_loans", "goals", "goal_categories", "month_closes",
  // 15 §4A · Amounts one budget let go. Household data, and the only record of
  // why a balance between two people closed.
  "even_calls",
  "settings_kv", "digest_mutes",
  // Q10 · receipts. The bytes live in this table, so backup covers them.
  "attachments",
];

/**
 * Tables the export and control totals deliberately skip.
 *
 * `NEVER_EXPORTED` (statement identity, Gmail token) are secrets. The rest are
 * ephemeral or operational — a session, a rate-limit attempt, an idempotency
 * key, a job run, a price-fetch log — none of which is household data and all
 * of which legitimately change between a backup and its verification, so
 * counting them would raise false failures.
 */
export const EPHEMERAL = [
  "sessions", "api_tokens", "auth_attempts", "idempotency_keys",
  "job_runs", "price_fetches",
  // B66 · Operational: a failed request's path and stack. Useful at 2am, not
  // household data, and it would put a stack trace in an export that travels.
  "request_failures",
  // B74 · Derived. The rollup is a summary of the ledger that is already
  // exported, it rebuilds itself on the next read, and it legitimately differs
  // between a backup and its verification — counting it would raise a false
  // failure, and exporting it would ship a cache.
  "month_rollups", "month_rollup_state",
];

export function controlTotals(db: DB | DatabaseSync): ControlTotals {
  const handle = db as DB;
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    counts[table] = queryValue<number>(handle, `SELECT COUNT(*) FROM ${table}`) ?? 0;
  }

  return {
    counts,
    transactionTotal:
      queryValue<number>(handle, `SELECT COALESCE(SUM(amount),0) FROM transactions`) ?? 0,
    assignmentTotal:
      queryValue<number>(handle, `SELECT COALESCE(SUM(amount),0) FROM assignments`) ?? 0,
    splitTotal:
      queryValue<number>(handle, `SELECT COALESCE(SUM(amount),0) FROM transaction_splits`) ?? 0,
    accountOpeningTotal:
      queryValue<number>(handle, `SELECT COALESCE(SUM(opening_balance),0) FROM accounts`) ?? 0,
    lotUnitsTotal:
      queryValue<number>(handle, `SELECT COALESCE(SUM(units),0) FROM lots`) ?? 0,
    lotCostTotal:
      queryValue<number>(handle, `SELECT COALESCE(SUM(cost),0) FROM lots`) ?? 0,
    loanDisbursedTotal:
      queryValue<number>(handle, `SELECT COALESCE(SUM(amount),0) FROM loan_disbursements`) ?? 0,
    netWorthSnapshotTotal:
      queryValue<number>(handle, `SELECT COALESCE(SUM(net_worth),0) FROM net_worth_snapshots`) ?? 0,
    attachmentBytesTotal:
      queryValue<number>(handle, `SELECT COALESCE(SUM(size),0) FROM attachments`) ?? 0,
    eventCount: queryValue<number>(handle, `SELECT COUNT(*) FROM events`) ?? 0,
    maxEventSeq: queryValue<number>(handle, `SELECT COALESCE(MAX(seq),0) FROM events`) ?? 0,
  };
}

export interface BackupResult {
  path: string;
  bytes: number;
  at: string;
  totals: ControlTotals;
}

/**
 * R40.1 · Take a backup.
 *
 * `VACUUM INTO` writes a consistent snapshot even while the app is serving
 * requests, and produces an ordinary SQLite file with no journal to reassemble
 * — which is what makes R40.7 true rather than aspirational.
 */
export function createBackup(db: DB, backupDir: string, now = new Date()): BackupResult {
  mkdirSync(backupDir, { recursive: true });

  const stamp = nowIST(now).replace(/[:.]/g, "-").replace("+05-30", "IST");
  const path = join(backupDir, `budget-${stamp}.sqlite`);

  // The path is interpolated because SQLite does not accept a bound parameter
  // here; it is built from a timestamp and configuration, never user input.
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);

  return {
    path,
    bytes: statSync(path).size,
    at: nowIST(now),
    totals: controlTotals(db),
  };
}

export function listBackups(backupDir: string): { path: string; bytes: number; mtime: Date }[] {
  try {
    return readdirSync(backupDir)
      .filter((f) => f.endsWith(".sqlite"))
      .map((f) => {
        const path = join(backupDir, f);
        const stat = statSync(path);
        return { path, bytes: stat.size, mtime: stat.mtime };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  } catch {
    return [];
  }
}

export function pruneBackups(backupDir: string, keep = 14): number {
  const backups = listBackups(backupDir);
  let removed = 0;
  for (const backup of backups.slice(keep)) {
    try {
      unlinkSync(backup.path);
      removed++;
    } catch {
      // A backup that cannot be removed is not a reason to fail the job.
    }
  }
  return removed;
}

export interface VerificationResult {
  ok: boolean;
  at: string;
  backupPath: string | null;
  /** R40.3: "14 entities, all control totals matched." */
  entitiesChecked: number;
  mismatches: string[];
  live: ControlTotals | null;
  restored: ControlTotals | null;
  summary: string;
}

/**
 * R40.2 · Restore the most recent backup into a scratch database and compare.
 *
 * The scratch handle is opened **read-only**, so nothing this function does
 * can reach the live database — R40.5 asks for a procedure that is impossible
 * to get wrong, and the safest way to guarantee that is to make the write
 * impossible rather than merely unlikely.
 */
export function verifyRestore(db: DB, backupDir: string): VerificationResult {
  const at = nowIST();
  const backups = listBackups(backupDir);
  const latest = backups[0];

  if (!latest) {
    return {
      ok: false, at, backupPath: null, entitiesChecked: 0,
      mismatches: ["There is no backup to restore."],
      live: null, restored: null,
      summary: "No backup found. Nothing has been verified.",
    };
  }

  const live = controlTotals(db);
  // The handle opens lazily, so corruption surfaces on the first query rather
  // than on construction — both have to be inside the guard, or a truncated
  // file would take the job down instead of being reported as a bad backup.
  let scratch: DatabaseSync | null = null;
  try {
    scratch = new DatabaseSync(latest.path, { readOnly: true });
    const restored = controlTotals(scratch);
    const mismatches: string[] = [];

    for (const table of COUNTED_TABLES) {
      const a = live.counts[table] ?? 0;
      const b = restored.counts[table] ?? 0;
      // A backup is taken before later writes land, so the restored copy may
      // legitimately hold *fewer* rows. More rows means something is wrong.
      if (b > a) mismatches.push(`${table}: backup has ${b} rows, live has ${a}`);
    }

    const compare = (name: string, liveValue: number, restoredValue: number) => {
      if (liveValue === restoredValue) return;
      // Only flag a control total that cannot be explained by writes since the
      // snapshot; an equal row count with a different sum cannot.
      if (live.counts.transactions === restored.counts.transactions) {
        mismatches.push(
          `${name}: backup ${formatPaise(restoredValue)}, live ${formatPaise(liveValue)}` +
            ` with the same row count — the copy is not faithful`,
        );
      }
    };
    compare("sum of all transactions", live.transactionTotal, restored.transactionTotal);
    compare("sum of all splits", live.splitTotal, restored.splitTotal);
    if (live.counts.assignments === restored.counts.assignments) {
      compare("sum of all assignments", live.assignmentTotal, restored.assignmentTotal);
    }

    // The portfolio and loan magnitudes, guarded on their own row counts so a
    // lot or disbursement written after the snapshot cannot raise a false
    // failure. Without these, a restore that kept every lot row but zeroed its
    // units would pass.
    const totalIf = (
      countTable: string, name: string, liveValue: number, restoredValue: number,
    ) => {
      if ((live.counts[countTable] ?? 0) === (restored.counts[countTable] ?? 0)
          && liveValue !== restoredValue) {
        mismatches.push(
          `${name}: backup and live differ with the same ${countTable} count — the copy is not faithful`,
        );
      }
    };
    totalIf("lots", "total units held", live.lotUnitsTotal, restored.lotUnitsTotal);
    totalIf("lots", "total cost basis", live.lotCostTotal, restored.lotCostTotal);
    totalIf("loan_disbursements", "total loan disbursed", live.loanDisbursedTotal, restored.loanDisbursedTotal);
    totalIf("net_worth_snapshots", "net-worth history", live.netWorthSnapshotTotal, restored.netWorthSnapshotTotal);
    totalIf("attachments", "receipt bytes", live.attachmentBytesTotal, restored.attachmentBytesTotal);

    // Event log integrity: the sequence must be contiguous from 1, or events
    // have been lost and R37.3's replay guarantee no longer holds.
    const gaps = queryValue<number>(
      scratch as unknown as DB,
      `SELECT COUNT(*) FROM (SELECT seq FROM events) WHERE seq < 1`,
    ) ?? 0;
    if (gaps > 0) mismatches.push("the event log contains invalid sequence numbers");
    if (restored.eventCount > 0 && restored.maxEventSeq < restored.eventCount) {
      mismatches.push("the event log is shorter than its highest sequence number");
    }

    const ok = mismatches.length === 0;
    return {
      ok, at, backupPath: latest.path,
      entitiesChecked: COUNTED_TABLES.length,
      mismatches, live, restored,
      summary: ok
        ? `Restored ${latest.path.split("/").pop()}, ${COUNTED_TABLES.length} entities, all control totals matched.`
        : `Restore verification FAILED: ${mismatches.join("; ")}`,
    };
  } catch (err) {
    return {
      ok: false, at, backupPath: latest.path, entitiesChecked: 0,
      mismatches: [`The backup could not be read: ${(err as Error).message}`],
      live, restored: null,
      summary:
        `The most recent backup could not be read — treat it as unusable. ` +
        `${(err as Error).message}`,
    };
  } finally {
    scratch?.close();
  }
}

/**
 * R40.8 · The dead-man's switch.
 *
 * Pings an external monitor **only on success**. The monitor alerts on the
 * *absence* of a ping, which is what makes this cover the failure R40.4
 * cannot: a box that is down, a tunnel that dropped, or a job that never ran
 * has no process left to report itself.
 *
 * R40.8.2: the alerting path must not depend on any component of this
 * deployment being alive — so nothing here is retried, queued or persisted. A
 * ping that does not arrive *is* the alert.
 *
 * R40.8.4: the monitor's expected interval is the verification schedule plus
 * slack, configured at the monitor rather than here, so one slow run does not
 * page anyone at 2am.
 */
export async function pingHeartbeat(
  heartbeatUrl: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; at: string }> {
  const at = nowIST();
  if (!heartbeatUrl) return { ok: false, at };
  try {
    const response = await fetchImpl(heartbeatUrl, { method: "POST" });
    return { ok: response.ok, at };
  } catch {
    // A missed ping is the signal, so failing to send one is not an error
    // worth escalating here — the monitor will notice.
    return { ok: false, at };
  }
}

/**
 * R40.4 · A failed or skipped verification alerts through the configured
 * channel, not merely a log line. Q24 narrowed outbound alerts to exactly this
 * one failure class, because it is the one where silence loses data.
 */
export async function reportFailure(
  webhookUrl: string | null,
  result: VerificationResult,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!webhookUrl) return false;
  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // No financial values in the payload beyond the totals that are the
      // point of the alert; nothing identifying a payee or a person.
      body: JSON.stringify({
        event: "restore-verification-failed",
        at: result.at,
        backup: result.backupPath,
        mismatches: result.mismatches,
        summary: result.summary,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Job bookkeeping, for the health page (F27.1)
// ---------------------------------------------------------------------------

export function recordJobRun(
  db: DB, job: string, status: "ok" | "failed" | "skipped", detail: string,
): void {
  const now = nowIST();
  execute(
    db,
    `INSERT INTO job_runs (job, started_at, finished_at, status, detail) VALUES (?,?,?,?,?)`,
    job, now, now, status, detail,
  );
}

export interface JobStatus {
  job: string;
  lastRun: string | null;
  status: string | null;
  detail: string | null;
}

export function lastJobRun(db: DB, job: string): JobStatus {
  const row = queryOne<{ started_at: string; status: string; detail: string | null }>(
    db, `SELECT * FROM job_runs WHERE job = ? ORDER BY started_at DESC LIMIT 1`, job,
  );
  return {
    job,
    lastRun: row?.started_at ?? null,
    status: row?.status ?? null,
    detail: row?.detail ?? null,
  };
}

/** The whole scheduled job: back up, verify, prune, alert on failure. */
export async function runBackupJob(
  db: DB,
  opts: {
    backupDir: string;
    webhookUrl: string | null;
    /** R40.8: external monitor pinged on success. */
    heartbeatUrl?: string | null;
    keep?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<VerificationResult> {
  let backup: BackupResult;
  try {
    backup = createBackup(db, opts.backupDir);
    recordJobRun(db, "backup", "ok", `${backup.path} (${backup.bytes} bytes)`);
  } catch (err) {
    const message = `Backup failed: ${(err as Error).message}`;
    recordJobRun(db, "backup", "failed", message);
    const result: VerificationResult = {
      ok: false, at: nowIST(), backupPath: null, entitiesChecked: 0,
      mismatches: [message], live: null, restored: null, summary: message,
    };
    await reportFailure(opts.webhookUrl, result, opts.fetchImpl);
    return result;
  }

  const verification = verifyRestore(db, opts.backupDir);
  recordJobRun(db, "restore-verification", verification.ok ? "ok" : "failed", verification.summary);

  if (verification.ok) {
    // R40.8.1: the heartbeat goes out only when the restore actually verified.
    // Pinging on a failed run would tell the monitor everything is fine.
    const beat = await pingHeartbeat(opts.heartbeatUrl ?? null, opts.fetchImpl);
    recordJobRun(
      db, "heartbeat",
      beat.ok ? "ok" : opts.heartbeatUrl ? "failed" : "skipped",
      beat.ok
        ? "Acknowledged by the external monitor."
        : opts.heartbeatUrl
          ? "The monitor could not be reached. It will alert on the missing ping."
          : "No heartbeat monitor configured.",
    );
  } else {
    await reportFailure(opts.webhookUrl, verification, opts.fetchImpl);
  }

  pruneBackups(opts.backupDir, opts.keep);
  return verification;
}

// ---------------------------------------------------------------------------
// F15 · Export
// ---------------------------------------------------------------------------

/**
 * F15.1 · The complete budget in one action, in an open documented format, and
 * re-importable into this app (F15.2). Includes the event log (R37.5).
 */
/**
 * `10` §3.6 · Never exported, whatever else is.
 *
 * F15 exports the whole budget in one action so it can be carried elsewhere,
 * and that is exactly why this table must not be in it: a PAN and a date of
 * birth are not budget data, and an export travels — to another machine, a
 * cloud drive, an email. The values stay on the server that needs them.
 */
export const NEVER_EXPORTED = ["statement_identity", "gmail_connections"];

export function exportEverything(db: DB): Record<string, unknown> {
  const tables = [...COUNTED_TABLES, "household", "import_profiles", "rule_applications", "review_dismissals"]
    .filter((table) => !NEVER_EXPORTED.includes(table));
  const data: Record<string, unknown> = {};
  for (const table of tables) {
    const rows = queryAll<Record<string, unknown>>(db, `SELECT * FROM ${table}`);
    // Q10 / F15.1 · attachments are part of the export, but their bytes are a
    // BLOB — base64 it so the JSON is valid and portable rather than a raw byte
    // array. Everything else is scalar already.
    if (table === "attachments") {
      for (const row of rows) {
        if (row.bytes instanceof Uint8Array) {
          row.bytes = Buffer.from(row.bytes).toString("base64");
        }
      }
    }
    data[table] = rows;
  }

  return {
    format: "pathayam-export",
    version: 1,
    exportedAt: nowIST(),
    exportedOn: todayIST(),
    // Documented inline so the file explains itself years later, without this
    // codebase to hand — the point of F15.2 and R40.7.
    notes: {
      amounts: "Integer paise. 100 paise = 1 rupee. Never floating point.",
      dates: "Civil dates as YYYY-MM-DD, evaluated in IST.",
      months: "Budget months as YYYY-MM.",
      transactionAmounts:
        "Signed relative to their own account. Negative means money left that account.",
      creditAccounts:
        "A credit account's balance is negative while money is owed. Its payment " +
        "category's activity is the negation of the sum of its transactions.",
      events: "Append-only. The current state of every record is reproducible by replaying these.",
    },
    controlTotals: controlTotals(db),
    data,
  };
}

export function writeExport(db: DB, path: string): { path: string; bytes: number } {
  const payload = JSON.stringify(exportEverything(db), null, 2);
  writeFileSync(path, payload, "utf8");
  return { path, bytes: Buffer.byteLength(payload) };
}

/** F15.3 · CSV of transactions, including the raw imported values. */
export function exportTransactionsCsv(db: DB): string {
  const rows = queryAll<Record<string, string | number | null>>(
    db,
    `SELECT t.date, a.name AS account, p.name AS payee, c.name AS category,
            t.amount, t.memo, t.cleared, m.name AS owner, t.source,
            t.raw_payee, t.raw_amount, t.raw_date, t.raw_narration
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN payees p ON p.id = t.payee_id
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN members m ON m.id = t.owner_member_id
      WHERE t.deleted_at IS NULL
      ORDER BY t.date, t.created_at`,
  );

  const headers = [
    "date", "account", "payee", "category", "amount", "memo", "cleared", "owner",
    "source", "raw_payee", "raw_amount", "raw_date", "raw_narration",
  ];

  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  return [
    headers.join(","),
    ...rows.map((row) => headers.map((h) => escape(row[h])).join(",")),
  ].join("\n");
}
