/**
 * Only the server puts words in the notice banner.
 *
 * Every success message travelled as `?notice=<text>` and was shown on
 * whatever page the link opened. Escaped, so not a script — but a link to
 * this household's own instance reading "Your bank details have expired, call
 * 1800-…" in the app's own success banner is phishing with the app's
 * authority. The server now signs every notice it issues, and a notice
 * without a valid signature is not shown.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";

const PHISH = "Your account is locked — call 1800 000 0000 to restore it";

let app: TestApp;
before(async () => {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  app = await startTestApp(db, { memberId: "m-ravi" });
});
after(async () => { await app.close(); });

describe("the notice banner", () => {
  test("does not show text a link supplied", async () => {
    const html = await (await app.get(`/settings?notice=${encodeURIComponent(PHISH)}`)).text();
    assert.ok(!html.includes("call 1800"), "a link put its own words in the banner");
  });

  test("nor a notice whose signature belongs to another message", async () => {
    const res = await app.post("/members/invite", { email: "anil@example.com" });
    const location = new URL(res.headers.get("location")!, app.baseUrl);
    assert.ok(location.searchParams.get("notice"), "the invite issued no notice to tamper with");
    location.searchParams.set("notice", PHISH);
    const html = await (await app.get(location.pathname + location.search)).text();
    assert.ok(!html.includes("call 1800"), "a signature carried over to different words");
  });

  test("nor lets a link choose the banner's kind for a real one", async () => {
    const res = await app.post("/members/invite", { email: "meera@example.com" });
    const location = new URL(res.headers.get("location")!, app.baseUrl);
    location.searchParams.set("kind", "error");
    const html = await (await app.get(location.pathname + location.search)).text();
    assert.match(html, /meera@example\.com can now sign in\./, "the real notice was lost");
    assert.doesNotMatch(html, /notice-error/);
  });

  test("still shows the message the server issued", async () => {
    const res = await app.post("/members/invite", { email: "priya@example.com" });
    assert.equal(res.status, 303);
    const html = await (await app.get(res.headers.get("location")!)).text();
    assert.match(html, /priya@example\.com can now sign in\./);
  });

  test("the CAS page shows only the error it knows", async () => {
    const html = await (await app.get(`/portfolio/cas?error=${encodeURIComponent(PHISH)}`)).text();
    assert.ok(!html.includes("call 1800"), "the CAS page echoed a link's error text");
  });
});
