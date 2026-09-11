/**
 * B66 · The record of a request that failed.
 *
 * Two reasonable decisions combined into a blind spot. `http/server.ts` logs
 * the error and its stack — but only in the branch it takes when no `onError`
 * hook handled the failure, and `main.ts` installs one that handles every
 * error so the household sees a styled page instead of bare text. The only
 * remaining trace was the request line, which is logged at `debug`, and
 * `logLevel` defaults to `info` in production. Meanwhile the health page's
 * "errors in the last 24 hours" counted `job_runs` — scheduled jobs only.
 *
 * So a route that threw in production produced no log line and no signal on
 * the one page you open when something is wrong. This module is the missing
 * record: written from the error hook, read by the health page.
 *
 * S7 still applies. A method, a path and the error's own message and stack —
 * never a request body, never a financial value, never a query string, which
 * is the one part of a URL that carries user input.
 */

import type { DB } from "../db/db.ts";
import { newId, execute, queryOne, queryAll } from "../db/db.ts";
import { nowIST, addDays, todayIST } from "../core/dates.ts";

export interface RequestFailure {
  id: string;
  at: string;
  method: string;
  path: string;
  status: number;
  message: string | null;
  stack: string | null;
}

/** How long a failure is kept. Long enough to notice, short enough to bound. */
const KEEP_DAYS = 30;

export function recordRequestFailure(
  db: DB,
  input: { method: string; path: string; status: number; error: unknown },
): void {
  const err = input.error;
  execute(
    db,
    `INSERT INTO request_failures (id, at, method, path, status, message, stack)
     VALUES (?,?,?,?,?,?,?)`,
    newId(),
    nowIST(),
    input.method,
    // Defence in depth: the caller passes a pathname, but a query string here
    // would put user input in a durable record.
    input.path.split("?")[0]!,
    input.status,
    err instanceof Error ? err.message : String(err),
    err instanceof Error ? (err.stack ?? null) : null,
  );
}

export function countRequestFailures(db: DB, sinceDays = 1): number {
  return (
    queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM request_failures WHERE at >= ?`,
      addDays(todayIST(), -sinceDays),
    )?.n ?? 0
  );
}

/** The most recent failures, for the health page to name what actually broke. */
export function recentRequestFailures(db: DB, limit = 5): RequestFailure[] {
  return queryAll<RequestFailure>(
    db,
    `SELECT * FROM request_failures ORDER BY at DESC LIMIT ?`,
    limit,
  );
}

export function pruneRequestFailures(db: DB): number {
  return execute(
    db,
    `DELETE FROM request_failures WHERE at < ?`,
    addDays(todayIST(), -KEEP_DAYS),
  );
}
