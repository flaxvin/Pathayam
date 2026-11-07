/**
 * AI-4 · What the AI connections have read.
 *
 * A token's `last_used_at` says a script is alive; for an AI connection the
 * household also wants to know *what* it asked — "did it read my
 * transactions, or only the budget?" — because every answer left the house.
 * One row per tool call: which connection, which tool, the arguments (the
 * question, not the answer), whether it succeeded and how big the answer was.
 * The answer itself is never stored; it would be a second copy of the
 * finances in a table nobody thinks of as sensitive.
 *
 * Kept out of the event log on purpose. Events are the budget's history —
 * undoable, replayed into "explain this number" (R37) — and a read changes
 * nothing; a few hundred of them a day would bury the activity a household
 * actually goes there to read.
 *
 * Each member sees only their own connections' rows. Bounded: rows older than
 * RETENTION_DAYS go, and at most MAX_ROWS_PER_MEMBER are kept.
 */

import type { DB } from "../db/db.ts";
import { execute, queryAll } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";

export const RETENTION_DAYS = 90;
export const MAX_ROWS_PER_MEMBER = 2000;
/** The arguments are a question; a long one is cut, not refused. */
const MAX_ARGS_CHARS = 500;

export interface AiAccessRow {
  id: number;
  token_id: string;
  token_name: string;
  tool: string;
  arguments: string;
  ok: number;
  bytes: number;
  at: string;
}

export function recordAiAccess(
  db: DB,
  entry: { tokenId: string; memberId: string; tool: string; args: Record<string, unknown>; ok: boolean; bytes: number },
): void {
  let args = JSON.stringify(entry.args);
  if (args.length > MAX_ARGS_CHARS) args = args.slice(0, MAX_ARGS_CHARS) + "…";
  execute(
    db,
    `INSERT INTO ai_access_log (token_id, member_id, tool, arguments, ok, bytes, at) VALUES (?,?,?,?,?,?,?)`,
    entry.tokenId, entry.memberId, entry.tool, args, entry.ok ? 1 : 0, entry.bytes, nowIST(),
  );
  prune(db, entry.memberId);
}

function prune(db: DB, memberId: string): void {
  // nowIST is "YYYY-MM-DDTHH:MM:SS…" in IST; SQLite's datetime() would be UTC,
  // so the cutoff is computed the same way the rows were stamped.
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
  const cutoffIst = nowIST(cutoff);
  execute(db, `DELETE FROM ai_access_log WHERE member_id = ? AND at < ?`, memberId, cutoffIst);
  execute(
    db,
    `DELETE FROM ai_access_log WHERE member_id = ? AND id NOT IN (
       SELECT id FROM ai_access_log WHERE member_id = ? ORDER BY id DESC LIMIT ?
     )`,
    memberId, memberId, MAX_ROWS_PER_MEMBER,
  );
}

/** The member's own connections' reads, newest first. */
export function listAiAccess(db: DB, memberId: string, limit = 50): AiAccessRow[] {
  return queryAll<AiAccessRow>(
    db,
    `SELECT l.id, l.token_id, t.name AS token_name, l.tool, l.arguments, l.ok, l.bytes, l.at
       FROM ai_access_log l JOIN api_tokens t ON t.id = l.token_id
      WHERE l.member_id = ?
      ORDER BY l.id DESC LIMIT ?`,
    memberId, limit,
  );
}
