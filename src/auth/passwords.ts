/**
 * Password sign-in, for a household that does not want a Google account in the
 * path to its own ledger.
 *
 * Until this existed, `GOOGLE_CLIENT_ID` was not optional in any meaningful
 * sense: a self-hosted install had exactly one way in, and it ran through a
 * company. That sat badly against what this app claims to be — the website
 * sells "I do not want my finances on someone else's server" — and it is the
 * single most requested thing on comparable self-hosted budgeting apps.
 *
 * ## The hash
 *
 * scrypt, from `node:crypto`, because the project has no runtime dependencies
 * and will not add one for this. scrypt is memory-hard, which is the property
 * that matters against an attacker holding the database file and a GPU.
 *
 * Parameters are stored *in* the encoded hash rather than in code, so raising
 * the cost later does not invalidate every existing password: an old hash keeps
 * verifying with the parameters it was made with, and is rewritten on the next
 * successful sign-in.
 *
 *   scrypt$N$r$p$<salt base64>$<key base64>
 *
 * ## What this module deliberately does not do
 *
 * It does not decide whether a password is *allowed* — length and rejection of
 * known-common passwords live in `assertUsablePassword`, which callers run
 * before hashing, so the rule is visible at the call site rather than buried in
 * a hash function.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Refusal } from "../core/refusal.ts";

/**
 * Cost. N=2^15 with r=8 is roughly 32 MB and tens of milliseconds per attempt
 * on the kind of machine this runs on — high enough to make offline guessing
 * expensive, low enough that a Raspberry Pi can still sign somebody in.
 */
const N = 32_768;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

/** scrypt needs to be told it may use the memory its parameters imply. */
const MAX_MEMORY = 256 * 1024 * 1024;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(password.normalize("NFKC"), salt, KEY_BYTES, {
    N, r: R, p: P, maxmem: MAX_MEMORY,
  });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/**
 * Constant-time against the stored key. A malformed or unknown-algorithm hash
 * is a failed verification rather than a throw: a row corrupted or written by
 * some future version must not become an exception on the sign-in path.
 */
