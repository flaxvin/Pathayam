/**
 * One-time links that set a member's first password.
 *
 * A household that signs in with passwords alone had no way to give a new
 * member one. Inviting Priya said she "can now sign in"; she had no password,
 * /settings/password needs a session she could not get, and /auth/first-run
 * — the only door that sets a password without a session — closes as soon as
 * the household has anybody in it. Removing a member clears their password, so
 * adding somebody back left them in exactly the same place.
 *
 * So another member makes a link, hands it over however the household talks
 * to itself, and the link sets a password once.
 *
 * ## The token
 *
 * 32 random bytes, base64url: 256 bits, which nobody guesses. Only its SHA-256
 * is stored — the same rule sessions and API tokens follow — so a copy of the
 * database, a backup or an export does not hold a working link. It is shown
 * once, on the page that made it (or printed by the server command), and
 * travels nowhere else: not in a redirect, not in a notice, not in the event
 * log.
 *
 * It lasts 72 hours — long enough for a weekend, short enough that a link
 * sitting forgotten in a chat is not a standing way in — and works once.
 * Making a new link for the same member deletes the earlier unused ones, so
 * "I made you another one" never leaves two in circulation.
 *
 * ## Who may make one, and why it is narrower than "any member"
 *
 * Every member is a peer (P5) and may already add anybody to the household, so
 * any member may make a link for another — with four exceptions, each of
 * which would otherwise turn a link into a way to become somebody else:
 *
 *   · Not for yourself. You have a session; /settings/password is the door.
 *   · Not for somebody who already has a password. A link sets a password
 *     without asking for the old one, so it would be a reset — and a reset
 *     you can perform on another member is a takeover. They change their own
 *     in Settings; a forgotten one is the server command's job.
 *   · Not for somebody who has ever signed in. A member who uses Google or
 *     OIDC has no password, but a link would still add a way in behind their
 *     back. Only somebody who has never been in is a newcomer.
 *   · Not for somebody holding records the issuer cannot see. Whoever makes
 *     the link can use it themselves instead of handing it over, set the
 *     password, sign in as that member and read everything private to them —
 *     their private accounts, their personal budget, the PAN and date of birth
 *     their statement passwords are worked out from. The privacy model
 *     (docs/privacy.md) would then hold only as long as nobody pressed a
 *     button. For such a member the link comes from whoever runs the server
 *     (`npm run password-link`), who could read the database file anyway.
 *
 * The last three are checked again when the link is used, not only when it is
 * made: a link made for a newcomer who has since opened a private account, or
 * set a password some other way, is worth no more than one made today would be.
 */

import { randomBytes } from "node:crypto";
import type { DB } from "../db/db.ts";
import { execute, queryAll, queryOne, transact } from "../db/db.ts";
import { appendEvent, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { Refusal } from "../core/refusal.ts";
import { getMember, hashToken, type Member } from "./sessions.ts";
import { hasPassword, setPassword, assertUsablePassword } from "./passwords.ts";
import { memberScope } from "../domain/member-scope.ts";
import { personalBudgetFor } from "../domain/budgets.ts";

export const SETUP_LINK_HOURS = 72;

/**
 * One answer for every link that does not work — unknown, used, expired, or
 * for somebody it no longer suits. Telling them apart would tell whoever holds
 * a stale link which of those it is, and a guesser that a link once existed.
 */
export const SETUP_LINK_UNUSABLE =
  "This link has been used or has expired. Ask someone in the household for a new one.";

/** A link that cannot be made, with the reason shown to the person who asked. */
export class SetupLinkRefused extends Refusal {
  override readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "SetupLinkRefused";
    this.status = status;
  }
}

/** Gone: the one answer for a link that does not work, whatever the reason. */
export class SetupLinkUnusable extends Refusal {
  override readonly status = 410;
  constructor() {
    super(SETUP_LINK_UNUSABLE);
    this.name = "SetupLinkUnusable";
  }
}

