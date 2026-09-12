import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { queryEvents } from "../core/events.ts";
import {
  inviteMember, removeMember, listMembers, createSession, authenticate,
  listSessions, revokeSession, revokeAllSessions, pruneExpiredSessions,
  startImpersonation, stopImpersonation, setImpersonationWrites, actorFor,
  parseCookies, sessionCookie, clearedSessionCookie, recordAuthAttempt,
  isRateLimited, setTheme, IMPERSONATION_MINUTES,
} from "./sessions.ts";
import { parseIdToken, beginOAuth, OAuthError } from "./google.ts";
import { addDays, todayIST } from "../core/dates.ts";

const system: Actor = { memberId: null, source: "system" };

function setup(): DB {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  return db;
}

function seedTwo(db: DB) {
  const ravi = inviteMember(db, system, { email: "ravi@example.com", name: "Ravi" });
  const priya = inviteMember(db, system, { email: "priya@example.com", name: "Priya" });
  return { ravi, priya };
}

describe("members and the allow-list", () => {
  test("all members are peers — there is no owner (P5)", () => {
    const db = setup();
    const { ravi, priya } = seedTwo(db);
    // Nothing in the schema or the API distinguishes them.
    assert.equal(Object.hasOwn(ravi, "role"), false);
    assert.equal(ravi.allowed, priya.allowed);
    db.close();
  });

  test("inviting the same email twice does not duplicate", () => {
    const db = setup();
    inviteMember(db, system, { email: "ravi@example.com", name: "Ravi" });
    inviteMember(db, system, { email: "RAVI@example.com", name: "Ravi again" });
    assert.equal(listMembers(db).length, 1);
    db.close();
  });

  test("a removed member keeps their historical attributions (F1.6)", () => {
    const db = setup();
    const { ravi, priya } = seedTwo(db);
    removeMember(db, system, priya.id);

    assert.equal(listMembers(db).length, 1);
    assert.equal(listMembers(db, { includeRemoved: true }).length, 2);
    // The row survives, so events attributed to them still resolve to a name.
    assert.ok(queryEvents(db, { entity: "member", entityId: priya.id }).length > 0);
    void ravi;
    db.close();
  });

  test("refuses to remove the last member", () => {
    const db = setup();
    const ravi = inviteMember(db, system, { email: "ravi@example.com" });
    assert.throws(() => removeMember(db, system, ravi.id), /last member/);
    db.close();
  });
});

describe("sessions", () => {
  test("store only a hash, so the cookie value is not recoverable from the database", () => {
    const db = setup();
    const { ravi } = seedTwo(db);
    const { token, session } = createSession(db, ravi.id, { days: 30 });

    assert.notEqual(session.id, token);
    const stored = db.prepare("SELECT id FROM sessions").all() as { id: string }[];
    assert.ok(!stored.some((r) => r.id === token));
    db.close();
  });

  test("authenticate resolves a valid cookie", () => {
    const db = setup();
    const { ravi } = seedTwo(db);
    const { token } = createSession(db, ravi.id, { days: 30 });

    const auth = authenticate(db, token);
    assert.ok(auth);
    assert.equal(auth.member.id, ravi.id);
    assert.equal(auth.impersonating, false);
    assert.equal(auth.canWrite, true);
    db.close();
  });

  test("rejects an unknown, revoked or expired session", () => {
    const db = setup();
    const { ravi } = seedTwo(db);

    assert.equal(authenticate(db, "not-a-real-token"), null);
    assert.equal(authenticate(db, null), null);

    const a = createSession(db, ravi.id, { days: 30 });
    revokeSession(db, system, a.session.id);
    assert.equal(authenticate(db, a.token), null);

    const b = createSession(db, ravi.id, { days: 30 });
    execute(db, `UPDATE sessions SET expires_at = ? WHERE id = ?`, addDays(todayIST(), -1), b.session.id);
    assert.equal(authenticate(db, b.token), null);
    db.close();
  });

  test("R38.16 — the allow-list is enforced on every request, not just at login", () => {
    const db = setup();
    const { ravi, priya } = seedTwo(db);
    const { token } = createSession(db, priya.id, { days: 30 });
    assert.ok(authenticate(db, token), "signed in fine");

    removeMember(db, system, priya.id);
    // Their cookie is still syntactically valid, and must stop working anyway.
    assert.equal(authenticate(db, token), null);
    void ravi;
    db.close();
  });

  test("sessions are listable and revocable per device (R38.14)", () => {
    const db = setup();
    const { ravi } = seedTwo(db);
    const phone = createSession(db, ravi.id, { days: 30, userAgent: "iPhone" });
    const laptop = createSession(db, ravi.id, { days: 30, userAgent: "Firefox" });

    assert.equal(listSessions(db, ravi.id).length, 2);
    revokeSession(db, system, phone.session.id);
    assert.equal(listSessions(db, ravi.id).length, 1);
    assert.ok(authenticate(db, laptop.token));

    revokeAllSessions(db, system, ravi.id);
    assert.equal(listSessions(db, ravi.id).length, 0);
    db.close();
  });

  test("prunes long-expired sessions", () => {
    const db = setup();
    const { ravi } = seedTwo(db);
    const s = createSession(db, ravi.id, { days: 30 });
    execute(db, `UPDATE sessions SET expires_at = ? WHERE id = ?`, addDays(todayIST(), -10), s.session.id);
    assert.equal(pruneExpiredSessions(db), 1);
    db.close();
  });
});

