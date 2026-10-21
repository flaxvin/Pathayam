/**
 * Viewing as another member (ADMIN_DEBUG) and the Gmail connection.
 *
 * A mailbox link is a credential, like an API token: it is the real person's,
 * and a time-boxed, logged view of somebody else must not make, replace, use
 * or delete theirs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { queryOne } from "../db/db.ts";
import { saveConnection } from "../gmail/connection.ts";

const system = { memberId: null, realMemberId: null, source: "system" as const, idempotencyKey: null };

describe("Gmail while viewing as another member", () => {
  const google = { clientId: "cid", clientSecret: "secret" };
  const fakeGoogle: typeof fetch = async () =>
    new Response(JSON.stringify({ refresh_token: "ravi-refresh", access_token: "a", scope: "s" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });

  test("a read-only view cannot overwrite the viewed member's mailbox connection", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    seedMember(db, "m-priya", "Priya");
    saveConnection(db, { ...system, memberId: "m-priya", source: "ui" }, {
      email: "priya@example.com", refreshToken: "priya-refresh", scope: "s",
    });

    const app = await startTestApp(db, {
      memberId: "m-ravi", config: { adminDebug: true, google }, fetchImpl: fakeGoogle,
    });
    try {
      assert.equal((await app.post("/impersonate/start", { member_id: "m-priya" })).status, 303);

      // Both legs are GETs, so read-only mode did not stop them.
      const connect = await app.get("/gmail/connect");
      const state = connect.status === 303
        ? new URL(connect.headers.get("location")!).searchParams.get("state")
        : null;
      if (state) await app.get(`/gmail/callback?state=${state}&code=c`);

      const row = queryOne<{ refresh_token: string; email: string }>(
        db, `SELECT refresh_token, email FROM gmail_connections WHERE member_id = 'm-priya'`,
      );
      assert.equal(row?.refresh_token, "priya-refresh");
      assert.equal(row?.email, "priya@example.com");
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("writes enabled still do not use or delete the viewed member's mailbox", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    seedMember(db, "m-priya", "Priya");
    for (const id of ["m-ravi", "m-priya"]) {
      saveConnection(db, { ...system, memberId: id, source: "ui" }, {
        email: `${id}@example.com`, refreshToken: `${id}-refresh`, scope: "s",
      });
    }
    const used: string[] = [];
    const recording: typeof fetch = async (_url, init) => {
      const m = /refresh_token=([^&]+)/.exec(String(init?.body ?? ""));
      if (m) used.push(decodeURIComponent(m[1]!));
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    };

    const app = await startTestApp(db, {
      memberId: "m-ravi", config: { adminDebug: true, google }, fetchImpl: recording,
    });
    try {
      await app.post("/impersonate/start", { member_id: "m-priya" });
      await app.post("/impersonate/writes", { allow: "1" });

      await app.post("/gmail/fetch", {});
      assert.ok(!used.includes("m-priya-refresh"), `used ${used.join(",")}`);

      await app.post("/gmail/disconnect", {});
      assert.ok(queryOne(db, `SELECT 1 FROM gmail_connections WHERE member_id = 'm-priya'`));
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