interface LinkRow {
  token_hash: string;
  member_id: string;
  created_by_member_id: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

/** The command a refusal names, for the member it is about. */
export function serverCommandFor(email: string): string {
  return `npm run password-link -- ${email}`;
}

/**
 * What `memberId` keeps that `viewerMemberId` cannot see, as plain phrases for
 * the server command to print. Empty when there is nothing.
 *
 * Accounts, policies and the personal budget are member-scope's rule, asked of
 * member-scope rather than restated, so a kind of private thing it learns later
 * is learned here too. The rest are a member's own by construction — rows keyed
 * by their id that no screen shows anybody else: the identity their statement
 * passwords are derived from (PAN, date of birth), their mailbox connection
 * (a refresh token that reads their mail), and their tax declarations and
 * challans (their salary).
 *
 * A personal budget with nothing in it is not counted: there is nothing to
 * read, and a member who once pressed "open a budget of my own" should not
 * need the server for a password.
 */
export function privateRecordsHeldBy(
  db: DB, memberId: string, viewerMemberId: string | null,
): string[] {
  if (viewerMemberId === memberId) return [];
  const scope = memberScope(db, viewerMemberId);
  const found: string[] = [];
  const counted = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

  const accounts = queryAll<{ id: string }>(
    db, `SELECT id FROM accounts WHERE holder_member_id = ?`, memberId,
  ).filter((r) => scope.accounts.has(r.id)).length;
  if (accounts) found.push(counted(accounts, "a private account", "private accounts"));

  const policies = queryAll<{ id: string }>(
    db, `SELECT id FROM insurance_policies WHERE holder_member_id = ?`, memberId,
  ).filter((r) => scope.policies.has(r.id)).length;
  if (policies) found.push(counted(policies, "a private insurance policy", "private insurance policies"));

  const budget = personalBudgetFor(db, memberId);
  if (budget && scope.budgets.has(budget.id)) {
    const inside = queryOne<{ n: number }>(
      db,
      `SELECT (SELECT COUNT(*) FROM category_groups WHERE budget_id = ?)
            + (SELECT COUNT(*) FROM categories      WHERE budget_id = ?)
            + (SELECT COUNT(*) FROM accounts        WHERE budget_id = ?)
            + (SELECT COUNT(*) FROM goals           WHERE budget_id = ?) AS n`,
      budget.id, budget.id, budget.id, budget.id,
    )!.n;
    if (inside > 0) found.push("a personal budget with something in it");
  }

  const own = (table: string) =>
    queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table} WHERE member_id = ?`, memberId)!.n;
  if (own("statement_identity")) found.push("saved statement-password details (PAN, date of birth)");
  if (own("gmail_connections")) found.push("a connected mailbox");
  if (own("tax_declarations") + own("tax_payments")) found.push("tax figures");

  return found;
}

/**
 * Why `issuerId` may not make a link for `memberId`, or null when they may.
 * A null issuer is the server's command line, which is held only to the rules
 * about the member themselves — it exists for the cases the others refuse.
 */
export function setupLinkBlocker(db: DB, issuerId: string | null, memberId: string): string | null {
  const member = getMember(db, memberId);
  if (!member) return "That member does not exist.";
  if (member.removed_at || !member.allowed) {
    return `${member.name} is not in the household. Add them back from Settings first.`;
  }
  if (issuerId !== null && issuerId === memberId) {
    return "A password link is for somebody else. Set your own password in Settings → Password.";
  }
  if (hasPassword(db, memberId)) {
    return (
      `${member.name} already has a password. They can change it themselves in Settings → Password. ` +
      `If they have forgotten it, whoever runs the server can reset it with ` +
      `${serverCommandFor(member.email)} --reset.`
    );
  }
  if (issuerId !== null && (member.last_seen_at !== null || member.google_sub !== null)) {
    /*
     * No password is not the same as new. Somebody who signs in with Google or
     * OIDC has no password either, and a link another member makes for them
     * adds a second way in that they never asked for and do not know about —
     * a takeover, the same as a reset. Every sign-in sets last_seen_at, so a
     * member who has ever been in gets their link from the server instead.
     */
    return (
      `${member.name} has signed in before, so a password for them cannot come from another ` +
      `member. They can set one themselves in Settings → Password, or whoever runs the server ` +
      `can make a link: ${serverCommandFor(member.email)}`
    );
  }
  if (issuerId !== null && privateRecordsHeldBy(db, memberId, issuerId).length > 0) {
    /*
     * Says that there is something, never what. The member's own name and
     * address are no secret inside the household; what the private records
     * are is, and the server command prints the list for whoever runs it.
     */
    return (
      `${member.name} keeps records here that only they can see, and whoever sets ` +
      `their password could read them — so a link for them cannot come from another ` +
      `member. Whoever runs the server can make one: ${serverCommandFor(member.email)}`
    );
  }
  return null;
}

export interface IssuedSetupLink {
  /** The raw token. Shown once; only its hash is stored. */
  token: string;
  /** An IST timestamp, as nowIST writes them. */
  expiresAt: string;
}

/**
 * Make a link for `memberId`. `createdBy` is the member making it, or null for
 * the server's command line. Any earlier unused link for the same member stops
 * working.
 */
export function issueSetupLink(
  db: DB, actor: Actor, memberId: string, createdBy: string | null,
): IssuedSetupLink {
  return transact(db, () => {
    const why = setupLinkBlocker(db, createdBy, memberId);
    if (why) throw new SetupLinkRefused(why, getMember(db, memberId) ? 422 : 404);
    const member = getMember(db, memberId)!;

    execute(db, `DELETE FROM password_setup_links WHERE member_id = ? AND used_at IS NULL`, memberId);

    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    /*
     * Both from nowIST. These are compared as strings against nowIST() when
     * the link is used, and a "…Z" stamp against a "…+05:30" one compares
     * character by character to an answer that means nothing — the mistake
     * passwords.ts made once with its lockout.
     */
    const createdAt = nowIST(now);
    const expiresAt = nowIST(new Date(now.getTime() + SETUP_LINK_HOURS * 3_600_000));
    execute(
      db,
      `INSERT INTO password_setup_links
         (token_hash, member_id, created_by_member_id, created_at, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      hashToken(token), memberId, createdBy, createdAt, expiresAt,
    );

