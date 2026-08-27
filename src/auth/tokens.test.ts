import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST, addDays } from "../core/dates.ts";
import { historyFor } from "../core/events.ts";
import {
  mintToken, listTokens, revokeToken, authenticateToken, tokenMayReach,
  checkTokenRateLimit, resetTokenRateLimits,
} from "./tokens.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  return db;
}

describe("08 F30 · personal API tokens", () => {
  test("F30.4 · the secret is shown once and never stored", () => {
    const db = setup();
    const { token, secret } = mintToken(db, actor, { name: "Export script", scope: "read" });

    assert.match(secret, /^bgt_[\w-]{40,}$/);

    // Not "we choose not to show it again" — the database physically cannot.
    const row = queryOne<{ token_hash: string }>(
      db, `SELECT token_hash FROM api_tokens WHERE id = ?`, token.id,
    )!;
    assert.notEqual(row.token_hash, secret);
    assert.ok(!JSON.stringify(row).includes(secret));

    // And the event log does not carry it either — R37 keeps that forever.
    const events = historyFor(db, "api-token", token.id);
    assert.ok(!JSON.stringify(events).includes(secret));
    db.close();
  });

  test("authenticates, and records that it was used", () => {
    const db = setup();
    const { token, secret } = mintToken(db, actor, { name: "Script", scope: "read-write" });

    const auth = authenticateToken(db, `Bearer ${secret}`);
    assert.ok(auth);
    assert.equal(auth!.token.id, token.id);
    assert.equal(auth!.scope, "read-write");

    // F30.3 · Last-used is how a household spots a token they forgot about.
    assert.ok(listTokens(db, RAVI)[0]!.last_used_at);
    db.close();
  });

  test("a wrong, revoked or expired token is refused, and they look alike", () => {
    const db = setup();
    const { token, secret } = mintToken(db, actor, { name: "Script", scope: "read" });

    assert.equal(authenticateToken(db, "Bearer bgt_nonsense"), null);
    assert.equal(authenticateToken(db, undefined), null);
    assert.equal(authenticateToken(db, secret), null, "without the Bearer scheme");

    revokeToken(db, actor, token.id);
    assert.equal(authenticateToken(db, `Bearer ${secret}`), null);
    db.close();
  });

  test("an expired token stops working on its expiry date", () => {
    const db = setup();
    const { secret } = mintToken(db, actor, {
      name: "Short-lived", scope: "read", expiresInDays: 30,
    });

    const expiry = addDays(todayIST(), 30);
    assert.ok(authenticateToken(db, `Bearer ${secret}`, expiry));
    assert.equal(authenticateToken(db, `Bearer ${secret}`, addDays(expiry, 1)), null);
    db.close();
  });

  test("F30.3 · a revoked token disappears from the list", () => {
    const db = setup();
    const { token } = mintToken(db, actor, { name: "One", scope: "read" });
    mintToken(db, actor, { name: "Two", scope: "read" });

    assert.equal(listTokens(db, RAVI).length, 2);
    revokeToken(db, actor, token.id);
    assert.deepEqual(listTokens(db, RAVI).map((t) => t.name), ["Two"]);
    db.close();
  });

  test("a member cannot revoke someone else's token", () => {
    const db = setup();
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
      "m-priya", "priya@example.com", "Priya", nowIST());

    const { token } = mintToken(db, actor, { name: "Ravi's", scope: "read" });
    assert.throws(
      () => revokeToken(db, { memberId: "m-priya", source: "ui" }, token.id),
      /does not exist/,
    );
    assert.equal(listTokens(db, RAVI).length, 1);
    db.close();
  });

  test("F30.6 · a token can never reach what a token must not reach", () => {
    // Enforced as a deny-list rather than remembered per route, because the
    // failure mode of remembering is a new route that quietly becomes
    // reachable.
    for (const path of [
      "/tokens", "/tokens/abc/revoke",
      "/impersonate", "/impersonate/exit",
      "/settings/members", "/settings/members/invite",
      "/auth/dev", "/auth/google/callback", "/signout",
    ]) {
      assert.equal(tokenMayReach(path), false, `${path} must be unreachable`);
    }

    for (const path of ["/", "/accounts", "/review", "/export.json", "/settings"]) {
      assert.equal(tokenMayReach(path), true, `${path} should be reachable`);
    }
  });

  test("a path that merely starts with a forbidden word is not blocked", () => {
    // "/tokensomething" is not under "/tokens".
    assert.equal(tokenMayReach("/tokensomething"), true);
    assert.equal(tokenMayReach("/settings/membership-fees"), true);
  });

  test("F30.7 · rate-limited independently, per token", () => {
    resetTokenRateLimits();
    const now = Date.now();

    for (let i = 0; i < 120; i++) {
      assert.equal(checkTokenRateLimit("t1", now).allowed, true, `call ${i + 1}`);
    }
    const blocked = checkTokenRateLimit("t1", now);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds > 0);

    // A runaway script must not lock out the household's other tokens.
    assert.equal(checkTokenRateLimit("t2", now).allowed, true);

    // And the window rolls.
    assert.equal(checkTokenRateLimit("t1", now + 61_000).allowed, true);
  });
});
