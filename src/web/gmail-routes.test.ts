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
});
