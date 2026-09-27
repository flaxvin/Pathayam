/**
 * F30.6 over HTTP · what a bearer token can and cannot reach, asked of the
 * running server rather than of `tokenMayReach` alone.
 *
 * The unit test proves the deny-list's rule; this proves the request a client
 * actually sends is judged by it. They came apart once (SECURITY-OPS-12): the
 * router read "/.//tokens" as /tokens and the deny-list read it as something
 * else, so a token minted tokens.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { queryAll, queryOne } from "../db/db.ts";
import { mintToken } from "../auth/tokens.ts";

/**
 * A raw request, because `fetch` normalises the path it is given and would
 * never send the spelling under test.
 */
function raw(
  baseUrl: string, method: string, path: string,
  headers: Record<string, string>, body = "",
): Promise<{ status: number; body: string }> {
  const u = new URL(baseUrl);
  return new Promise((ok, fail) => {
    const req = request(
      {
        host: u.hostname, port: u.port, method, path,
        headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => ok({ status: res.statusCode!, body: text }));
      },
    );
    req.on("error", fail);
    req.end(body);
  });
}

function household() {
  const db = freshDb();
  seedMember(db, "m-priya", "Priya");
  const { secret } = mintToken(
    db, { memberId: "m-priya", source: "ui" }, { name: "script", scope: "read-write" },
  );
  return { db, secret };
}

describe("API tokens over HTTP", () => {
  test("SECURITY-OPS-12 · a doubled slash does not let a token mint tokens or invite members", async () => {
    const { db, secret } = household();
    const app = await startTestApp(db, { memberId: null });
    const headers = {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html",
    };
    try {
      // ("//tokens" alone is a scheme-relative URL — host "tokens", path "/" —
      // so it lands on POST / and is a 405; refused either way.)
      for (const path of ["/tokens", "/.//tokens", "//tokens", "/tokens/", "/./tokens//"]) {
        const res = await raw(app.baseUrl, "POST", path, headers, "name=minted&scope=read-write");
        assert.ok(res.status === 403 || res.status === 405, `POST ${path} must be refused, was ${res.status}`);
        assert.doesNotMatch(res.body, /bgt_/, `POST ${path} must not show a secret`);
      }
      const invite = await raw(
        app.baseUrl, "POST", "/.//members/invite", headers, "email=outsider%40example.com",
      );
      assert.equal(invite.status, 403);

      assert.deepEqual(
        queryAll<{ name: string }>(db, `SELECT name FROM api_tokens`).map((t) => t.name),
        ["script"],
      );
      assert.equal(
        queryOne(db, `SELECT 1 FROM members WHERE email = 'outsider@example.com'`),
        null,
      );
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("SECURITY-OPS-13 · a token cannot set its member's password, and so cannot become a sign-in", async () => {
    const { db, secret } = household();
    // Priya also has a browser session, which setting a password would revoke.
    const app = await startTestApp(db, { memberId: "m-priya", config: { localLogin: true } });
    const live = () => queryOne<{ n: number }>(
      db, `SELECT COUNT(*) AS n FROM sessions WHERE member_id = 'm-priya' AND revoked_at IS NULL`,
    )!.n;
    try {
      const before = live();
      const res = await fetch(app.baseUrl + "/settings/password", {
        method: "POST", redirect: "manual",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "password=correct-horse-battery&confirm=correct-horse-battery",
      });
      assert.equal(res.status, 403);
      assert.equal(
        queryOne(db, `SELECT 1 FROM member_passwords WHERE member_id = 'm-priya'`),
        null,
      );
      assert.equal(live(), before, "her browsers stay signed in");

      const sessionId = queryOne<{ id: string }>(
        db, `SELECT id FROM sessions WHERE member_id = 'm-priya'`,
      )!.id;
      const revoke = await fetch(app.baseUrl + "/sessions/revoke", {
        method: "POST", redirect: "manual",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `session_id=${sessionId}`,
      });
      assert.equal(revoke.status, 403);
      assert.equal(live(), before);
    } finally {
      await app.close();
    }
  });

  test("a removed member's token stops working, as their sessions do", async () => {
    const { db, secret } = household();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const removed = await app.post("/members/m-priya/remove");
      assert.equal(removed.status, 303);
      assert.ok(queryOne(db, `SELECT 1 FROM members WHERE id = 'm-priya' AND removed_at IS NOT NULL`));

      const read = await raw(app.baseUrl, "GET", "/export.json", {
        Authorization: `Bearer ${secret}`, Accept: "application/json",
      });
      assert.equal(read.status, 401, "the household's export must not answer a removed member");
      const write = await raw(app.baseUrl, "POST", "/categories/new", {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      }, "name=Planted");
      assert.equal(write.status, 401);
      assert.equal(queryOne(db, `SELECT 1 FROM categories WHERE name = 'Planted'`), null);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("viewing as somebody else cannot mint a token that outlives the view", async () => {
    const { db } = household();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, { memberId: "m-ravi", config: { adminDebug: true } });
    try {
      assert.equal((await app.post("/impersonate/start", { member_id: "m-priya" })).status, 303);
      assert.equal((await app.post("/impersonate/writes", { allow: "1" })).status, 303);

      const res = await app.post("/tokens", { name: "kept", scope: "read-write" });
      assert.equal(res.status, 403);
      assert.doesNotMatch(await res.text(), /bgt_/);
      assert.equal(queryOne(db, `SELECT 1 FROM api_tokens WHERE name = 'kept'`), null);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("a doubled slash still reaches an ordinary page", async () => {
    const { db, secret } = household();
    const app = await startTestApp(db, { memberId: null });
    try {
      const res = await raw(app.baseUrl, "GET", "/.//settings", { Authorization: `Bearer ${secret}` });
      assert.equal(res.status, 200);
    } finally {
      await app.close();
    }
  });
});
