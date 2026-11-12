/**
 * FWD-1 · A member's forwarding address.
 *
 * The address is `<route>.<token>@<domain>`, or `<token>@<domain>` where the
 * receiver serves this household alone (INBOUND_ROUTE empty). The route says
 * which household's app the receiver hands the message to; the token says
 * which member it is for, and is the only thing that lets mail in. It is 160
 * random bits, so it cannot be guessed, and a member who thinks it has leaked
 * replaces it: the old address stops working at once.
 *
 * Kept in the database as itself, not hashed: Settings shows it every time,
 * and anybody holding the database already holds everything the address could
 * be used to reach. It is never exported (ops/backup.ts, NEVER_EXPORTED).
 */

import { randomBytes } from "node:crypto";
import type { DB } from "../db/db.ts";
import { execute, queryOne, transact } from "../db/db.ts";
import { appendEvent, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import type { Config } from "../config.ts";

export interface ForwardingAddressRow {
  member_id: string;
  token: string;
  created_at: string;
  last_received_at: string | null;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** 160 random bits as 32 lowercase base32 characters: safe in any mail client. */
export function newToken(): string {
  const bytes = randomBytes(20);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export function addressRow(db: DB, memberId: string): ForwardingAddressRow | null {
  return queryOne<ForwardingAddressRow>(
    db, `SELECT * FROM forwarding_addresses WHERE member_id = ?`, memberId,
  );
}

/** The address as the member types it into their mail filter. */
export function formatAddress(inbound: Config["inbound"], token: string): string | null {
  if (!inbound.domain) return null;
  return `${inbound.route ? `${inbound.route}.` : ""}${token}@${inbound.domain}`;
}

/**
 * The token in a recipient the receiver handed over, when it is for this
 * household: the right domain, this household's route, and a well-formed
 * token. Null otherwise. A `+tag` is dropped, as the receiver drops it.
 */
export function tokenFromRecipient(inbound: Config["inbound"], recipient: string): string | null {
  const at = recipient.lastIndexOf("@");
  if (at < 0 || !inbound.domain) return null;
  const domain = recipient.slice(at + 1).toLowerCase();
  if (domain !== inbound.domain) return null;
  const local = recipient.slice(0, at).toLowerCase().replace(/\+.*$/, "");
  const prefix = inbound.route ? `${inbound.route}.` : "";
  if (!local.startsWith(prefix)) return null;
  const token = local.slice(prefix.length);
  return /^[a-z2-7]{32}$/.test(token) ? token : null;
}

/** MAIL-6 · Only a current member's: a removed member's address takes nothing. */
export function memberForToken(db: DB, token: string): string | null {
  return queryOne<{ member_id: string }>(
    db,
    `SELECT f.member_id FROM forwarding_addresses f JOIN members m ON m.id = f.member_id
      WHERE f.token = ? AND m.removed_at IS NULL`,
    token,
  )?.member_id ?? null;
}

/**
 * Make the member's address, or replace it. The event says that it happened,
 * never the token: the event log is kept forever and travels in an export.
 */
export function issueAddress(db: DB, actor: Actor): ForwardingAddressRow {
  const memberId = actor.memberId;
  if (!memberId) throw new Error("A forwarding address belongs to a member.");
  return transact(db, () => {
    const replacing = addressRow(db, memberId) !== null;
    execute(
      db,
      `INSERT INTO forwarding_addresses (member_id, token, created_at) VALUES (?,?,?)
       ON CONFLICT(member_id) DO UPDATE SET
         token = excluded.token, created_at = excluded.created_at, last_received_at = NULL`,
      memberId, newToken(), nowIST(),
    );
    appendEvent(db, actor, {
      entity: "forwarding", entityId: memberId, action: replacing ? "rotate" : "create",
      summary: replacing
        ? "Replaced the forwarding address; the old one no longer takes mail"
        : "Made a forwarding address for bank mail",
    });
    return addressRow(db, memberId)!;
  });
}

/** Turn the address off: mail to it is refused from now on. */
export function removeAddress(db: DB, actor: Actor): void {
  const memberId = actor.memberId;
  if (!memberId) return;
  transact(db, () => {
    const removed = execute(db, `DELETE FROM forwarding_addresses WHERE member_id = ?`, memberId);
    if (removed > 0) {
      appendEvent(db, actor, {
        entity: "forwarding", entityId: memberId, action: "remove",
        summary: "Turned off the forwarding address",
      });
    }
  });
}

export function markReceived(db: DB, memberId: string): void {
  execute(db, `UPDATE forwarding_addresses SET last_received_at = ? WHERE member_id = ?`, nowIST(), memberId);
}
