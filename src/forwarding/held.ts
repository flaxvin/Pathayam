/**
 * FWD-4 · Locked statements waiting for a password, and the 90-day rule.
 *
 * A Gmail fetch leaves a statement it could not open in the mailbox and reads
 * it again next time. A forwarded one arrives once, so its PDF is kept here —
 * sealed with SECRETS_KEY, bound to its row — until the member enters the
 * detail its bank's password needs and presses "Try again". It is deleted when
 * it opens, when the member deletes it, or at 90 days, whichever comes first.
 *
 * The 90 days is a promise on the pricing page, not a setting:
 * `purgeForwarded` runs with the rest of housekeeping and takes the log with it.
 */

import type { DB } from "../db/db.ts";
import { execute, newId, queryAll, queryOne } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { open, seal, SecretUnreadable } from "../gmail/secrets.ts";
import { emptyFetchResult, startMailIngest, type FetchResult } from "../gmail/fetch.ts";

/** How long anything forwarded is kept: the pricing page's promise. */
export const FORWARDED_RETENTION_DAYS = 90;

export interface HeldStatement {
  id: string;
  received_at: string;
  sender: string;
  filename: string;
}

export interface ForwardedMailRow {
  id: string;
  received_at: string;
  sender: string;
  subject: string;
  signed: number;
  outcome: string;
  detail: string | null;
  confirmation: string | null;
}

const aad = (id: string, memberId: string) => `forwarded-statement:${id}:${memberId}`;

/** Keep a locked statement, sealed. False (and nothing kept) without a key. */
export function holdStatement(
  db: DB, secretsKey: Buffer | null, memberId: string,
  pdf: { filename: string; bytes: Uint8Array; sender: string }, now?: Date,
): boolean {
  if (!secretsKey) return false;
  const id = newId();
  execute(
    db,
    `INSERT INTO forwarded_statements (id, member_id, received_at, sender, filename, sealed)
     VALUES (?,?,?,?,?,?)`,
    id, memberId, nowIST(now), pdf.sender, pdf.filename.slice(0, 200),
    seal(secretsKey, Buffer.from(pdf.bytes).toString("base64"), aad(id, memberId)),
  );
  return true;
}

export function listHeld(db: DB, memberId: string): HeldStatement[] {
  return queryAll<HeldStatement>(
    db,
    `SELECT id, received_at, sender, filename FROM forwarded_statements
      WHERE member_id = ? ORDER BY received_at DESC`,
    memberId,
  );
}

export function deleteHeld(db: DB, memberId: string, id: string): boolean {
  return execute(db, `DELETE FROM forwarded_statements WHERE id = ? AND member_id = ?`, id, memberId) > 0;
}

/**
 * Try every statement this member has waiting, with whatever details are on
 * file now. Each one that opens is imported and deleted; the rest wait.
 */
export async function retryHeld(
  db: DB, actor: Actor, secretsKey: Buffer | null,
): Promise<{ result: FetchResult; opened: number; still: number; unreadable: number }> {
  const memberId = actor.memberId;
  if (!memberId) throw new Error("Trying statements needs a member.");
  const result = emptyFetchResult();
  let opened = 0;
  let still = 0;
  let unreadable = 0;
  const rows = queryAll<HeldStatement & { sealed: string }>(
    db, `SELECT * FROM forwarded_statements WHERE member_id = ? ORDER BY received_at`, memberId,
  );
  for (const row of rows) {
    let bytes: Uint8Array;
    try {
      if (!secretsKey) throw new SecretUnreadable();
      bytes = new Uint8Array(Buffer.from(open(secretsKey, row.sealed, aad(row.id, memberId)), "base64"));
    } catch (error) {
      // SECRETS_KEY changed or was unset: this copy cannot come back, and it
      // is not left to look as if it might.
      if (!(error instanceof SecretUnreadable)) throw error;
      unreadable++;
      continue;
    }
    let locked = false;
    const run = startMailIngest(db, actor, result, { onLocked: () => { locked = true; } });
    result.scanned++;
    await run.message({
      sender: row.sender, subject: "", received: undefined, body: () => "",
      pdfs: [{ filename: row.filename, load: async () => bytes }],
    });
    run.finish();
    if (locked) { still++; continue; }
    deleteHeld(db, memberId, row.id);
    opened++;
  }
  return { result, opened, still, unreadable };
}

export function listForwardedMail(db: DB, memberId: string, limit = 20): ForwardedMailRow[] {
  return queryAll<ForwardedMailRow>(
    db,
    `SELECT id, received_at, sender, subject, signed, outcome, detail, confirmation
       FROM forwarded_mail WHERE member_id = ? ORDER BY received_at DESC, rowid DESC LIMIT ?`,
    memberId, limit,
  );
}

/** Gmail's latest "confirm forwarding" code for this member, from the last week. */
export function pendingConfirmation(
  db: DB, memberId: string, now: Date = new Date(),
): { code: string; link: string | null; receivedAt: string } | null {
  const since = nowIST(new Date(now.getTime() - 7 * 86_400_000));
  const row = queryOne<{ confirmation: string; detail: string | null; received_at: string }>(
    db,
    `SELECT confirmation, detail, received_at FROM forwarded_mail
      WHERE member_id = ? AND outcome = 'confirmation' AND received_at >= ?
      ORDER BY received_at DESC LIMIT 1`,
    memberId, since,
  );
  return row ? { code: row.confirmation, link: row.detail, receivedAt: row.received_at } : null;
}

/** Delete everything forwarded more than 90 days ago. Returns the rows removed. */
export function purgeForwarded(db: DB, now: Date = new Date()): number {
  const cutoff = nowIST(new Date(now.getTime() - FORWARDED_RETENTION_DAYS * 86_400_000));
  return execute(db, `DELETE FROM forwarded_statements WHERE received_at < ?`, cutoff)
    + execute(db, `DELETE FROM forwarded_mail WHERE received_at < ?`, cutoff);
}
