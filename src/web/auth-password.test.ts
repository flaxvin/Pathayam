/**
 * Signing in without Google.
 *
 * The domain layer is tested in `auth/passwords.test.ts`; this is about the
 * doors. What matters here is which ones open, which stay shut, and what a
 * failed attempt is allowed to tell the person making it.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, testConfig, type TestApp } from "./harness.test-data.ts";
import { setPassword, checkPassword } from "../auth/passwords.ts";
import { queryOne } from "../db/db.ts";

const GOOD = "seven pathayam granary evenings";

async function appWith(opts: { localLogin?: boolean; withPassword?: boolean } = {}) {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  if (opts.withPassword) setPassword(db, "m-ravi", GOOD);
  const app = await startTestApp(db, {
    memberId: null,
    config: testConfig({ localLogin: opts.localLogin ?? true }),
  });
  return { db, app };
}

function emailOf(db: ReturnType<typeof freshDb>, id: string): string {
  return queryOne<{ email: string }>(db, `SELECT email FROM members WHERE id = ?`, id)!.email;
}

describe("the password form is offered when it can be used", () => {
  let ctx: { db: ReturnType<typeof freshDb>; app: TestApp };
  before(async () => { ctx = await appWith({ localLogin: true }); });
  after(async () => { await ctx.app.close(); });

  test("LOCAL_LOGIN puts a password form on the sign-in page", async () => {
    const html = await (await ctx.app.get("/signin")).text();
    assert.match(html, /action="\/auth\/password"/, "no password form");
    assert.match(html, /name="password"/);
  });
});

describe("the form is not offered when it cannot", () => {
  let ctx: { db: ReturnType<typeof freshDb>; app: TestApp };
  before(async () => { ctx = await appWith({ localLogin: false }); });
  after(async () => { await ctx.app.close(); });

  test("with the flag off and no password set, there is no form", async () => {
    const html = await (await ctx.app.get("/signin")).text();
    assert.doesNotMatch(html, /action="\/auth\/password"/);
  });

  test("and the route itself is not there either", async () => {
    const res = await ctx.app.post("/auth/password", { email: "x@y.z", password: GOOD });
    assert.equal(res.status, 404, "a form that is not offered must not still accept posts");
  });
});

describe("an existing password keeps the door open", () => {
  let ctx: { db: ReturnType<typeof freshDb>; app: TestApp };
  before(async () => { ctx = await appWith({ localLogin: false, withPassword: true }); });
  after(async () => { await ctx.app.close(); });

  test("unsetting LOCAL_LOGIN cannot lock out a household that uses it", async () => {
    // One environment variable should not be able to take away the only way
    // into somebody's own ledger.
    const html = await (await ctx.app.get("/signin")).text();
    assert.match(html, /action="\/auth\/password"/, "the household was locked out by a flag");
  });
});

describe("signing in", () => {
  let ctx: { db: ReturnType<typeof freshDb>; app: TestApp };
  before(async () => { ctx = await appWith({ localLogin: true, withPassword: true }); });
  after(async () => { await ctx.app.close(); });

  test("the right password sets a session cookie and lets you in", async () => {
    const res = await ctx.app.post("/auth/password", {
      email: emailOf(ctx.db, "m-ravi"), password: GOOD,
    });
    assert.equal(res.status, 303);
    assert.match(res.headers.get("set-cookie") ?? "", /pathayam_session=/);
  });

  test("the wrong password does not", async () => {
    const res = await ctx.app.post("/auth/password", {
      email: emailOf(ctx.db, "m-ravi"), password: "wrong-but-long-enough",
    });
    assert.equal(res.status, 401);
    assert.doesNotMatch(res.headers.get("set-cookie") ?? "", /pathayam_session=/);
  });

  test("an unknown address is refused in the same words as a wrong password", async () => {
    // Telling them apart tells an attacker who is in this household.
    const unknown = await ctx.app.post("/auth/password", {
      email: "stranger@example.com", password: GOOD,
    });
    const wrong = await ctx.app.post("/auth/password", {
      email: emailOf(ctx.db, "m-ravi"), password: "wrong-but-long-enough",
    });
    assert.equal(unknown.status, wrong.status, "the status distinguishes member from stranger");
    assert.equal(await unknown.text(), await wrong.text(), "the body does");
  });

  test("the redirect after sign-in cannot be pointed off-site", async () => {
    const res = await ctx.app.post("/auth/password", {
      email: emailOf(ctx.db, "m-ravi"), password: GOOD, next: "https://evil.example/pwn",
    });
    const location = res.headers.get("location") ?? "";
    assert.ok(
      !location.startsWith("http"),
      `sign-in is the worst place for an open redirect; got ${location}`,
    );
  });
});

describe("the first password on an empty household", () => {
  test("is offered, and creates the first member", async () => {
    const db = freshDb();
    const app = await startTestApp(db, {
      memberId: null, config: testConfig({ localLogin: true }),
    });
    try {
      assert.equal((await app.get("/auth/first-run")).status, 200);

      const res = await app.post("/auth/first-run", {
        name: "Ravi", email: "ravi@example.com", password: GOOD,
      });
      assert.equal(res.status, 303);
      assert.match(res.headers.get("set-cookie") ?? "", /pathayam_session=/);

      const member = queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM members`)!;
      assert.equal(member.n, 1, "the first member was not created");
    } finally { await app.close(); }
  });

  test("closes the moment somebody has walked through it", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, {
      memberId: null, config: testConfig({ localLogin: true }),
    });
    try {
      assert.equal((await app.get("/auth/first-run")).status, 404);
      const res = await app.post("/auth/first-run", {
        name: "Intruder", email: "intruder@example.com", password: GOOD,
      });
      assert.equal(res.status, 404, "a stranger could still claim a household that has members");
    } finally { await app.close(); }
  });
});

describe("changing a password", () => {
  test("requires the current one, so a borrowed session is not a takeover", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    setPassword(db, "m-ravi", GOOD);
    const app = await startTestApp(db, {
      memberId: "m-ravi", config: testConfig({ localLogin: true }),
    });
    try {
      const wrong = await app.post("/settings/password", {
        current: "not-the-current-one", password: "a-brand-new-passphrase",
        confirm: "a-brand-new-passphrase",
      });
      assert.equal(wrong.status, 422, "a signed-in stranger could change it without knowing it");

      const right = await app.post("/settings/password", {
        current: GOOD, password: "a-brand-new-passphrase", confirm: "a-brand-new-passphrase",
      });
      assert.equal(right.status, 303);
      assert.ok(checkPassword(db, "m-ravi", "a-brand-new-passphrase").ok, "it did not change");
    } finally { await app.close(); }
  });

  test("refuses when the two new ones disagree", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    setPassword(db, "m-ravi", GOOD);
    const app = await startTestApp(db, {
      memberId: "m-ravi", config: testConfig({ localLogin: true }),
    });
    try {
      const res = await app.post("/settings/password", {
        current: GOOD, password: "a-brand-new-passphrase", confirm: "a-different-passphrase",
      });
      assert.equal(res.status, 422);
      assert.ok(checkPassword(db, "m-ravi", GOOD).ok, "the password changed anyway");
    } finally { await app.close(); }
  });

  test("a member with no password can set one without an old password", async () => {
    // The Google user who wants to stop depending on Google.
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, {
      memberId: "m-ravi", config: testConfig({ localLogin: true }),
    });
    try {
      const res = await app.post("/settings/password", {
        password: "a-first-passphrase-here", confirm: "a-first-passphrase-here",
      });
      assert.equal(res.status, 303);
      assert.ok(checkPassword(db, "m-ravi", "a-first-passphrase-here").ok);
    } finally { await app.close(); }
  });

  test("a weak password is refused rather than stored", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, {
      memberId: "m-ravi", config: testConfig({ localLogin: true }),
    });
    try {
      const res = await app.post("/settings/password", {
        password: "passwordpassword", confirm: "passwordpassword",
      });
      assert.equal(
        res.status, 422,
        "a refused password must be a refusal with a reason, not a 500",
      );
      assert.match(await res.text(), /first passwords anybody tries/i,
        "the person is not told why it was refused");
    } finally { await app.close(); }
  });
});

/*
 * Behind a proxy the client's address is read from X-Forwarded-For. It was read
 * from the left-most entry, which the client writes: a fresh made-up address on
 * every attempt meant each one counted against a different source, and the
 * limit of 10 failures per address never tripped — 12 wrong passwords in a row
 * all answered 401. The proxy appends the real address on the right.
 */
describe("the sign-in limit behind a proxy", () => {
  test("a forged X-Forwarded-For does not make each attempt a new address", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    setPassword(db, "m-ravi", GOOD);
    const app = await startTestApp(db, {
      memberId: null, config: testConfig({ localLogin: true, trustProxy: true }),
    });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await app.post("/auth/password",
          { email: "nobody@example.com", password: "wrong" },
          // What the proxy forwards: the client's forged entry, then the
          // address the proxy itself saw.
          { headers: { "X-Forwarded-For": `203.0.113.${i}, 198.51.100.7` } });
        statuses.push(res.status);
      }
      assert.equal(statuses.at(-1), 429, statuses.join(" "));
      const sources = queryOne<{ n: number }>(db,
        `SELECT COUNT(DISTINCT source) AS n FROM auth_attempts`)!.n;
      assert.equal(sources, 1, "attempts were recorded against the forged addresses");
    } finally { await app.close(); }
  });
});
