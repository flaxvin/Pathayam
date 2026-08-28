/**
 * `04` §3.4 · Storing the Gmail connection.
 *
 * The refresh token is the sensitive part — read access to the mailbox — so it
 * lives under the same three rules as the statement identity, each enforced in
 * code rather than by intention:
 *
 *   · never in an export (F15 output travels; `ops/backup.ts` excludes it)
 *   · never in the event log (R37 keeps events forever)
 *   · never returned to a screen (only the email address and status are)
 */

import type { DB } from "../db/db.ts";
import { transact, queryOne, execute } from "../db/db.ts";
import { appendEvent, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";

export interface GmailConnection {
  member_id: string;
  email: string;
  refresh_token: string;
  scope: string;
  connected_at: string;
  last_fetched_at: string | null;
  last_history_id: string | null;
}

/** What a screen may see: never the token. */
export interface GmailConnectionView {
  email: string;
  connectedAt: string;
  lastFetchedAt: string | null;
}

export function saveConnection(
  db: DB, actor: Actor,
  input: { email: string; refreshToken: string; scope: string },
): void {
  const memberId = actor.memberId;
  if (!memberId) throw new Error("A connection belongs to a member.");

  transact(db, () => {
    execute(
      db,
      `INSERT INTO gmail_connections (member_id, email, refresh_token, scope, connected_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(member_id) DO UPDATE SET
         email = excluded.email, refresh_token = excluded.refresh_token,
         scope = excluded.scope, connected_at = excluded.connected_at,
         last_fetched_at = NULL, last_history_id = NULL`,
      memberId, input.email, input.refreshToken, input.scope, nowIST(),
    );
    // The address is logged; the token is not.
    appendEvent(db, actor, {
      entity: "gmail", entityId: memberId, action: "connect",
      after: { email: input.email },
      summary: `Connected Gmail (${input.email}) for statement and alert fetching`,
    });
  });
}

export function getConnection(db: DB, memberId: string): GmailConnection | null {
  return queryOne<GmailConnection>(
    db, `SELECT * FROM gmail_connections WHERE member_id = ?`, memberId,
  );
}

export function connectionView(db: DB, memberId: string): GmailConnectionView | null {
  const c = getConnection(db, memberId);
  return c
    ? { email: c.email, connectedAt: c.connected_at, lastFetchedAt: c.last_fetched_at }
    : null;
}

export function markFetched(db: DB, memberId: string, historyId: string | null): void {
  execute(
    db,
    `UPDATE gmail_connections SET last_fetched_at = ?, last_history_id = ? WHERE member_id = ?`,
    nowIST(), historyId, memberId,
  );
}

/** Revocation deletes the token (`04` §3.4). The remote revoke is the caller's. */
export function deleteConnection(db: DB, actor: Actor): void {
  const memberId = actor.memberId;
  if (!memberId) return;
  transact(db, () => {
    execute(db, `DELETE FROM gmail_connections WHERE member_id = ?`, memberId);
    appendEvent(db, actor, {
      entity: "gmail", entityId: memberId, action: "disconnect",
      summary: "Disconnected Gmail and deleted its stored access",
    });
  });
}