describe("impersonation — R38.6 to R38.12", () => {
  test("is read-only by default (R38.10)", () => {
    const db = setup();
    const { ravi, priya } = seedTwo(db);
    const { token, session } = createSession(db, ravi.id, { days: 30 });

    startImpersonation(db, { memberId: ravi.id, source: "ui" }, session.id, priya.id);
    const auth = authenticate(db, token)!;

    assert.equal(auth.impersonating, true);
    assert.equal(auth.viewingAs.id, priya.id, "the screen shows what Priya sees");
    assert.equal(auth.member.id, ravi.id, "but the real member is still Ravi");
    assert.equal(auth.canWrite, false);
    db.close();
  });

  test("writes require an explicit in-session toggle", () => {
    const db = setup();
    const { ravi, priya } = seedTwo(db);
    const { token, session } = createSession(db, ravi.id, { days: 30 });
    const actor: Actor = { memberId: ravi.id, source: "ui" };

    startImpersonation(db, actor, session.id, priya.id);
    setImpersonationWrites(db, actor, session.id, true);
    assert.equal(authenticate(db, token)!.canWrite, true);

    setImpersonationWrites(db, actor, session.id, false);
    assert.equal(authenticate(db, token)!.canWrite, false);
    db.close();
  });

  test("R38.9 — a write while impersonating records both identities", () => {
    const db = setup();
    const { ravi, priya } = seedTwo(db);
    const { token, session } = createSession(db, ravi.id, { days: 30 });

    startImpersonation(db, { memberId: ravi.id, source: "ui" }, session.id, priya.id);
    const actor = actorFor(authenticate(db, token)!);

    assert.equal(actor.memberId, priya.id, "attributed to who is being viewed as");
    assert.equal(actor.realMemberId, ravi.id, "the trail never loses who really did it");
    db.close();
  });

  test("expires automatically (R38.11)", () => {
    const db = setup();
    const { ravi, priya } = seedTwo(db);
    const { token, session } = createSession(db, ravi.id, { days: 30 });

    startImpersonation(db, { memberId: ravi.id, source: "ui" }, session.id, priya.id);
    execute(
      db, `UPDATE sessions SET impersonation_expires_at = ? WHERE id = ?`,
      "2020-01-01T00:00:00+05:30", session.id,
    );

    const auth = authenticate(db, token)!;
    assert.equal(auth.impersonating, false, "it lapses rather than lingering");
    assert.equal(auth.viewingAs.id, ravi.id);
    assert.ok(IMPERSONATION_MINUTES > 0);
    db.close();
  });

  test("logs both entering and leaving (R38.8)", () => {
    const db = setup();
    const { ravi, priya } = seedTwo(db);
    const { session } = createSession(db, ravi.id, { days: 30 });
    const actor: Actor = { memberId: ravi.id, source: "ui" };

    startImpersonation(db, actor, session.id, priya.id);
    stopImpersonation(db, actor, session.id);

    const events = queryEvents(db, { entity: "impersonation", descending: false });
    assert.deepEqual(events.map((e) => e.action), ["start", "stop"]);
    db.close();
  });

  test("ends if the impersonated member is removed", () => {
    const db = setup();
    const { ravi, priya } = seedTwo(db);
    const { token, session } = createSession(db, ravi.id, { days: 30 });

    startImpersonation(db, { memberId: ravi.id, source: "ui" }, session.id, priya.id);
    removeMember(db, system, priya.id);

    assert.equal(authenticate(db, token)!.impersonating, false);
    db.close();
  });
});

