/**
 * A first password for somebody added to a household that signs in with
 * passwords alone.
 *
 * Before this, inviting Priya to a household with no Google sign-in answered
 * "priya@example.com can now sign in" — and she could not: she had no password,
 * /settings/password needs a session, and the only door that sets a password
 * without one (/auth/first-run) closes the moment the household has a member.
 * Re-adding somebody was the same, since removal clears the password.
 *
 * The rule itself is tested in `auth/setup-links.test.ts`; this is the doors,
 * driven as the two browsers involved — Ravi's, signed in, and Priya's, not.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";
import { setPassword, checkPassword, hasPassword } from "../auth/passwords.ts";
import { createAccount } from "../domain/accounts.ts";
import { execute, queryAll } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { redactedPath } from "../http/server.ts";

const GOOD = "seven pathayam granary evenings";
const SIGNED_OUT = { headers: { Cookie: "" } };
const UNUSABLE = "This link has been used or has expired. Ask someone in the household for a new one.";

function household() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  seedMember(db, "m-priya", "Priya");
  setPassword(db, "m-ravi", "ravi's own long password");
  return db;
}

async function ravisApp(db = household(), config: Record<string, unknown> = { localLogin: true }) {
  return startTestApp(db, { memberId: "m-ravi", config });
}

/** Ravi presses the button; the page that comes back carries the link. */
async function makeLink(app: TestApp, memberId = "m-priya"): Promise<{ token: string; page: string; res: Response }> {
  const res = await app.post(`/members/${memberId}/password-link`);
  const page = await res.text();
  const token = /\/auth\/setup\/([A-Za-z0-9_-]{43})/.exec(page)?.[1] ?? "";
  return { token, page, res };
}

const setupWith = (app: TestApp, token: string, password = GOOD, confirm = password) =>
  app.post(`/auth/setup/${token}`, { password, confirm }, SIGNED_OUT);

