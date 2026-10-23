/**
 * Signing out is always possible, including in the middle of a read-only view.
 *
 * The read-only guard refused every non-GET except the two impersonation
 * controls, so "Sign out of this device" answered 403 — "Enable writes first,
 * or exit" — to somebody viewing as another member. On a shared laptop that
 * left the session (the real member's) signed in after they believed they had
 * left it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { queryOne } from "../db/db.ts";

describe("signing out while viewing as another member", () => {
  test("ends the session in read-only mode", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    seedMember(db, "m-priya", "Priya");
    const app = await startTestApp(db, { memberId: "m-ravi", config: { adminDebug: true } });
    try {
      assert.equal((await app.post("/impersonate/start", { member_id: "m-priya" })).status, 303);

      const res = await app.post("/signout", {});
      assert.equal(res.status, 303);
      assert.equal(res.headers.get("location"), "/signin");
      assert.equal(
        queryOne(db, `SELECT 1 FROM sessions WHERE member_id = 'm-ravi' AND revoked_at IS NULL`),
        null,
      );
      // And the cookie no longer opens anything.
      assert.equal((await app.get("/settings")).status, 303);
    } finally {
      await app.close();
    }
  });
});
