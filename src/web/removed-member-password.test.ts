/**
 * A removed member's password does not survive their removal.
 *
 * Reinstating somebody restores a member, not the credentials they held
 * before — the same rule their API tokens already follow
 * (removed-member-tokens.test.ts). A password kept across the gap meant that
 * whoever learned it while they were away, or the person themselves after a
 * falling-out, was let straight back in the moment anybody re-added the
 * address, without the person re-adding them ever being told.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { setPassword, hasPassword } from "../auth/passwords.ts";
import { getMember } from "../auth/sessions.ts";
import { queryOne } from "../db/db.ts";

const OLD = "priya's old granary password";

describe("removing a member clears their password", () => {
  test("re-adding them does not bring the old password back", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    seedMember(db, "m-priya", "Priya");
    setPassword(db, "m-ravi", "ravi's own long password");
    setPassword(db, "m-priya", OLD);

    const app = await startTestApp(db, { memberId: "m-ravi", config: { localLogin: true } });
    try {
      const removed = await app.post("/members/m-priya/remove");
      assert.equal(removed.status, 303);
      assert.equal(hasPassword(db, "m-priya"), false, "the password outlived the removal");

      const readded = await app.post("/members/invite", { email: "m-priya@example.com" });
      assert.equal(readded.status, 303);
      assert.equal(getMember(db, "m-priya")!.removed_at, null, "she was not reinstated");

      // The person re-adding her is told the old password is gone, rather than
      // "can now sign in" — which, for a password, is no longer true.
      const notice = decodeURIComponent(readded.headers.get("location") ?? "");
      assert.match(notice, /password/i, `nothing said about her password: ${notice}`);

      const signin = await app.post(
        "/auth/password", { email: "m-priya@example.com", password: OLD }, { headers: { Cookie: "" } },
      );
      assert.equal(signin.status, 401, "the old password still opened the door");
    } finally {
      await app.close();
    }
  });

  test("everything else about them is kept", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    seedMember(db, "m-priya", "Priya");
    setPassword(db, "m-priya", OLD);

    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      assert.equal((await app.post("/members/m-priya/remove")).status, 303);
      const row = queryOne<{ name: string; email: string }>(
        db, `SELECT name, email FROM members WHERE id = ?`, "m-priya",
      );
      assert.deepEqual({ ...row }, { name: "Priya", email: "m-priya@example.com" });
    } finally {
      await app.close();
    }
  });

  test("the removal page says so before anybody confirms", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    seedMember(db, "m-priya", "Priya");
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const html = await (await app.get("/members/m-priya/remove")).text();
      assert.match(html, /password/i, "the page does not mention the password");
    } finally {
      await app.close();
    }
  });
});
