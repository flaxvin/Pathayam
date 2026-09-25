/**
 * R38 · Members, sessions and impersonation.
 *
 * The allow-list is enforced on **every request**, not only at login (R38.16):
 * a member removed at 10:00 must not still be using the app at 10:05 because
 * their cookie is still valid.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, type Actor } from "../core/events.ts";
import { nowIST, todayIST, addDays } from "../core/dates.ts";
import { Missing, Refusal } from "../core/refusal.ts";

export interface Member {
  id: string;
  email: string;
  name: string;
  google_sub: string | null;
  avatar_url: string | null;
  theme: "light" | "dark" | "system";
  allowed: number;
  created_at: string;
  last_seen_at: string | null;
  removed_at: string | null;
}

export interface Session {
  id: string;
  member_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  user_agent: string | null;
  ip_hint: string | null;
  revoked_at: string | null;
  impersonating_member_id: string | null;
  impersonation_writes: number;
  impersonation_expires_at: string | null;
}

/** Everything a request handler needs to know about who is asking. */
export interface AuthContext {
  session: Session;
  /** The real person at the keyboard. */
  member: Member;
  /** Who the app is being viewed as — the same as `member` unless impersonating. */
  viewingAs: Member;
  impersonating: boolean;
  /** R38.10: impersonation is read-only unless explicitly toggled. */
  canWrite: boolean;
}

export const SESSION_COOKIE = "pathayam_session";

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export function listMembers(db: DB, opts: { includeRemoved?: boolean } = {}): Member[] {
  return queryAll<Member>(
    db,
    `SELECT * FROM members ${opts.includeRemoved ? "" : "WHERE removed_at IS NULL"} ORDER BY name`,
  );
}

export function getMember(db: DB, id: string): Member | null {
  return queryOne<Member>(db, `SELECT * FROM members WHERE id = ?`, id);
}

export function findMemberByEmail(db: DB, email: string): Member | null {
  return queryOne<Member>(db, `SELECT * FROM members WHERE email = ? COLLATE NOCASE`, email.trim());
}

export function memberCount(db: DB): number {
  return queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM members WHERE removed_at IS NULL`)?.n ?? 0;
}

/** F1.2: any existing member may edit the allow-list. All members are peers (P5). */
export function inviteMember(
  db: DB, actor: Actor, input: { email: string; name?: string },
): Member {
  return transact(db, () => {
    const email = input.email.trim().toLowerCase();
    const existing = findMemberByEmail(db, email);
    if (existing) {
      if (existing.removed_at) {
        execute(db, `UPDATE members SET removed_at = NULL, allowed = 1 WHERE id = ?`, existing.id);
        appendEvent(db, actor, {
          entity: "member", entityId: existing.id, action: "reinstate", before: existing,
          after: getMember(db, existing.id),
          summary: `Reinstated ${existing.name}`,
        });
        return getMember(db, existing.id)!;
      }
      return existing;
    }

    const id = newId();
    execute(
      db,
      `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
      id, email, input.name?.trim() || email.split("@")[0]!, nowIST(),
    );
    const member = getMember(db, id)!;
    appendEvent(db, actor, {
      entity: "member", entityId: id, action: "invite", after: member,
      summary: `Added ${email} to the household`,
    });
    return member;
  });
}

/** F1.6: removable, but every historical attribution is retained. */
export function removeMember(db: DB, actor: Actor, id: string): void {
  transact(db, () => {
    const before = getMember(db, id);
    if (!before) throw new Missing("That member does not exist.");
    if (memberCount(db) <= 1) {
      throw new Refusal("You cannot remove the last member — nobody would be able to sign in.");
    }
    execute(db, `UPDATE members SET removed_at = ?, allowed = 0 WHERE id = ?`, nowIST(), id);
    execute(db, `UPDATE sessions SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL`, nowIST(), id);
    appendEvent(db, actor, {
      entity: "member", entityId: id, action: "remove", before, after: getMember(db, id),
      summary: `Removed ${before.name} from the household`,
    });
  });
}

export function setTheme(db: DB, actor: Actor, memberId: string, theme: Member["theme"]): void {
  transact(db, () => {
    const before = getMember(db, memberId);
    if (!before) throw new Missing("That member does not exist.");
    execute(db, `UPDATE members SET theme = ? WHERE id = ?`, theme, memberId);
    appendEvent(db, actor, {
      entity: "member", entityId: memberId, action: "set-theme",
      before: { theme: before.theme }, after: { theme },
      summary: `Switched to the ${theme} theme`,
    });
  });
}

