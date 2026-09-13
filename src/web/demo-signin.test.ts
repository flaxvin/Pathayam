/**
 * The demo's front door.
 *
 * A demo instance signs everybody into the same fictional household, and most
 * of what is interesting about this app is *per member*: a private account, a
 * commitment, a budget of your own, a claim between two people. All of it is
 * invisible if the demo can only ever be one person, so the door offers the
 * household — and only the part of it that is still here, because the scenario
 * removes somebody halfway through and signing in as a person who has left
 * would open the app on a member the household no longer has.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, testConfig, type TestApp } from "./harness.test-data.ts";
import { execute, queryOne } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";

let app: TestApp;

before(async () => {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  seedMember(db, "m-priya", "Priya");
  seedMember(db, "m-anil", "Anil");
  seedMember(db, "m-meera", "Meera");
  // Meera left, the way the scenario has her leave.
  execute(db, `UPDATE members SET removed_at = ? WHERE id = ?`, nowIST(), "m-meera");

  app = await startTestApp(db, {
    memberId: null,
    config: testConfig({ demoMode: true }),
  });
});
after(async () => {
  assert.deepEqual(app.failures, []);
  await app.close();
});

describe("the demo door offers the household", () => {
  test("the sign-in page lists everybody who is still here", async () => {
    const html = await (await app.get("/signin")).text();
    assert.match(html, /name="member_id"/, "there is no way to choose");
    for (const name of ["Ravi", "Priya", "Anil"]) {
      assert.match(
        html, new RegExp(`<option[^>]*>\\s*${name}\\s*</option>`),
        `${name} is not offered`,
      );
    }
  });

  test("it opens on whoever the button alone would sign you in as", async () => {
    const html = await (await app.get("/signin")).text();
    const selected = /<option value="([^"]+)"\s+selected>/.exec(html);
    assert.ok(selected, "nothing is preselected, so the two paths disagree");
    assert.equal(selected[1], "m-ravi", "the oldest member still here");
  });

  test("and does not offer the member who left", async () => {
    const html = await (await app.get("/signin")).text();
    assert.ok(
      !/<option[^>]*>\s*Meera\s*<\/option>/.test(html),
      "Meera has been removed; signing in as her would open the app on somebody " +
      "the household no longer has",
    );
  });

  test("picking somebody signs you in as them", async () => {
    const res = await app.post("/demo/enter", { member_id: "m-anil" });
    assert.equal(res.status, 303);
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.ok(cookie.length > 0, "no session was created");

    const session = queryOne<{ member_id: string }>(
      app.db, `SELECT member_id FROM sessions ORDER BY created_at DESC LIMIT 1`,
    );
    assert.equal(session?.member_id, "m-anil");
  });

  test("picking nobody still works, and takes the oldest member still here", async () => {
    const res = await app.post("/demo/enter", {});
    assert.equal(res.status, 303, "the one-button path has to keep working");
    const session = queryOne<{ member_id: string }>(
      app.db, `SELECT member_id FROM sessions ORDER BY created_at DESC LIMIT 1`,
    );
    assert.equal(session?.member_id, "m-ravi");
  });

  test("asking for a removed member gets you somebody who is here, not an error", async () => {
    const res = await app.post("/demo/enter", { member_id: "m-meera" });
    assert.equal(res.status, 303);
    const session = queryOne<{ member_id: string }>(
      app.db, `SELECT member_id FROM sessions ORDER BY created_at DESC LIMIT 1`,
    );
    assert.equal(session?.member_id, "m-ravi", "it fell back rather than signing in as a ghost");
  });

  test("asking for somebody who does not exist does the same", async () => {
    const res = await app.post("/demo/enter", { member_id: "nobody-at-all" });
    assert.equal(res.status, 303);
    const session = queryOne<{ member_id: string }>(
      app.db, `SELECT member_id FROM sessions ORDER BY created_at DESC LIMIT 1`,
    );
    assert.equal(session?.member_id, "m-ravi");
  });
});

describe("and only in demo mode", () => {
  test("the door does not exist otherwise", async () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    const plain = await startTestApp(db, { memberId: null });
    try {
      assert.equal((await plain.post("/demo/enter", { member_id: "m" })).status, 404);
      const html = await (await plain.get("/signin")).text();
      assert.ok(!html.includes("Enter the demo"));
    } finally {
      await plain.close();
    }
  });
});