describe("rate limiting — R38.16", () => {
  test("trips after repeated failures from one source", () => {
    const db = setup();
    for (let i = 0; i < 9; i++) recordAuthAttempt(db, "1.2.3.4", "denied");
    assert.equal(isRateLimited(db, "1.2.3.4"), false);
    recordAuthAttempt(db, "1.2.3.4", "denied");
    assert.equal(isRateLimited(db, "1.2.3.4"), true);
    // Another source is unaffected.
    assert.equal(isRateLimited(db, "5.6.7.8"), false);
    db.close();
  });

  test("successful sign-ins do not count against the limit", () => {
    const db = setup();
    for (let i = 0; i < 20; i++) recordAuthAttempt(db, "1.2.3.4", "success");
    assert.equal(isRateLimited(db, "1.2.3.4"), false);
    db.close();
  });
});

describe("theme — R39.2", () => {
  test("is stored server-side on the member", () => {
    const db = setup();
    const { ravi } = seedTwo(db);
    setTheme(db, { memberId: ravi.id, source: "ui" }, ravi.id, "dark");
    assert.equal(listMembers(db).find((m) => m.id === ravi.id)!.theme, "dark");
    db.close();
  });

  test("defaults to following the system (R39.1)", () => {
    const db = setup();
    const { ravi } = seedTwo(db);
    assert.equal(ravi.theme, "system");
    db.close();
  });
});

describe("cookies", () => {
  test("are HttpOnly, SameSite=Lax, and Secure over HTTPS (R38.13)", () => {
    const cookie = sessionCookie("abc", { secure: true, days: 30 });
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /Max-Age=2592000/);
    // Over plain HTTP on a homelab LAN, Secure would make the cookie unusable.
    assert.doesNotMatch(sessionCookie("abc", { secure: false, days: 30 }), /Secure/);
  });

  test("clearing expires immediately", () => {
    assert.match(clearedSessionCookie(true), /Max-Age=0/);
  });

  test("parse handles multiple values and missing headers", () => {
    assert.deepEqual(parseCookies("a=1; b=two"), { a: "1", b: "two" });
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies("pathayam_session=x%2Fy"), { pathayam_session: "x/y" });
  });
});

describe("Google SSO", () => {
  function makeIdToken(claims: Record<string, unknown>): string {
    const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
  }

  const valid = {
    iss: "https://accounts.google.com",
    aud: "client-123",
    sub: "google-sub-1",
    email: "Ravi@Example.com",
    email_verified: true,
    name: "Ravi",
    exp: Math.floor(Date.now() / 1000) + 600,
  };

  test("reads the profile from a well-formed token", () => {
    const profile = parseIdToken(makeIdToken(valid), "client-123");
    assert.equal(profile.sub, "google-sub-1");
    assert.equal(profile.email, "ravi@example.com", "normalised to lower case for matching");
    assert.equal(profile.name, "Ravi");
    db_noop();
  });

  test("rejects a token issued for a different application", () => {
    assert.throws(
      () => parseIdToken(makeIdToken({ ...valid, aud: "someone-else" }), "client-123"),
      OAuthError,
    );
  });

  test("rejects a token from the wrong issuer", () => {
    assert.throws(
      () => parseIdToken(makeIdToken({ ...valid, iss: "https://evil.example" }), "client-123"),
      OAuthError,
    );
  });

  test("rejects an expired token", () => {
    assert.throws(
      () => parseIdToken(makeIdToken({ ...valid, exp: 1000 }), "client-123"),
      /took too long/,
    );
  });

  test("rejects a malformed token rather than reading past the damage", () => {
    assert.throws(() => parseIdToken("nonsense", "client-123"), OAuthError);
    assert.throws(() => parseIdToken("a.b.c", "client-123"), OAuthError);
  });

  test("the authorisation URL carries PKCE and a state value", () => {
    const start = beginOAuth({ clientId: "client-123", redirectUri: "http://localhost/cb" });
    const url = new URL(start.url);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("state"), start.state);
    assert.equal(url.searchParams.get("scope"), "openid email profile");
    assert.ok(start.codeVerifier.length >= 32);
    // Two calls must not produce the same state, or CSRF protection is fiction.
    assert.notEqual(
      beginOAuth({ clientId: "c", redirectUri: "r" }).state,
      beginOAuth({ clientId: "c", redirectUri: "r" }).state,
    );
  });
});

function db_noop() {}
