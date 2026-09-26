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

  test("a doubled slash still reaches an ordinary page", async () => {
    const { db, secret } = household();
    const app = await startTestApp(db, { memberId: null });
    try {
      const res = await raw(app.baseUrl, "GET", "//settings", { Authorization: `Bearer ${secret}` });
      assert.equal(res.status, 200);
    } finally {
      await app.close();
    }
  });
});