export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // A hostile row could otherwise name parameters that exhaust memory here.
  if (n < 1024 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64");
    expected = Buffer.from(parts[5]!, "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = scryptSync(password.normalize("NFKC"), salt, expected.length, {
      N: n, r, p, maxmem: MAX_MEMORY,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** True when the hash was made with weaker parameters than we now use. */
export function needsRehash(encoded: string): boolean {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return Number(parts[1]) < N || Number(parts[2]) < R || Number(parts[3]) < P;
}

/**
 * The twenty passwords that a household actually picks, and that any attacker
 * tries first. Not a substitute for a real breach corpus — which would be a
 * dependency and a download — but it catches the ones a short minimum still
 * lets through.
 */
const REFUSED = new Set([
  // Short ones. These cannot pass the length rule either, but naming them
  // gives a more useful answer than "too short" to somebody who tried one.
  "password", "password1", "password123", "12345678", "123456789", "1234567890",
  "qwertyui", "qwerty123", "iloveyou", "abc12345", "welcome1", "admin123",
  "letmein1", "trustno1", "passw0rd", "p@ssw0rd", "money123", "budget123",
  "pathayam", "changeme",
  // Long enough to satisfy the minimum, and still among the first things
  // tried. Without these the length rule is the only real barrier, and
  // "passwordpassword" walks through it.
  "passwordpassword", "password1234", "passw0rd1234", "123456789012",
  "qwertyuiopas", "qwertyuiop123", "iloveyouiloveyou", "letmeinletmein",
  "administrator", "pathayam1234", "budgetbudget", "changemechangeme",
  "welcometothejungle", "correcthorsebatterystaple",
]);

/*
 * A Refusal, not an Error: this is the app declining something a person did,
 * which is a 422 with the reason shown to them — not a fault, which is a 500
 * with a stack trace and no explanation.
 */
export class WeakPassword extends Refusal {}

/**
 * Length first, because it is the rule that actually carries the entropy, and
 * a minimum of twelve on a household app is not the imposition that the same
 * minimum is on a public signup.
 */
export function assertUsablePassword(password: string): void {
  const p = password.normalize("NFKC");
  /*
   * Named passwords first, then length.
   *
   * The other way round, every entry shorter than the minimum was unreachable
   * — the length rule answered first and the list was decoration. It also
   * means somebody who typed "password123" is told what is actually wrong with
   * it rather than being sent off to add a character.
   */
  if (REFUSED.has(p.toLowerCase())) {
    throw new WeakPassword("That is one of the first passwords anybody tries. Pick another.");
  }
  if (/^(.)\1+$/.test(p)) {
    throw new WeakPassword("That password is one character repeated.");
  }
  if (p.length < 12) {
    throw new WeakPassword("A password needs at least 12 characters. Length is what makes one hard to guess — a phrase of three or four words beats a short one with symbols in it.");
  }
  if (p.length > 1024) {
    throw new WeakPassword("That password is longer than 1024 characters.");
  }
}

// ---------------------------------------------------------------------------
// Storage
//
// The hash lives in `member_passwords`, never on the member row, so the
// object that flows through view models and exports has no field that could
// carry it.
// ---------------------------------------------------------------------------

import type { DB } from "../db/db.ts";
import { execute, queryOne, queryAll } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";

/** How many wrong guesses before a credential is locked, and for how long. */
const MAX_FAILURES = 8;
const LOCK_MINUTES = 15;

export interface PasswordRow {
  member_id: string;
  hash: string;
  must_change: number;
  failed_count: number;
  locked_until: string | null;
}

export function getPasswordRow(db: DB, memberId: string): PasswordRow | null {
  return queryOne<PasswordRow>(
    db,
    `SELECT member_id, hash, must_change, failed_count, locked_until
       FROM member_passwords WHERE member_id = ?`,
    memberId,
  );
}

export function hasPassword(db: DB, memberId: string): boolean {
  return getPasswordRow(db, memberId) !== null;
}

/** Any password at all in this household — what decides if the form is offered. */
export function anyPasswordSet(db: DB): boolean {
  return queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM member_passwords`)!.n > 0;
}

export function setPassword(
  db: DB, memberId: string, password: string, opts: { mustChange?: boolean } = {},
): void {
  assertUsablePassword(password);
  execute(
    db,
    `INSERT INTO member_passwords (member_id, hash, must_change, updated_at, failed_count, locked_until)
     VALUES (?, ?, ?, ?, 0, NULL)
     ON CONFLICT(member_id) DO UPDATE SET
       hash = excluded.hash, must_change = excluded.must_change,
       updated_at = excluded.updated_at, failed_count = 0, locked_until = NULL`,
    memberId, hashPassword(password), opts.mustChange ? 1 : 0, nowIST(),
  );
}

export function clearPassword(db: DB, memberId: string): void {
  execute(db, `DELETE FROM member_passwords WHERE member_id = ?`, memberId);
}

export type PasswordCheck =
  | { ok: true; mustChange: boolean }
  | { ok: false; reason: "no-password" | "wrong" | "locked"; lockedUntil?: string };

/**
 * Verify, and account for the attempt.
 *
 * Lockout is counted against the credential rather than the caller's address.
 * Rate limiting by IP already exists and is the right tool against a flood from
 * one place; it is the wrong tool against somebody patient with a lot of
 * addresses, which is the case that actually gets a password.
 */
export function checkPassword(db: DB, memberId: string, password: string): PasswordCheck {
  const row = getPasswordRow(db, memberId);
  if (!row) return { ok: false, reason: "no-password" };

  const now = nowIST();
  if (row.locked_until && row.locked_until > now) {
    return { ok: false, reason: "locked", lockedUntil: row.locked_until };
  }

  if (!verifyPassword(password, row.hash)) {
    const failures = row.failed_count + 1;
    /*
     * Written with nowIST, not toISOString. Both sides of the comparison below
     * have to be the same shape: these timestamps are compared as strings, and
     * "…Z" against "…+05:30" compares character by character to an answer that
     * means nothing. The first version of this stored the lock in UTC and
     * compared it against IST, and the correct password walked straight
     * through a locked credential.
     */
    const lockUntil = failures >= MAX_FAILURES
      ? nowIST(new Date(Date.now() + LOCK_MINUTES * 60_000))
      : null;
    execute(
      db,
      `UPDATE member_passwords SET failed_count = ?, locked_until = ? WHERE member_id = ?`,
      lockUntil ? 0 : failures, lockUntil, memberId,
    );
    return lockUntil
      ? { ok: false, reason: "locked", lockedUntil: lockUntil }
      : { ok: false, reason: "wrong" };
  }

  // Correct. Clear the count, and take the opportunity to move an old hash on
  // to current parameters now that the plaintext is in hand and verified.
  if (needsRehash(row.hash)) {
    execute(
      db,
      `UPDATE member_passwords SET hash = ?, updated_at = ?, failed_count = 0, locked_until = NULL WHERE member_id = ?`,
      hashPassword(password), nowIST(), memberId,
    );
  } else if (row.failed_count !== 0 || row.locked_until !== null) {
    execute(
      db,
      `UPDATE member_passwords SET failed_count = 0, locked_until = NULL WHERE member_id = ?`,
      memberId,
    );
  }
  return { ok: true, mustChange: row.must_change === 1 };
}

/**
 * The same answer, for an address that has no password to check.
 *
 * Lockout used to exist only for members with a password: their eighth wrong
 * guess answered 429 "locked", while an address that is not a member answered
 * 401 for ever. Eight guesses at any address therefore said whether it belonged
 * to this household — the one thing the identical refusal wording was there to
 * hide. (It answered faster, too: no scrypt ran.)
 *
 * So an unknown address — no member, a removed or disallowed one, or a member
 * with no password — gets the same state machine as a credential: eight
 * failures lock it for fifteen minutes, and the count resets when the lock is
 * set. There is no row to keep the count in, and none is added: it is replayed
 * from `auth_attempts`, where every one of these refusals is already recorded
 * with the address as its detail ('bad-password' before the lock, 'locked' for
 * the attempt that sets it and those refused during it). The attempts table is
 * pruned after seven days, which forgets a count a member's row would keep; a
 * gap of a week between guesses is not a probe anyone runs.
 *
 * The caller records this attempt afterwards, exactly as for a member.
 */
export function checkAbsentPassword(db: DB, address: string, password: string): PasswordCheck {
  const rows = queryAll<{ at: string }>(
    db,
    `SELECT at FROM auth_attempts
      WHERE detail = ? AND outcome IN ('bad-password', 'locked') ORDER BY id`,
    address,
  );
  const lockFrom = (at: string) =>
    nowIST(new Date(Date.parse(at) + LOCK_MINUTES * 60_000));
  let failures = 0;
  let lockedUntil: string | null = null;
  for (const { at } of rows) {
    if (lockedUntil && at < lockedUntil) continue; // refused while locked; not a guess
    failures += 1;
    if (failures >= MAX_FAILURES) { lockedUntil = lockFrom(at); failures = 0; }
  }

  const now = nowIST();
  if (lockedUntil && lockedUntil > now) return { ok: false, reason: "locked", lockedUntil };

  // Spend what a real check spends, so the time taken says nothing either.
  decoyHash ??= hashPassword("pathayam decoy — never a real credential");
  verifyPassword(password, decoyHash);

  return failures + 1 >= MAX_FAILURES
    ? { ok: false, reason: "locked", lockedUntil: lockFrom(now) }
    : { ok: false, reason: "wrong" };
}
let decoyHash: string | null = null;
