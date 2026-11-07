/**
 * WEB-2 · A redirect to a path with a character outside ASCII.
 *
 * Every "go back to where I was" field (`return_to`, `back`, the sign-in's
 * `next`) passes through safePath, which keeps a same-site path as given — and
 * a path is allowed to say /€ or /तारीख. Node refuses such a Location header
 * (ERR_INVALID_CHAR), so the response threw after the work was done: the theme
 * changed under a 500, and a sign-in reached from /signin?next=/€ — any link
 * can carry one — answered 500 and dropped the session cookie it had just
 * minted, so the right password never signed anybody in. The Location is now
 * percent-encoded, which is what a browser would have sent for it anyway.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { setPassword } from "../auth/passwords.ts";

describe("WEB-2 · a non-ASCII path to go back to", () => {
  test("the theme switch redirects to it, percent-encoded, rather than a 500", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const res = await app.post("/settings/theme", { theme: "dark", return_to: "/€?x=日本" });
      assert.equal(res.status, 303, await res.text());
      assert.equal(res.headers.get("location"), "/%E2%82%AC?x=%E6%97%A5%E6%9C%AC");
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("password sign-in with such a next signs in instead of answering 500", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    setPassword(db, "m-ravi", "correct horse battery staple");
    const app = await startTestApp(db, { memberId: null, config: { localLogin: true } });
    try {
      const email = (db.prepare("SELECT email FROM members WHERE id = 'm-ravi'").get() as { email: string }).email;
      const res = await app.post("/auth/password", {
        email, password: "correct horse battery staple", next: "/€",
      });
      assert.equal(res.status, 303, await res.text());
      assert.equal(res.headers.get("location"), "/%E2%82%AC");
      assert.ok(res.headers.get("set-cookie")?.includes("pathayam_session="), "no session cookie");
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
