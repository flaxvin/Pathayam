/**
 * One-time password links, below the HTTP layer.
 *
 * The doors are tested in `web/password-links.test.ts`. This is about the rule
 * underneath them: who may make a link for whom, and what a link is worth
 * once made — once, for 72 hours, and never more than the newest one.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import {
  issueSetupLink, redeemSetupLink, setupLinkBlocker, usableSetupLink, unusedSetupLinks,
  privateRecordsHeldBy, SetupLinkRefused, SetupLinkUnusable, SETUP_LINK_UNUSABLE,
} from "./setup-links.ts";
import { setPassword, hasPassword, checkPassword } from "./passwords.ts";
import { removeMember, inviteMember } from "./sessions.ts";
import { createAccount } from "../domain/accounts.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { createGroup } from "../domain/budget.ts";
import { execute, queryAll, queryOne } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";

const GOOD = "seven pathayam granary evenings";
const ravi: Actor = { memberId: "m-ravi", source: "ui" };

function household() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  seedMember(db, "m-priya", "Priya");
  setPassword(db, "m-ravi", "ravi's own long password");
  return db;
}

const issue = (db: ReturnType<typeof freshDb>) =>
  issueSetupLink(db, ravi, "m-priya", "m-ravi");

describe("a link sets a first password, once", () => {
  test("issued for a member with none, it sets one", () => {
    const db = household();
    const { token, expiresAt } = issue(db);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
    assert.ok(expiresAt > nowIST(), "already expired");

    const member = redeemSetupLink(db, token, GOOD);
    assert.equal(member.id, "m-priya");
    assert.equal(checkPassword(db, "m-priya", GOOD).ok, true);
  });

  test("only the hash is stored", () => {
    const db = household();
    const { token } = issue(db);
    const rows = queryAll<{ token_hash: string }>(db, `SELECT token_hash FROM password_setup_links`);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]!.token_hash, token);
    assert.match(rows[0]!.token_hash, /^[0-9a-f]{64}$/);
  });

  test("it works once", () => {
    const db = household();
    const { token } = issue(db);
    redeemSetupLink(db, token, GOOD);
    assert.throws(() => redeemSetupLink(db, token, "a different long password"), SetupLinkUnusable);
    assert.equal(checkPassword(db, "m-priya", GOOD).ok, true, "the second use changed it");
  });

  test("an expired link is refused, in the same words as an unknown one", () => {
    const db = household();
    const { token } = issue(db);
    execute(db, `UPDATE password_setup_links SET expires_at = ?`, nowIST(new Date(Date.now() - 1000)));
    assert.equal(usableSetupLink(db, token), null);

    let expired = "", unknown = "";
    try { redeemSetupLink(db, token, GOOD); } catch (e) { expired = (e as Error).message; }
    try { redeemSetupLink(db, "not-a-token-anybody-made", GOOD); } catch (e) { unknown = (e as Error).message; }
    assert.equal(expired, SETUP_LINK_UNUSABLE);
    assert.equal(unknown, SETUP_LINK_UNUSABLE);
    assert.equal(hasPassword(db, "m-priya"), false);
  });

  test("a weak password is refused and the link survives to be tried again", () => {
    const db = household();
    const { token } = issue(db);
    assert.throws(() => redeemSetupLink(db, token, "short"), /12 characters/);
    assert.ok(usableSetupLink(db, token), "a refused password used the link up");
    redeemSetupLink(db, token, GOOD);
  });

  test("a second link kills the first", () => {
    const db = household();
    const first = issue(db).token;
    const second = issue(db).token;
    assert.equal(unusedSetupLinks(db, "m-priya"), 1);
    assert.throws(() => redeemSetupLink(db, first, GOOD), SetupLinkUnusable);
    redeemSetupLink(db, second, GOOD);
  });

  test("a link made before she got a password some other way cannot replace it", () => {
    const db = household();
    const { token } = issue(db);
    setPassword(db, "m-priya", "priya chose this one herself");
    assert.throws(() => redeemSetupLink(db, token, GOOD), SetupLinkUnusable);
    assert.equal(checkPassword(db, "m-priya", "priya chose this one herself").ok, true);
  });

  test("removing the member ends the link; adding her back does not revive it", () => {
    const db = household();
    const { token } = issue(db);
    removeMember(db, ravi, "m-priya");
    inviteMember(db, ravi, { email: "m-priya@example.com" });
    assert.throws(() => redeemSetupLink(db, token, GOOD), SetupLinkUnusable);
  });
});

describe("the event log names the link and never carries it", () => {
  test("issuing and redeeming are logged without the token or its hash", () => {
    const db = household();
    const { token } = issue(db);
    redeemSetupLink(db, token, GOOD);
    const hash = queryOne<{ token_hash: string }>(db, `SELECT token_hash FROM password_setup_links`)!.token_hash;

    const events = queryAll<Record<string, unknown>>(db, `SELECT * FROM events`);
    const made = events.find((e) => e.action === "password-link");
    assert.ok(made, "issuing was not logged");
    assert.equal(made.summary, "Ravi made a password link for Priya");
    assert.ok(events.some((e) => e.action === "password-link-used"), "redeeming was not logged");
    for (const e of events) {
      const text = JSON.stringify(e);
      assert.ok(!text.includes(token), "the token is in the event log");
      assert.ok(!text.includes(hash), "the token's hash is in the event log");
    }
  });

  test("a link made on the server says so", () => {
    const db = household();
    issueSetupLink(db, { memberId: null, source: "system" }, "m-priya", null);
    const made = queryOne<{ summary: string }>(db, `SELECT summary FROM events WHERE action = 'password-link'`)!;
    assert.match(made.summary, /server/);
  });
});

describe("who may make a link for whom", () => {
  const refusedFor = (db: ReturnType<typeof freshDb>, issuer: string, target: string) => {
    assert.throws(
      () => issueSetupLink(db, { memberId: issuer, source: "ui" }, target, issuer),
      SetupLinkRefused,
    );
    assert.equal(unusedSetupLinks(db, target), 0, "a refused link was stored");
  };

  test("not for yourself", () => {
    const db = household();
    execute(db, `DELETE FROM member_passwords`);
    refusedFor(db, "m-ravi", "m-ravi");
  });

  test("not for somebody who already has a password — they change it themselves", () => {
    const db = household();
    setPassword(db, "m-priya", "priya's own long password");
    refusedFor(db, "m-ravi", "m-priya");
    assert.match(setupLinkBlocker(db, "m-ravi", "m-priya") ?? "", /settings\/password|change/i);
  });

  test("not for a removed member", () => {
    const db = household();
    removeMember(db, ravi, "m-priya");
    refusedFor(db, "m-ravi", "m-priya");
  });

  test("not for a member who is not allowed in", () => {
    const db = household();
    execute(db, `UPDATE members SET allowed = 0 WHERE id = 'm-priya'`);
    refusedFor(db, "m-ravi", "m-priya");
  });

  test("not for a member who does not exist", () => {
    const db = household();
    refusedFor(db, "m-ravi", "m-nobody");
  });

  test("not for somebody holding a private account the issuer cannot see", () => {
    const db = household();
    createAccount(db, { memberId: "m-priya", source: "ui" }, {
      name: "Priya's own savings", kind: "tracking", subtype: "savings",
      holderMemberId: "m-priya", visibility: "private",
    });
    refusedFor(db, "m-ravi", "m-priya");
    const why = setupLinkBlocker(db, "m-ravi", "m-priya") ?? "";
    assert.match(why, /npm run password-link/, "the refusal does not name the way that works");
    assert.doesNotMatch(why, /Priya's own savings/, "the refusal named the private account");
  });

  test("a shared account she holds is no obstacle", () => {
    const db = household();
    createAccount(db, { memberId: "m-priya", source: "ui" }, {
      name: "Priya's salary account", kind: "budget", subtype: "savings",
      holderMemberId: "m-priya",
    });
    assert.equal(setupLinkBlocker(db, "m-ravi", "m-priya"), null);
  });

  test("not for somebody whose personal budget has anything in it", () => {
    const db = household();
    const budget = ensurePersonalBudget(db, "m-priya", "Priya");
    // An empty personal budget is nothing to read.
    assert.equal(setupLinkBlocker(db, "m-ravi", "m-priya"), null);
    createGroup(db, { memberId: "m-priya", source: "ui" }, "Her own", "normal", budget.id);
    refusedFor(db, "m-ravi", "m-priya");
  });

  test("not for somebody whose statement passwords are kept here", () => {
    const db = household();
    execute(
      db, `INSERT INTO statement_identity (member_id, name, pan, dob, updated_at) VALUES (?,?,?,?,?)`,
      "m-priya", "PRIYA", "ABCDE1234F", "01011990", nowIST(),
    );
    refusedFor(db, "m-ravi", "m-priya");
  });

  test("and a link made before her private records existed stops working once they do", () => {
    const db = household();
    const { token } = issue(db);
    createAccount(db, { memberId: "m-priya", source: "ui" }, {
      name: "Opened since", kind: "tracking", subtype: "savings",
      holderMemberId: "m-priya", visibility: "private",
    });
    assert.throws(() => redeemSetupLink(db, token, GOOD), SetupLinkUnusable);
  });

  test("the server may make one regardless of private records", () => {
    const db = household();
    createAccount(db, { memberId: "m-priya", source: "ui" }, {
      name: "Priya's own savings", kind: "tracking", subtype: "savings",
      holderMemberId: "m-priya", visibility: "private",
    });
    assert.ok(privateRecordsHeldBy(db, "m-priya", "m-ravi").length > 0);
    const { token } = issueSetupLink(db, { memberId: null, source: "system" }, "m-priya", null);
    redeemSetupLink(db, token, GOOD);
    assert.equal(hasPassword(db, "m-priya"), true);
  });
});
