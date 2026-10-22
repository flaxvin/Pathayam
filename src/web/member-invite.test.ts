/**
 * An address on the allow-list has to be an address.
 *
 * `requiredField` refuses only the empty string, so "   " and "priya" reached
 * inviteMember and became members: a nameless row with an empty email on
 * Settings, counted as a person everywhere members are counted. On
 * /auth/first-run it was worse — the household's only member got an email
 * nobody can type into the sign-in form, and the door closed behind it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { queryOne } from "../db/db.ts";

const count = (db: ReturnType<typeof freshDb>) =>
  queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM members`)!.n;

describe("DEBUG-WEB-4 · inviting needs a real address", () => {
  test("a blank or address-less invite is refused, and adds nobody", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      for (const email of ["   ", "priya", "@example.com", "priya@"]) {
        const res = await app.post("/members/invite", { email });
        assert.equal(res.status, 422, JSON.stringify(email));
      }
      assert.equal(count(db), 1);
      const ok = await app.post("/members/invite", { email: " Priya@Example.com " });
      assert.equal(ok.status, 303);
      assert.equal(count(db), 2);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("the first password cannot create a member nobody can sign in as", async () => {
    const db = freshDb();
    const app = await startTestApp(db, { memberId: null, config: { localLogin: true } });
    try {
      const res = await app.post("/auth/first-run", {
        name: "Ravi", email: "   ", password: "correct horse battery staple",
      });
      assert.equal(res.status, 422);
      assert.equal(count(db), 0, "the door stays open to try again");
    } finally {
      await app.close();
    }
  });
});
