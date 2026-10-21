/**
 * A removed member's credentials stay dead when the member comes back.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { mintToken } from "../auth/tokens.ts";
import { inviteMember, removeMember } from "../auth/sessions.ts";

const system = { memberId: null, realMemberId: null, source: "system" as const, idempotencyKey: null };

describe("a removed member's API token", () => {
  test("does not come back to life when the member is reinstated", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    seedMember(db, "m-priya", "Priya");
    const { secret } = mintToken(
      db, { ...system, memberId: "m-priya", source: "ui" },
      { name: "script", scope: "read-write" },
    );

    removeMember(db, { ...system, memberId: "m-ravi", source: "ui" }, "m-priya");
    // Re-adding Priya restores her membership — not a credential minted before
    // she was removed, which the household believed had died with her access.
    inviteMember(db, { ...system, memberId: "m-ravi", source: "ui" }, { email: "m-priya@example.com" });

    const app = await startTestApp(db, { memberId: null });
    try {
      const res = await app.get("/settings", {
        headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
      });
      assert.equal(res.status, 401);
    } finally {
      await app.close();
    }
  });
});
