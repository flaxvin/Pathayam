/**
 * A password link, made on the server.
 *
 *   npm run password-link -- priya@example.com                     what would happen
 *   npm run password-link -- priya@example.com --execute           make the link
 *   npm run password-link -- priya@example.com --execute --reset   clear a forgotten password first
 *
 * Members make password links for each other from Settings (src/auth/setup-
 * links.ts), with two cases deliberately left out, and this is the way for both:
 *
 *   · Somebody who keeps records only they can see — a private account, a
 *     personal budget with something in it, their PAN. Whoever sets their
 *     password can read all of it, so no other member may make them a link.
 *     Whoever runs the server can read the database file already; making the
 *     link here gives them nothing they did not have.
 *   · Somebody who has forgotten the password they have. A link would replace
 *     it without the old one, which from another member's hands is a takeover,
 *     and which here is a reset — so it has to be asked for by name, with
 *     --reset, and it signs that member out everywhere as it clears it.
 *
 * It is a dry run unless told otherwise, like every other command that changes
 * a household's data from outside the app: the first run says who the address
 * belongs to and what would happen, and nothing is written until --execute.
 * The link is printed once and kept nowhere — only its hash is stored.
 *
 * Exit codes: 0 done (or a dry run), 1 refused — no such member, removed, a
 * password with no --reset — and 2 a usage mistake.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, InvalidConfiguration, UnsafeConfiguration, type Config } from "./config.ts";
import { openDatabase, ensureHousehold, transact, type DB } from "./db/db.ts";
import { findMemberByEmail, listSessions, revokeAllSessions, type Member } from "./auth/sessions.ts";
import { hasPassword, clearPassword, anyPasswordSet } from "./auth/passwords.ts";
import {
  issueSetupLink, unusedSetupLinks, privateRecordsHeldBy, SETUP_LINK_HOURS,
} from "./auth/setup-links.ts";
import { formatDateTime } from "./core/dates.ts";
import type { Actor } from "./core/events.ts";

const USAGE = `
Usage: npm run password-link -- <email> [--execute] [--reset]

Make a one-time link that sets a member's password, valid for ${SETUP_LINK_HOURS} hours.

  <email>     the member's address, as on Settings
  --execute   actually make the link; without it, nothing changes
  --reset     the member already has a password: clear it, sign them out
              everywhere, then make the link (needs --execute to do anything)
  --help      this
`.trim();

/** Attributed to nobody in particular, and named, in the activity log. */
const SERVER: Actor = { memberId: null, source: "system", sourceDetail: "password-link command" };

export interface PasswordLinkDeps {
  db: DB;
  config: Config;
  out: (line: string) => void;
  err: (line: string) => void;
}

interface Parsed { email: string; execute: boolean; reset: boolean }

/*
 * By hand, because the project takes no dependencies and three flags do not
 * need one. Anything unrecognised is a mistake rather than something ignored:
 * "--exectue" silently ignored would be a dry run the operator believes was
 * the real thing.
 */
function parse(argv: string[]): Parsed | "help" | string {
  let email: string | null = null;
  let execute = false;
  let reset = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return "help";
    else if (arg === "--execute") execute = true;
    else if (arg === "--reset") reset = true;
    else if (arg.startsWith("-")) return `Unknown option: ${arg}`;
    else if (email !== null) return `One address at a time: got "${email}" and "${arg}".`;
    else email = arg.trim();
  }
  if (!email) return "Which member? Give their email address.";
  return { email, execute, reset };
}

function state(db: DB, member: Member): { password: boolean; links: number; sessions: number } {
  return {
    password: hasPassword(db, member.id),
    links: unusedSetupLinks(db, member.id),
    sessions: listSessions(db, member.id).length,
  };
}

function describeState(s: ReturnType<typeof state>): string[] {
  return [
    `  Password:      ${s.password ? "set" : "none — no password yet"}`,
    `  Unused links:  ${s.links}`,
    `  Sessions:      ${s.sessions}`,
  ];
}

export function runPasswordLink(argv: string[], deps: PasswordLinkDeps): number {
  const { db, config, out, err } = deps;
  const parsed = parse(argv);
  if (parsed === "help") {
    out(USAGE);
    return 0;
  }
  if (typeof parsed === "string") {
    err(parsed);
    err("");
    err(USAGE);
    return 2;
  }

  const member = findMemberByEmail(db, parsed.email);
  if (!member) {
    err(`There is no member with the address ${parsed.email}. Add them from Settings first.`);
    return 1;
  }

  out(`${member.name} <${member.email}>`);
  if (member.removed_at || !member.allowed) {
    err(
      `${member.name} is not in the household (removed ${formatDateTime(member.removed_at ?? "")}). ` +
      `Add them back from Settings first; then run this again.`,
    );
    return 1;
  }

  const before = state(db, member);
  for (const line of describeState(before)) out(line);
  const privateRecords = privateRecordsHeldBy(db, member.id, null);
  out(`  Private:       ${privateRecords.length ? privateRecords.join(", ") : "nothing only they can see"}`);
  out("");

  if (before.password && !parsed.reset) {
    const what =
      `${member.name} already has a password. A link would replace it, so it has to be asked for: ` +
      `add --reset to clear it, sign them out on every device, and make a link.`;
    if (parsed.execute) {
      err(what);
      return 1;
    }
    out(what);
    out("");
    out("Dry run: nothing changed.");
    return 0;
  }

  const plan: string[] = [];
  if (before.password) {
    plan.push(`clear ${member.name}'s password`);
    plan.push(`sign them out on ${before.sessions === 1 ? "1 device" : `${before.sessions} devices`}`);
  } else if (parsed.reset) {
    out("(--reset given, but there is no password to clear.)");
  }
  if (before.links > 0) {
    plan.push(`replace ${before.links === 1 ? "the unused link" : `${before.links} unused links`} already made`);
  }
  plan.push(`make a link that sets a password once, valid for ${SETUP_LINK_HOURS} hours`);

  if (!parsed.execute) {
    out("Would:");
    for (const step of plan) out(`  · ${step}`);
    out("");
    out("Dry run: nothing changed. Run again with --execute to do it.");
    return 0;
  }

  const link = transact(db, () => {
    if (before.password) {
      clearPassword(db, member.id);
      revokeAllSessions(db, SERVER, member.id);
    }
    return issueSetupLink(db, SERVER, member.id, null);
  });

  out("Done:");
  for (const step of plan) out(`  · ${step}`);
  out("");
  out("After:");
  for (const line of describeState(state(db, member))) out(line);
  out("");
  out(`The link — shown this once, works once, until ${formatDateTime(link.expiresAt)} IST:`);
  out("");
  out(`  ${config.baseUrl}/auth/setup/${link.token}`);
  out("");
  out(`Send it to ${member.name} and nobody else: whoever opens it sets their password.`);
  if (!config.localLogin && !anyPasswordSet(db)) {
    out(
      "Note: LOCAL_LOGIN is not set and nobody has a password yet. Once this link is used, " +
      "the password form appears on the sign-in page for everybody, as it does whenever a password exists.",
    );
  }
  return 0;
}

function main(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof InvalidConfiguration || error instanceof UnsafeConfiguration) {
      console.error(`\n${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  const db = openDatabase({ path: config.databasePath, verbose: false });
  ensureHousehold(db);
  let code: number;
  try {
    code = runPasswordLink(process.argv.slice(2), {
      db, config, out: (line) => console.log(line), err: (line) => console.error(line),
    });
  } finally {
    db.close();
  }
  process.exit(code);
}

// Run when invoked as a script; imported by its test, it only exports.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