describe("a password link, from the button to signed in", () => {
  test("Ravi makes it, Priya opens it signed out, sets a password and is in", async () => {
    const db = household();
    const app = await ravisApp(db);
    try {
      const { token, page, res } = await makeLink(app);
      assert.equal(res.status, 200, "the link must be shown on a page, not carried by a redirect");
      assert.ok(token, "no link on the page");
      assert.match(page, new RegExp(`http://127\\.0\\.0\\.1/auth/setup/${token}`), "not the full link");
      assert.match(page, /\d{2}-\d{2}-\d{4}/, "no expiry date in DD-MM-YYYY");
      assert.match(page, /once/i, "does not say it works once");
      assert.match(res.headers.get("cache-control") ?? "", /no-store/);

      const form = await app.get(`/auth/setup/${token}`, SIGNED_OUT);
      assert.equal(form.status, 200);
      assert.match(form.headers.get("cache-control") ?? "", /no-store/);
      // Never the path: the token is in it.
      assert.match(form.headers.get("referrer-policy") ?? "", /^(no-referrer|strict-origin)$/);
      const html = await form.text();
      assert.match(html, /name="password"/);
      assert.match(html, /name="confirm"/);

      const done = await setupWith(app, token);
      assert.equal(done.status, 303);
      assert.match(done.headers.get("set-cookie") ?? "", /pathayam_session=/, "not signed in");
      const location = done.headers.get("location") ?? "";
      assert.match(location, /^\/(\?|$)/, `not sent home: ${location}`);
      assert.ok(!location.includes(token), "the token rode the redirect");
      assert.equal(checkPassword(db, "m-priya", GOOD).ok, true);

      // And the password is a real one: the ordinary door takes it.
      const signin = await app.post(
        "/auth/password", { email: "m-priya@example.com", password: GOOD }, SIGNED_OUT,
      );
      assert.equal(signin.status, 303);
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });

  test("it works once", async () => {
    const app = await ravisApp();
    try {
      const { token } = await makeLink(app);
      assert.equal((await setupWith(app, token)).status, 303);

      const again = await setupWith(app, token, "another long password here");
      assert.equal(again.status, 410);
      assert.match(await again.text(), new RegExp(UNUSABLE.slice(0, 40)));
      const page = await app.get(`/auth/setup/${token}`, SIGNED_OUT);
      assert.equal(page.status, 410);
      assert.doesNotMatch(await page.text(), /name="password"/);
    } finally { await app.close(); }
  });

  test("an expired link, a used one and a made-up one all answer the same", async () => {
    const db = household();
    seedMember(db, "m-anu", "Anu");
    const app = await ravisApp(db);
    try {
      const expired = (await makeLink(app, "m-priya")).token;
      execute(db, `UPDATE password_setup_links SET expires_at = ? WHERE member_id = 'm-priya'`,
        nowIST(new Date(Date.now() - 60_000)));
      const used = (await makeLink(app, "m-anu")).token;
      await setupWith(app, used);

      const answers = await Promise.all(
        [expired, used, "x".repeat(43)].map(async (t) => {
          const r = await app.get(`/auth/setup/${t}`, SIGNED_OUT);
          return `${r.status} ${await r.text()}`;
        }),
      );
      assert.equal(new Set(answers).size, 1, "the answers differ, so they say which links were real");
      assert.ok(answers[0]!.includes(UNUSABLE), answers[0]);
      assert.equal(hasPassword(db, "m-priya"), false);
    } finally { await app.close(); }
  });

  test("a second link kills the first", async () => {
    const db = household();
    const app = await ravisApp(db);
    try {
      const first = (await makeLink(app)).token;
      const second = (await makeLink(app)).token;
      assert.notEqual(first, second);
      assert.equal((await setupWith(app, first)).status, 410);
      assert.equal((await setupWith(app, second)).status, 303);
    } finally { await app.close(); }
  });

  test("two passwords that differ are refused, and the link survives", async () => {
    const db = household();
    const app = await ravisApp(db);
    try {
      const { token } = await makeLink(app);
      const res = await setupWith(app, token, GOOD, GOOD + " typo");
      assert.equal(res.status, 422);
      assert.doesNotMatch(res.headers.get("set-cookie") ?? "", /pathayam_session=/);
      assert.equal(hasPassword(db, "m-priya"), false);
      assert.equal((await setupWith(app, token)).status, 303);
    } finally { await app.close(); }
  });
});

describe("the token stays out of everything that keeps a copy", () => {
  test("not in the event log, and not in any redirect", async () => {
    const db = household();
    const app = await ravisApp(db);
    try {
      const { token, res } = await makeLink(app);
      assert.equal(res.headers.get("location"), null);
      const done = await setupWith(app, token);
      assert.ok(!(done.headers.get("location") ?? "").includes(token));

      const events = JSON.stringify(queryAll(db, `SELECT * FROM events`));
      assert.ok(events.includes("made a password link for Priya"), "issuing was not logged");
      assert.ok(!events.includes(token), "the token is in the event log");
    } finally { await app.close(); }
  });

  test("a logged path has the token taken out", () => {
    const token = "A".repeat(43);
    assert.equal(redactedPath(`/auth/setup/${token}`).includes(token), false);
    assert.equal(redactedPath("/accounts/abc"), "/accounts/abc");
  });
});

describe("the door is rate limited like the password form", () => {
  test("ten bad links from one place and even a good one is turned away", async () => {
    const app = await ravisApp();
    try {
      const { token } = await makeLink(app);
      for (let i = 0; i < 10; i++) {
        const res = await setupWith(app, `${"z".repeat(42)}${i}`);
        assert.equal(res.status, 410);
      }
      const res = await setupWith(app, token);
      assert.equal(res.status, 429, "the guessing went on unlimited");
    } finally { await app.close(); }
  });
});

describe("who may press the button", () => {
  test("not for yourself", async () => {
    const db = household();
    execute(db, `DELETE FROM member_passwords`);
    const app = await ravisApp(db);
    try {
      const { res, token } = await makeLink(app, "m-ravi");
      assert.equal(res.status, 422);
      assert.equal(token, "");
    } finally { await app.close(); }
  });

  test("not for somebody with a password", async () => {
    const db = household();
    setPassword(db, "m-priya", "priya's own long password");
    const app = await ravisApp(db);
    try {
      const { res, token } = await makeLink(app);
      assert.equal(res.status, 422);
      assert.equal(token, "");
    } finally { await app.close(); }
  });

  test("not for somebody holding private records — the server command is named instead", async () => {
    const db = household();
    createAccount(db, { memberId: "m-priya", source: "ui" }, {
      name: "Priya's own savings", kind: "tracking", subtype: "savings",
      holderMemberId: "m-priya", visibility: "private",
    });
    const app = await ravisApp(db);
    try {
      const { res, page, token } = await makeLink(app);
      assert.equal(res.status, 422);
      assert.equal(token, "");
      assert.match(page, /npm run password-link/);
      assert.doesNotMatch(page, /Priya&#39;s own savings|Priya's own savings/);
    } finally { await app.close(); }
  });

  test("not for a removed member", async () => {
    const db = household();
    execute(db, `UPDATE members SET removed_at = ?, allowed = 0 WHERE id = 'm-priya'`, nowIST());
    const app = await ravisApp(db);
    try {
      const { res, token } = await makeLink(app);
      assert.ok(res.status === 422 || res.status === 404, String(res.status));
      assert.equal(token, "");
    } finally { await app.close(); }
  });

  test("not on the demo", async () => {
    const app = await ravisApp(household(), { demoMode: true });
    try {
      const { res, token } = await makeLink(app);
      assert.equal(res.status, 403);
      assert.equal(token, "");
    } finally { await app.close(); }
  });

  test("not while viewing as somebody else, even with writes on", async () => {
    const db = household();
    seedMember(db, "m-anu", "Anu");
    const app = await ravisApp(db, { localLogin: true, adminDebug: true });
    try {
      assert.equal((await app.post("/impersonate/start", { member_id: "m-anu" })).status, 303);
      assert.equal((await app.post("/impersonate/writes", { allow: "1" })).status, 303);
      const { res, token } = await makeLink(app);
      assert.equal(res.status, 403);
      assert.equal(token, "");
    } finally { await app.close(); }
  });

  test("not when password sign-in is not offered at all", async () => {
    const db = household();
    execute(db, `DELETE FROM member_passwords`);
    const app = await ravisApp(db, { localLogin: false });
    try {
      assert.equal((await makeLink(app)).res.status, 404);
    } finally { await app.close(); }
  });
});

describe("Settings offers it where it can be used", () => {
  test("beside a member with no password, and not beside yourself or one who has one", async () => {
    const db = household();
    seedMember(db, "m-anu", "Anu");
    setPassword(db, "m-anu", "anu's own long password");
    const app = await ravisApp(db);
    try {
      const html = await (await app.get("/settings")).text();
      assert.match(html, /action="\/members\/m-priya\/password-link"/);
      assert.doesNotMatch(html, /action="\/members\/m-ravi\/password-link"/);
      assert.doesNotMatch(html, /action="\/members\/m-anu\/password-link"/);
    } finally { await app.close(); }
  });

  test("inviting somebody says they need a link, not that they can sign in", async () => {
    const app = await ravisApp();
    try {
      const res = await app.post("/members/invite", { email: "anu@example.com" });
      const notice = decodeURIComponent(res.headers.get("location") ?? "");
      assert.doesNotMatch(notice, /can now sign in/);
      assert.match(notice, /password link/);
    } finally { await app.close(); }
  });

  test("with Google configured, an invite still says they can sign in", async () => {
    const app = await ravisApp(household(), {
      localLogin: true, google: { clientId: "id", clientSecret: "secret" },
    });
    try {
      const res = await app.post("/members/invite", { email: "anu@example.com" });
      assert.match(decodeURIComponent(res.headers.get("location") ?? ""), /can now sign in/);
    } finally { await app.close(); }
  });
});
