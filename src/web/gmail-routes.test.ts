/**
 * The two Gmail routes that talk to Google, when Google says no.
 *
 * A grant the member revoked at myaccount.google.com, a refresh token Google
 * has expired, or a code it refuses all arrive as `GmailAuthError` — a
 * sentence written for the household ("Reconnect Gmail"). Neither route
 * caught it, so it reached the generic 500 page as "Something went wrong" and
 * was recorded as a server fault, which the health page reports.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { saveConnection } from "../gmail/connection.ts";

const GOOGLE = { clientId: "cid", clientSecret: "sec" };
const refusing = (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as typeof fetch;

describe("Gmail when Google refuses", () => {
  test("fetching on a revoked grant says Google refused, and is not a fault", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    saveConnection(db, { memberId: "m-ravi", source: "ui" }, {
      email: "m-ravi@example.com", refreshToken: "rt", scope: "gmail.readonly",
    });
    const app = await startTestApp(db, { memberId: "m-ravi", config: { google: GOOGLE }, fetchImpl: refusing });
    try {
      const res = await app.post("/gmail/fetch", {});
      assert.ok(res.status < 500, `answered ${res.status}`);
      assert.match(await res.text(), /Google rejected/);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("a code Google rejects at the callback is not a fault", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, { memberId: "m-ravi", config: { google: GOOGLE }, fetchImpl: refusing });
    try {
      const start = await app.get("/gmail/connect");
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const res = await app.get(`/gmail/callback?state=${state}&code=x`);
      assert.ok(res.status < 500, `answered ${res.status}`);
      assert.match(await res.text(), /Google rejected/);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  /*
   * DEBUG-WEB-7 · Google out of reach is not this server failing. A refused
   * connection, or a captive portal answering the token endpoint with HTML,
   * reached the generic 500 page and the health page's fault list.
   */
  for (const [name, impl] of [
    ["the token endpoint unreachable", (async () => { throw new TypeError("fetch failed"); }) as typeof fetch],
    ["the token endpoint answering HTML", (async () => new Response("<html>portal</html>", { status: 200 })) as typeof fetch],
    ["the Gmail API unreachable", (async (url: string | URL | Request) => {
      if (String(url).includes("oauth2")) return Response.json({ access_token: "at", expires_in: 3600 });
      throw new TypeError("fetch failed");
    }) as typeof fetch],
    ["the Gmail API answering 503", (async (url: string | URL | Request) => {
      if (String(url).includes("oauth2")) return Response.json({ access_token: "at", expires_in: 3600 });
      return new Response("busy", { status: 503 });
    }) as typeof fetch],
  ] as const) {
    test(`fetching with ${name} says Google could not be reached, and is not a fault`, async () => {
      const db = freshDb();
      seedMember(db, "m-ravi", "Ravi");
      saveConnection(db, { memberId: "m-ravi", source: "ui" }, {
        email: "m-ravi@example.com", refreshToken: "rt", scope: "gmail.readonly",
      });
      const app = await startTestApp(db, { memberId: "m-ravi", config: { google: GOOGLE }, fetchImpl: impl });
      try {
        const res = await app.post("/gmail/fetch", {});
        assert.equal(res.status, 502);
        assert.match(await res.text(), /reach Google/);
        assert.deepEqual(app.failures, []);
      } finally {
        await app.close();
      }
    });
  }

  test("a callback with the token endpoint unreachable is not a fault", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    const app = await startTestApp(db, { memberId: "m-ravi", config: { google: GOOGLE }, fetchImpl: down });
    try {
      const start = await app.get("/gmail/connect");
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const res = await app.get(`/gmail/callback?state=${state}&code=x`);
      assert.equal(res.status, 502);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
