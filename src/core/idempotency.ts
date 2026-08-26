/**
 * R36 · Idempotent writes.
 *
 * Every mutating request carries a client-generated key, stable across
 * retries. A repeat returns the *original* result rather than performing the
 * operation again — which is what makes "the server is the only truth"
 * survivable on a phone with two bars (`08` §4), and what guarantees the
 * success criterion "zero duplicate transactions created by a retry".
 *
 * Like the event log, this exists before any feature uses it: a key on every
 * write is a five-line change on day one and an archaeology project in
 * month six.
 */

import { createHash } from "node:crypto";
import type { DB } from "../db/db.ts";
import { transact } from "../db/db.ts";
import { nowIST, addDays, todayIST } from "./dates.ts";

/** R36.3: keys are retained for at least this long. */
export const KEY_RETENTION_DAYS = 7;

export interface IdempotentOutcome<T> {
  /** True when this response came from the store rather than fresh work. */
  replayed: boolean;
  statusCode: number;
  body: T;
}

export class IdempotencyConflict extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "IdempotencyConflict";
    this.statusCode = statusCode;
  }
}

/**
 * Canonical JSON: object keys sorted at every depth, so two payloads that mean
 * the same thing hash the same regardless of field order.
 */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(",")}}`;
}

export function hashRequest(method: string, path: string, payload: unknown): string {
  return createHash("sha256")
    .update(`${method} ${path} ${canonicalise(payload)}`)
    .digest("hex");
}

/**
 * Run `fn` at most once for this (key, member) pair.
 *
 * Returns the stored response on a repeat. Throws `IdempotencyConflict` when:
 *
 * - **409** the first attempt is still running. The client retries with the
 *   same key; it must not be told the write failed, because it may not have.
 * - **422** the same key arrives with a different payload. That is a client
 *   bug, and silently returning the first result would hide a real defect.
 */
export function withIdempotency<T>(
  db: DB,
  opts: { key: string | null; memberId: string; method: string; path: string; payload: unknown },
  fn: () => IdempotentOutcome<T> | { statusCode: number; body: T },
): IdempotentOutcome<T> {
  const { key, memberId, method, path, payload } = opts;

  // R36.1 requires a key on every mutation, but this helper stays usable for
  // internal callers (jobs, seeds) that have no client request behind them.
  if (!key) {
    const fresh = fn();
    return { replayed: false, statusCode: fresh.statusCode, body: fresh.body };
  }

  const requestHash = hashRequest(method, path, payload);

  const existing = db
    .prepare("SELECT * FROM idempotency_keys WHERE key = ? AND member_id = ?")
    .get(key, memberId) as
    | { status: string; request_hash: string; status_code: number | null; response_json: string | null }
    | undefined;

  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new IdempotencyConflict(
        "This idempotency key was already used for a different request.",
        422,
      );
    }
    if (existing.status === "in-progress") {
      throw new IdempotencyConflict("That request is still being processed.", 409);
    }
    return {
      replayed: true,
      statusCode: existing.status_code ?? 200,
      body: (existing.response_json ? JSON.parse(existing.response_json) : null) as T,
    };
  }

  // Claim the key in its own committed transaction, so a concurrent retry sees
  // "in-progress" rather than starting the work a second time.
  try {
    transact(db, () => {
      db.prepare(
        `INSERT INTO idempotency_keys (key, member_id, request_hash, status, created_at)
         VALUES (?,?,?,'in-progress',?)`,
      ).run(key, memberId, requestHash, nowIST());
    });
  } catch (err) {
    if (String((err as Error).message).includes("UNIQUE")) {
      throw new IdempotencyConflict("That request is still being processed.", 409);
    }
    throw err;
  }

  try {
    const fresh = fn();
    db.prepare(
      `UPDATE idempotency_keys SET status = 'done', status_code = ?, response_json = ?
        WHERE key = ? AND member_id = ?`,
    ).run(fresh.statusCode, JSON.stringify(fresh.body ?? null), key, memberId);
    return { replayed: false, statusCode: fresh.statusCode, body: fresh.body };
  } catch (err) {
    // The work failed, so the key must not stay claimed — a retry has to be
    // able to genuinely try again (R36.5).
    db.prepare("DELETE FROM idempotency_keys WHERE key = ? AND member_id = ?").run(key, memberId);
    throw err;
  }
}

/**
 * Drop keys past their retention window (R36.3). A repeat after expiry is
 * correctly treated as a new operation.
 */
export function pruneIdempotencyKeys(db: DB, today = todayIST()): number {
  const cutoff = addDays(today, -KEY_RETENTION_DAYS);
  const result = db.prepare("DELETE FROM idempotency_keys WHERE created_at < ?").run(cutoff);
  return Number(result.changes);
}

/**
 * F24.9: recent collisions, which are the fingerprint of a flaky network or a
 * client retry bug. Surfaced on the health page.
 */
export function recentKeyCount(db: DB, since: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE created_at >= ?")
    .get(since) as { n: number };
  return row.n;
}
