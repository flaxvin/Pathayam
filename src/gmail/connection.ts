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
 *
 * GMAIL-BYO · and, when the server has a SECRETS_KEY, sealed in the file
 * itself (secrets.ts). A token saved before the key was set stays readable as
 * it was; the next connect seals it.
 */

import type { DB } from "../db/db.ts";
import { transact, queryOne, execute } from "../db/db.ts";
import { appendEvent, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { Refusal } from "../core/refusal.ts";
import { seal, open, isSealed, SecretUnreadable } from "./secrets.ts";

export interface GmailConnection {
  member_id: string;
  email: string;
  refresh_token: string;
  scope: string;
  connected_at: string;
  last_fetched_at: string | null;
  last_history_id: string | null;
  /** GMAIL-BYO · The OAuth client that issued the token; null is the deployment's own. */
  client_id: string | null;
}

function tokenAad(memberId: string): string {
  return `gmail-refresh:${memberId}`;
}

/**
 * The refresh token, opened. A sealed token with no key, or the wrong one, is
 * a connection this server can no longer use: reconnecting is the fix.
 */
export function refreshTokenOf(connection: GmailConnection, key: Buffer | null): string {
  if (!isSealed(connection.refresh_token)) return connection.refresh_token;
  if (!key) throw new Refusal("The stored Gmail access cannot be opened without SECRETS_KEY. Disconnect and connect Gmail again.");
  try {
    return open(key, connection.refresh_token, tokenAad(connection.member_id));
  } catch (error) {
    if (error instanceof SecretUnreadable) {
      throw new Refusal("The stored Gmail access cannot be opened with this server's SECRETS_KEY. Disconnect and connect Gmail again.");
    }
    throw error;
  }
}

/** What a screen may see: never the token. */
export interface GmailConnectionView {
  email: string;
  connectedAt: string;
  lastFetchedAt: string | null;
}

export function saveConnection(
  db: DB, actor: Actor,
  input: { email: string; refreshToken: string; scope: string; clientId?: string | null },
  key: Buffer | null = null,
): void {
  const memberId = actor.memberId;
  if (!memberId) throw new Error("A connection belongs to a member.");
  const stored = key ? seal(key, input.refreshToken, tokenAad(memberId)) : input.refreshToken;

  transact(db, () => {
    execute(
      db,
      `INSERT INTO gmail_connections (member_id, email, refresh_token, scope, connected_at, client_id)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(member_id) DO UPDATE SET
         email = excluded.email, refresh_token = excluded.refresh_token,
         scope = excluded.scope, connected_at = excluded.connected_at,
         client_id = excluded.client_id,
         last_fetched_at = NULL, last_history_id = NULL`,
      memberId, input.email, stored, input.scope, nowIST(), input.clientId ?? null,
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
