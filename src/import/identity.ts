/**
 * `10` §3.6 · Storing what statement passwords are derived from.
 *
 * See `statement-passwords.ts` for why this is needed and migration `0010` for
 * why it reverses PR5. This file is only the storage, and it is deliberately
 * small — the interesting decisions are the three things it refuses to do:
 *
 *   · **Never in an export.** `08` F15 exports the whole budget in one action
 *     so it can be carried elsewhere. A PAN is not budget data and an export
 *     travels; `exportEverything` must not reach this table.
 *   · **Never in the event log.** R37 keeps events forever and shows them on
 *     the health page and in "explain this number". A summary saying the PAN
 *     changed is fine; the PAN itself is not.
 *   · **Never returned whole to a screen.** `maskedIdentity` is what the UI
 *     gets, so a shoulder-surfer or a screenshot cannot lift it.
 */

import type { DB } from "../db/db.ts";
import { transact, queryOne, execute } from "../db/db.ts";
import { appendEvent, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import type { StatementIdentity } from "./statement-passwords.ts";
import { Refusal } from "../core/refusal.ts";

/** Ten characters: five letters, four digits, one letter. */
export function looksLikePan(value: string): boolean {
  return /^[A-Za-z]{5}\d{4}[A-Za-z]$/.test(value.trim());
}

/** DDMMYYYY, with a real day and month. */
export function looksLikeDob(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 8) return false;
  const day = Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const year = Number(digits.slice(4));
  return day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 1900 && year <= 2100;
}

export function getIdentity(db: DB, memberId: string): StatementIdentity | null {
  const row = queryOne<{ name: string; pan: string | null; dob: string | null; mobile: string | null }>(
    db, `SELECT name, pan, dob, mobile FROM statement_identity WHERE member_id = ?`, memberId,
  );
  return row ? { name: row.name, pan: row.pan, dob: row.dob, mobile: row.mobile } : null;
}

export interface MaskedIdentity {
  name: string;
  /** `AMIP••••2L` — enough to recognise, not enough to use. */
  pan: string | null;
  /** `06/01/••••` — the DDMM half is what most banks want anyway. */
  dob: string | null;
  /** `•••••6620` — the last five, which is all SBI's rule reveals anyway. */
  mobile: string | null;
}

export function maskedIdentity(db: DB, memberId: string): MaskedIdentity | null {
  const identity = getIdentity(db, memberId);
  if (!identity) return null;

  return {
    name: identity.name,
    pan: identity.pan
      ? `${identity.pan.slice(0, 4).toUpperCase()}••••${identity.pan.slice(-2).toUpperCase()}`
      : null,
    dob: identity.dob ? `${identity.dob.slice(0, 2)}/${identity.dob.slice(2, 4)}/••••` : null,
    mobile: identity.mobile ? `•••••${identity.mobile.slice(-4)}` : null,
  };
}

export function setIdentity(
  db: DB, actor: Actor,
  input: { name: string; pan?: string | null; dob?: string | null; mobile?: string | null },
): void {
  const memberId = actor.memberId;
  if (!memberId) throw new Error("This belongs to a member.");

  const name = input.name.trim();
  if (name === "") throw new Refusal("A name is needed — it is what most passwords start with.");

  const pan = input.pan?.trim() || null;
  if (pan && !looksLikePan(pan)) {
    throw new Refusal("That does not look like a PAN. It is five letters, four digits, one letter.");
  }

  const dob = input.dob?.replace(/\D/g, "") || null;
  if (dob && !looksLikeDob(dob)) {
    throw new Refusal("Enter the date of birth as DDMMYYYY.");
  }

  const mobile = input.mobile?.replace(/\D/g, "") || null;
  if (mobile && (mobile.length < 10 || mobile.length > 12)) {
    throw new Refusal("Enter the full registered mobile number.");
  }

  transact(db, () => {
    execute(
      db,
      `INSERT INTO statement_identity (member_id, name, pan, dob, mobile, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(member_id) DO UPDATE SET
         name = excluded.name, pan = excluded.pan, dob = excluded.dob,
         mobile = excluded.mobile, updated_at = excluded.updated_at`,
      memberId, name, pan ? pan.toUpperCase() : null, dob, mobile, nowIST(),
    );

    // R37 · The change is logged; the values are not. `after` is deliberately
    // a set of booleans — the log is permanent and widely read.
    appendEvent(db, actor, {
      entity: "statement-identity", entityId: memberId, action: "set",
      after: { hasPan: pan !== null, hasDob: dob !== null, hasMobile: mobile !== null },
      summary: "Updated the details statement passwords are worked out from",
    });
  });
}

export function clearIdentity(db: DB, actor: Actor): void {
  const memberId = actor.memberId;
  if (!memberId) return;

  transact(db, () => {
    execute(db, `DELETE FROM statement_identity WHERE member_id = ?`, memberId);
    appendEvent(db, actor, {
      entity: "statement-identity", entityId: memberId, action: "clear",
      summary: "Removed the details statement passwords were worked out from",
    });
  });
}