// ---------------------------------------------------------------------------
// Sessions — R38.13 to R38.16
// ---------------------------------------------------------------------------

/**
 * The cookie carries a random token; only its hash is stored. A stolen
 * database therefore does not hand over live sessions — which matters more
 * here than usual, since with no data on the device the session *is* the key
 * (R38.15).
 */
export function createSession(
  db: DB,
  memberId: string,
  opts: { userAgent?: string | null; ipHint?: string | null; days: number },
): { session: Session; token: string } {
  const token = randomBytes(32).toString("base64url");
  const id = hashToken(token);
  const now = nowIST();

  execute(
    db,
    `INSERT INTO sessions (id,member_id,created_at,last_seen_at,expires_at,user_agent,ip_hint)
     VALUES (?,?,?,?,?,?,?)`,
    id, memberId, now, now, addDays(todayIST(), opts.days),
    opts.userAgent?.slice(0, 200) ?? null,
    opts.ipHint ?? null,
  );
  execute(db, `UPDATE members SET last_seen_at = ? WHERE id = ?`, now, memberId);

  return { session: queryOne<Session>(db, `SELECT * FROM sessions WHERE id = ?`, id)!, token };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Resolve a cookie to an authenticated context, or null.
 *
 * Re-checks the allow-list every time (R38.16) and expires an impersonation
 * that has run past its window (R38.11).
 */
export function authenticate(db: DB, token: string | null, today = todayIST()): AuthContext | null {
  if (!token) return null;

  const session = queryOne<Session>(db, `SELECT * FROM sessions WHERE id = ?`, hashToken(token));
  if (!session || session.revoked_at) return null;
  if (session.expires_at < today) return null;

  const member = getMember(db, session.member_id);
  // The allow-list is authority on every request, not just at sign-in.
  if (!member || member.removed_at || !member.allowed) return null;

  let viewingAs = member;
  let impersonating = false;
  let canWrite = true;

  if (session.impersonating_member_id) {
    const expired =
      !session.impersonation_expires_at || session.impersonation_expires_at < nowIST();
    if (expired) {
      clearImpersonation(db, session.id);
    } else {
      const target = getMember(db, session.impersonating_member_id);
      if (target && !target.removed_at) {
        viewingAs = target;
        impersonating = true;
        // R38.10: read-only by default; writes need the in-session toggle.
        canWrite = session.impersonation_writes === 1;
      } else {
        clearImpersonation(db, session.id);
      }
    }
  }

  execute(db, `UPDATE sessions SET last_seen_at = ? WHERE id = ?`, nowIST(), session.id);

  return {
    session: queryOne<Session>(db, `SELECT * FROM sessions WHERE id = ?`, session.id)!,
    member,
    viewingAs,
    impersonating,
    canWrite,
  };
}

/** F1.7 / R38.14: listable and revocable per device. */
export function listSessions(db: DB, memberId: string): Session[] {
  return queryAll<Session>(
    db,
    `SELECT * FROM sessions WHERE member_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC`,
    memberId,
  );
}

export function revokeSession(db: DB, actor: Actor, sessionId: string): void {
  transact(db, () => {
    execute(db, `UPDATE sessions SET revoked_at = ? WHERE id = ?`, nowIST(), sessionId);
    appendEvent(db, actor, {
      entity: "session", entityId: sessionId, action: "revoke",
      summary: `Signed out a device`,
    });
  });
}

export function revokeAllSessions(
  db: DB, actor: Actor, memberId: string,
  /** Keep this one signed in — the device the request came from. */
  opts: { except?: string } = {},
): void {
  transact(db, () => {
    execute(
      db,
      `UPDATE sessions SET revoked_at = ?
        WHERE member_id = ? AND revoked_at IS NULL AND id IS NOT ?`,
      nowIST(), memberId, opts.except ?? null,
    );
    appendEvent(db, actor, {
      entity: "session", entityId: memberId, action: "revoke-all",
      summary: opts.except ? `Signed out every other device` : `Signed out every device`,
    });
  });
}

/** R35.5: expiry must leave nothing recoverable — there is nothing on the device to leave. */
export function pruneExpiredSessions(db: DB, today = todayIST()): number {
  return execute(db, `DELETE FROM sessions WHERE expires_at < ?`, addDays(today, -1));
}

// ---------------------------------------------------------------------------
// Impersonation — R38.6 to R38.12
// ---------------------------------------------------------------------------

export const IMPERSONATION_MINUTES = 30; // R38.11

export function startImpersonation(
  db: DB, actor: Actor, sessionId: string, targetMemberId: string,
): void {
  transact(db, () => {
    const target = getMember(db, targetMemberId);
    if (!target || target.removed_at) throw new Missing("That member does not exist.");

    // Built through nowIST so it is comparable with the timestamps this app
    // stores. A bare toISOString relabelled "+05:30" would be 5½ hours adrift
    // and the impersonation would lapse the instant it started.
    const expires = nowIST(new Date(Date.now() + IMPERSONATION_MINUTES * 60_000));
    execute(
      db,
      `UPDATE sessions SET impersonating_member_id = ?, impersonation_writes = 0,
              impersonation_expires_at = ? WHERE id = ?`,
      targetMemberId,
      expires,
      sessionId,
    );
    // R38.8: entering and leaving are both events.
    appendEvent(db, actor, {
      entity: "impersonation", entityId: sessionId, action: "start",
      after: { target: target.id },
      summary: `Started viewing as ${target.name} (read only)`,
    });
  });
}

export function setImpersonationWrites(db: DB, actor: Actor, sessionId: string, allow: boolean): void {
  transact(db, () => {
    execute(db, `UPDATE sessions SET impersonation_writes = ? WHERE id = ?`, allow ? 1 : 0, sessionId);
    appendEvent(db, actor, {
      entity: "impersonation", entityId: sessionId, action: allow ? "enable-writes" : "disable-writes",
      summary: allow
        ? `Enabled writes while viewing as another member`
        : `Returned to read-only while viewing as another member`,
    });
  });
}

export function stopImpersonation(db: DB, actor: Actor, sessionId: string): void {
  transact(db, () => {
    clearImpersonation(db, sessionId);
    appendEvent(db, actor, {
      entity: "impersonation", entityId: sessionId, action: "stop",
      summary: `Stopped viewing as another member`,
    });
  });
}

function clearImpersonation(db: DB, sessionId: string): void {
  execute(
    db,
    `UPDATE sessions SET impersonating_member_id = NULL, impersonation_writes = 0,
            impersonation_expires_at = NULL WHERE id = ?`,
    sessionId,
  );
}

/**
 * Build the Actor for a request. R38.9: a write made while impersonating
 * records **both** identities, so the audit trail never loses who actually
 * did it.
 */
export function actorFor(auth: AuthContext, source: Actor["source"] = "ui", idempotencyKey?: string | null): Actor {
  return {
    memberId: auth.viewingAs.id,
    realMemberId: auth.impersonating ? auth.member.id : null,
    source,
    idempotencyKey: idempotencyKey ?? null,
  };
}

// ---------------------------------------------------------------------------
// R38.16 · Rate limiting
// ---------------------------------------------------------------------------

export function recordAuthAttempt(db: DB, source: string, outcome: string, detail?: string): void {
  execute(
    db, `INSERT INTO auth_attempts (source, at, outcome, detail) VALUES (?,?,?,?)`,
    source, nowIST(), outcome, detail ?? null,
  );
}

export function isRateLimited(db: DB, source: string, limit = 10, windowMinutes = 15): boolean {
  const since = nowIST(new Date(Date.now() - windowMinutes * 60_000));
  const row = queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM auth_attempts WHERE source = ? AND at >= ? AND outcome != 'success'`,
    source, since,
  );
  return (row?.n ?? 0) >= limit;
}

export function pruneAuthAttempts(db: DB): number {
  const cutoff = addDays(todayIST(), -7);
  return execute(db, `DELETE FROM auth_attempts WHERE at < ?`, cutoff);
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key) out[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string, opts: { secure: boolean; days: number }): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly", // R38.13 — unreadable by scripts
    "SameSite=Lax",
    opts.secure ? "Secure" : "",
    `Max-Age=${opts.days * 86_400}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearedSessionCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    "Max-Age=0",
  ]
    .filter(Boolean)
    .join("; ");
}

/** Constant-time comparison, for CSRF-style tokens. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
