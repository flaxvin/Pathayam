/**
 * WEB-1 · Connect an AI with API tokens switched off.
 *
 * FEATURE_AI and FEATURE_API_TOKENS are separate modules on purpose ("an AI
 * connection is offered without hand-minted tokens, and vice versa"), but the
 * Disconnect buttons on /tokens/ai post to /tokens/connections/:id/revoke and
 * /tokens/:id/revoke, which the route table filed under API tokens. With API
 * tokens off they answered 404: a member could connect an AI app and never
 * disconnect it again.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne } from "../db/db.ts";
import { registerClient, approveAuthorization, getClient } from "../auth/oauth.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

const RAVI = "m-ravi";
const features = { apiTokens: false, ai: true };

describe("WEB-1 · an AI connection can be disconnected with API tokens off", () => {
  test("an app signed in through OAuth", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    const { client_id } = registerClient(db, {
      client_name: "Fictional AI", redirect_uris: ["https://ai.example.com/cb"],
    }) as { client_id: string };
    approveAuthorization(db, { memberId: RAVI, source: "ui" }, {
      client: getClient(db, client_id)!, redirectUri: "https://ai.example.com/cb",
      codeChallenge: "x".repeat(43), resource: "http://127.0.0.1/mcp",
    } as never, { redact: false });
    const grant = queryOne<{ id: string }>(db, `SELECT id FROM oauth_grants`)!.id;
    const app = await startTestApp(db, { memberId: RAVI, config: { features } });
    try {
      const page = await (await app.get("/tokens/ai")).text();
      assert.match(page, new RegExp(`action="/tokens/connections/${grant}/revoke"`));
      const res = await app.post(`/tokens/connections/${grant}/revoke`, { back: "/tokens/ai" });
      assert.equal(res.status, 303, await res.text());
      assert.equal(res.headers.get("location")?.split("?")[0], "/tokens/ai");
      assert.ok(queryOne<{ revoked_at: string | null }>(
        db, `SELECT revoked_at FROM oauth_grants WHERE id = ?`, grant,
      )!.revoked_at);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("an app given a token from Connect an AI", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    const app = await startTestApp(db, { memberId: RAVI, config: { features } });
    try {
      const minted = await app.post("/tokens/ai", { name: "Desktop AI", expires_in_days: "30" });
      assert.equal(minted.status, 200, await minted.text());
      const token = queryOne<{ id: string }>(db, `SELECT id FROM api_tokens WHERE for_ai = 1`)!.id;
      const res = await app.post(`/tokens/${token}/revoke`, { back: "/tokens/ai" });
      assert.equal(res.status, 303, await res.text());
      assert.ok(queryOne<{ revoked_at: string | null }>(
        db, `SELECT revoked_at FROM api_tokens WHERE id = ?`, token,
      )!.revoked_at);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("hand-minted tokens stay off: /tokens itself is still 404", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    const app = await startTestApp(db, { memberId: RAVI, config: { features } });
    try {
      assert.equal((await app.get("/tokens")).status, 404);
      assert.equal((await app.post("/tokens", { name: "script" })).status, 404);
    } finally {
      await app.close();
    }
  });
});
