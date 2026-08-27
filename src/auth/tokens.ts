/**
 * `08` F30 · Personal API tokens.
 *
 * A member mints a named token for their own scripts. The design constraints
 * are all about limiting what a leaked one can do:
 *
 *   · **F30.4** — the secret is shown once and never retrievable. Only a hash
 *     is stored, so the database cannot give it back even to us.
 *   · **F30.6** — a token may not impersonate (R38.12), mint other tokens,
 *     change the allow-list, or read the dev-bypass state. This is enforced by
 *     a route deny-list rather than by remembering, because the failure mode of
 *     remembering is a new route that quietly becomes reachable.
 *   · **F30.5** — actions are attributed to the member *and* name the token,
 *     so the log answers "which of my scripts did this".
 *   · **F30.7** — rate-limited independently of session requests, so a runaway
 *     script cannot lock the household out of their own budget.
 *
 * The token itself is `bgt_` plus 32 random bytes in base64url. The prefix is
 * for the human reading a config file; the entropy is what matters.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, type Actor } from "../core/events.ts";
import { nowIST, todayIST, addDays, type IsoDate } from "../core/dates.ts";

export type TokenScope = "read" | "read-write";

export interface ApiToken {
  id: string;
  member_id: string;
  name: string;
  scope: TokenScope;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * F30.6 · What a token may never reach, whatever its scope.
 *
 * A deny-list of path prefixes rather than a note in a review checklist: a
 * token that could mint tokens turns one leak into permanent access, and a
 * token that could change the allow-list turns it into someone else's
 * household.
 */
const FORBIDDEN_PREFIXES = [
  "/settings/members",   // the allow-list (F30.6)
  "/tokens",             // minting more of itself (F30.6)
  "/impersonate",        // R38.12
  "/auth",               // sign-in, and the dev-bypass state (F30.6)
  "/signout",
];

export function tokenMayReach(path: string): boolean {
  return !FORBIDDEN_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

function hash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export interface MintedToken {
  token: ApiToken;
  /** F30.4 · Shown once, at creation, and never again. */
  secret: string;
}

export function mintToken(
  db: DB, actor: Actor,
  input: { name: string; scope: TokenScope; expiresInDays?: number | null },
): MintedToken {
  return transact(db, () => {
    const memberId = actor.memberId;
    if (!memberId) throw new Error("A token belongs to a member.");

    const secret = `bgt_${randomBytes(32).toString("base64url")}`;
    const id = newId();
    const expiresAt = input.expiresInDays
      ? addDays(todayIST(), input.expiresInDays)
      : null;

    execute(
      db,
      `INSERT INTO api_tokens (id,member_id,name,token_hash,scope,created_at,expires_at)
       VALUES (?,?,?,?,?,?,?)`,
      id, memberId, input.name, hash(secret), input.scope, nowIST(), expiresAt,
    );

    appendEvent(db, actor, {
      entity: "api-token", entityId: id, action: "create",
      // Deliberately not the secret, and not the hash: an event log is read by
      // people, and R37 keeps it forever.
      after: { name: input.name, scope: input.scope, expiresAt },
      summary:
        `Created the API token "${input.name}" (${input.scope})` +
        (expiresAt ? `, expiring ${expiresAt}` : ""),
    });

    return { token: getToken(db, id)!, secret };
  });
}

export function getToken(db: DB, id: string): ApiToken | null {
  return queryOne<ApiToken>(db, `SELECT * FROM api_tokens WHERE id = ?`, id);
}

/** F30.3 · Listable with created date, last-used date and scope. */
export function listTokens(db: DB, memberId: string): ApiToken[] {
  return queryAll<ApiToken>(
    db,
    `SELECT * FROM api_tokens WHERE member_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    memberId,
  );
}

export function revokeToken(db: DB, actor: Actor, id: string): void {
  transact(db, () => {
    const token = getToken(db, id);
    if (!token || token.member_id !== actor.memberId) {
      // A member may only revoke their own. Saying which of the two it was
      // would leak whether the id exists.
      throw new Error("That token does not exist.");
    }
    execute(db, `UPDATE api_tokens SET revoked_at = ? WHERE id = ?`, nowIST(), id);
    appendEvent(db, actor, {
      entity: "api-token", entityId: id, action: "revoke",
      summary: `Revoked the API token "${token.name}"`,
    });
  });
}

export interface TokenAuth {
  token: ApiToken;
  scope: TokenScope;
}

/**
 * Authenticate a bearer token.
 *
 * The lookup is by hash, so a timing difference cannot distinguish a valid
 * prefix from an invalid one, and the final comparison is constant-time
 * anyway. Revoked and expired tokens are indistinguishable from wrong ones.
 */
export function authenticateToken(
  db: DB, header: string | undefined, today: IsoDate = todayIST(),
): TokenAuth | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!match) return null;

  const digest = hash(match[1]!);
  const row = queryOne<ApiToken & { token_hash: string }>(
    db, `SELECT * FROM api_tokens WHERE token_hash = ?`, digest,
  );
  if (!row) return null;

  const a = Buffer.from(row.token_hash, "hex");
  const b = Buffer.from(digest, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  if (row.revoked_at) return null;
  if (row.expires_at && row.expires_at < today) return null;

  // F30.3 · Last-used, which is how a household spots a token they forgot
  // about. Written on every request; it is one indexed update.
  execute(db, `UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, nowIST(), row.id);

  return { token: row, scope: row.scope };
}

// ---------------------------------------------------------------------------
// F30.7 · Rate limiting, independent of sessions
// ---------------------------------------------------------------------------

/**
 * A fixed window per token.
 *
 * In memory rather than in the database: a rate limiter that writes a row per
 * request is a rate limiter that makes the problem worse. The deployment is one
 * process on one box (Q8), so there is nothing to share it with.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 120;
const buckets = new Map<string, { count: number; resetAt: number }>();

export interface RateLimit {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function checkTokenRateLimit(tokenId: string, now = Date.now()): RateLimit {
  const bucket = buckets.get(tokenId);

  if (!bucket || now >= bucket.resetAt) {
    buckets.set(tokenId, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: MAX_PER_WINDOW - 1, retryAfterSeconds: 0 };
  }

  bucket.count++;
  const remaining = Math.max(0, MAX_PER_WINDOW - bucket.count);
  return {
    allowed: bucket.count <= MAX_PER_WINDOW,
    remaining,
    retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
  };
}

/** For tests, and for a process that has been running long enough to leak. */
export function resetTokenRateLimits(): void {
  buckets.clear();
}
