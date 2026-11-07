/**
 * IMP-18 · Up to the last eight digits of a card account's number.
 *
 * `accounts.last4` is what SMS alerts are matched by and what every screen
 * prints ("····6604"), so it stays four. A card statement can want more — HSBC
 * locks one with the last six — so a card account may also record five to
 * eight trailing digits, kept in `card_number_digits` (migration 0069).
 *
 * They are a statement-password ingredient, under statement_identity's rules:
 * never exported, never in the event log (an event here says only that the
 * digits changed, and how many there are), and never shown whole — a screen
 * gets `maskedCardNumber`.
 */

import type { DB } from "../db/db.ts";
import { transact, queryOne, execute } from "../db/db.ts";
import { appendEvent, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { Refusal } from "../core/refusal.ts";
import { getAccount, updateAccount } from "./accounts.ts";

/** The most trailing digits a card account records. */
export const MAX_CARD_DIGITS = 8;

/**
 * A typed card number, read: four to eight digits on a card account, exactly
 * four on any other. Spaces and dashes are let go. Undefined when the field
 * was not sent, null when it was sent empty. The refusal never repeats what
 * was typed — it may be most of a card number.
 */
export function parseCardNumber(
  raw: string | undefined, opts: { card: boolean },
): string | null | undefined {
  if (raw === undefined) return undefined;
  const digits = raw.replace(/[\s-]/g, "");
  if (digits === "") return null;
  const max = opts.card ? MAX_CARD_DIGITS : 4;
  if (!/^\d+$/.test(digits) || digits.length < 4 || digits.length > max) {
    throw new Refusal(opts.card
      ? "Enter the card number's last four to eight digits, like 6604, or leave it empty."
      : "Enter the last four digits, like 6604, or leave it empty.");
  }
  return digits;
}

/** The longest run of this account's trailing digits on file: the stored digits, else last4. */
export function cardNumberDigits(db: DB, accountId: string): string | null {
  return storedDigits(db, accountId) ?? getAccount(db, accountId)?.last4 ?? null;
}

/**
 * The longer run, only while it still ends in the account's last four: an
 * undone edit puts last4 back without touching this table, and digits for a
 * number the account no longer has are not that card's.
 */
function storedDigits(db: DB, accountId: string): string | null {
  return queryOne<{ digits: string }>(
    db,
    `SELECT d.digits FROM card_number_digits d JOIN accounts a ON a.id = d.account_id
      WHERE d.account_id = ? AND substr(d.digits, -4) = a.last4`,
    accountId,
  )?.digits ?? null;
}

/** For a screen: how many digits are on file and the last two, never more. */
export function maskedCardNumber(db: DB, accountId: string): { count: number; tail: string } | null {
  const stored = storedDigits(db, accountId);
  return stored ? { count: stored.length, tail: stored.slice(-2) } : null;
}

/**
 * Keep (or drop) the longer run beside an account whose last4 is already
 * right. `digits` of four or fewer, or null, drops it. Logged without values.
 */
export function keepLongerCardDigits(
  db: DB, actor: Actor, accountId: string, digits: string | null,
): void {
  transact(db, () => {
    const before = queryOne<{ digits: string }>(
      db, `SELECT digits FROM card_number_digits WHERE account_id = ?`, accountId,
    )?.digits ?? null;
    const next = digits && digits.length > 4 ? digits : null;
    if (next === before) return;
    if (next) {
      const last4 = getAccount(db, accountId)?.last4;
      if (last4 !== next.slice(-4)) throw new Error("The account's last four must match the digits kept.");
      execute(
        db,
        `INSERT INTO card_number_digits (account_id, digits, updated_at) VALUES (?,?,?)
         ON CONFLICT(account_id) DO UPDATE SET digits = excluded.digits, updated_at = excluded.updated_at`,
        accountId, next, nowIST(),
      );
    } else {
      execute(db, `DELETE FROM card_number_digits WHERE account_id = ?`, accountId);
    }
    // R37 · That they changed, and how many there are; never which.
    appendEvent(db, actor, {
      entity: "card-number-digits", entityId: accountId, action: "set",
      after: { digitCount: next?.length ?? 0 },
      summary: next
        ? `Recorded the card's last ${next.length} digits`
        : "Removed the card's longer digits",
    });
  });
}

/**
 * Record the card's trailing digits in full: last4 becomes their last four
 * (through updateAccount, so the edit is undoable as any other), and a run
 * longer than four is kept beside it.
 */
export function setCardNumberDigits(db: DB, actor: Actor, accountId: string, digits: string): void {
  const clean = parseCardNumber(digits, { card: true });
  if (!clean) throw new Refusal("Enter the card number's last four to eight digits.");
  transact(db, () => {
    const last4 = clean.slice(-4);
    if (getAccount(db, accountId)?.last4 !== last4) updateAccount(db, actor, accountId, { last4 });
    keepLongerCardDigits(db, actor, accountId, clean);
  });
}