    const issuer = createdBy ? getMember(db, createdBy)?.name ?? "A member" : null;
    // Never the token, and never its hash: the log is read by every member
    // and travels in exports.
    appendEvent(db, actor, {
      entity: "member", entityId: memberId, action: "password-link",
      after: { expiresAt, madeOnServer: createdBy === null },
      summary: issuer
        ? `${issuer} made a password link for ${member.name}`
        : `A password link for ${member.name} was made on the server`,
    });
    return { token, expiresAt };
  });
}

/**
 * The member a link would set a password for, or null when it would not —
 * for any reason, all of which look alike from outside.
 */
export function usableSetupLink(db: DB, token: string): { member: Member; expiresAt: string } | null {
  if (!token) return null;
  const row = queryOne<LinkRow>(
    db, `SELECT * FROM password_setup_links WHERE token_hash = ?`, hashToken(token),
  );
  if (!row || row.used_at !== null || row.expires_at <= nowIST()) return null;

  const member = getMember(db, row.member_id);
  if (!member || member.removed_at || !member.allowed) return null;
  // A password since — set some other way, or by an earlier link — is theirs
  // now, and a link does not replace one.
  if (hasPassword(db, member.id)) return null;

  if (row.created_by_member_id !== null) {
    /*
     * A member's link is worth what that member could make today. Somebody
     * removed since made it while trusted and is not now; and private records
     * opened since the link was made are exactly what the rule at issue time
     * protects.
     */
    const issuer = getMember(db, row.created_by_member_id);
    if (!issuer || issuer.removed_at || !issuer.allowed) return null;
    if (privateRecordsHeldBy(db, member.id, issuer.id).length > 0) return null;
    // Signed in since, by Google or OIDC: no longer a newcomer.
    if (member.last_seen_at !== null || member.google_sub !== null) return null;
  }
  return { member, expiresAt: row.expires_at };
}

/**
 * Set the password a link was made for, and spend the link. One transaction:
 * a password the rules refuse leaves the link as it was, to be tried again.
 */
export function redeemSetupLink(db: DB, token: string, password: string): Member {
  return transact(db, () => {
    const link = usableSetupLink(db, token);
    if (!link) throw new SetupLinkUnusable();
    assertUsablePassword(password);

    const { member } = link;
    setPassword(db, member.id, password);
    const now = nowIST();
    execute(db, `UPDATE password_setup_links SET used_at = ? WHERE token_hash = ?`, now, hashToken(token));
    execute(db, `DELETE FROM password_setup_links WHERE member_id = ? AND used_at IS NULL`, member.id);

    appendEvent(db, { memberId: member.id, source: "ui" }, {
      entity: "member", entityId: member.id, action: "password-link-used",
      summary: `${member.name} set a password with a link`,
    });
    return member;
  });
}

/** Links for this member that would still work if they were opened now. */
export function unusedSetupLinks(db: DB, memberId: string): number {
  return queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM password_setup_links
      WHERE member_id = ? AND used_at IS NULL AND expires_at > ?`,
    memberId, nowIST(),
  )!.n;
}
