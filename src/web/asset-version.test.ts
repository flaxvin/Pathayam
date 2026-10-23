/**
 * D6 · After a deploy, a page runs the script and styles it was rendered with.
 *
 * `/assets/app.js` and `/assets/app.css` were served with an hour's cache and
 * no version in the URL, so a deploy could leave a fresh page running last
 * hour's script. The page now names each file with a short hash of its content
 * (`?v=…`, computed once at startup), and a request that carries the current
 * hash may be cached for good: the URL changes whenever the content does. A
 * request with no hash, or yesterday's, gets the short cache it always had —
 * it must not be pinned forever to content it did not ask for.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";
import { ASSET_VERSION } from "./layout.ts";
import { STYLESHEET } from "./styles.ts";
import { CLIENT_SCRIPT } from "./client.ts";

const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);

describe("D6 · the client assets are content-versioned", () => {
  let app: TestApp;

  before(async () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    app = await startTestApp(db, { memberId: "m" });
  });
  after(async () => {
    assert.deepEqual(app.failures, []);
    await app.close();
  });

  test("the version is the hash of what is served", () => {
    assert.equal(ASSET_VERSION.css, short(STYLESHEET));
    assert.equal(ASSET_VERSION.js, short(CLIENT_SCRIPT));
  });

  test("every page names both files by their current hash", async () => {
    for (const path of ["/", "/accounts", "/activity", "/settings", "/no-such-page"]) {
      const res = await app.get(path);
      assert.equal(res.status, path === "/no-such-page" ? 404 : 200, path);
      const html = await res.text();
      assert.ok(html.includes(`/assets/app.css?v=${ASSET_VERSION.css}"`), `${path} links an unversioned stylesheet`);
      assert.ok(html.includes(`/assets/app.js?v=${ASSET_VERSION.js}"`), `${path} loads an unversioned script`);
    }
  });

  test("a request with the current hash may be cached for good", async () => {
    for (const url of [`/assets/app.css?v=${ASSET_VERSION.css}`, `/assets/app.js?v=${ASSET_VERSION.js}`]) {
      const res = await app.get(url);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable", url);
    }
  });

  test("without the hash, or with a stale one, the cache stays short", async () => {
    for (const url of ["/assets/app.css", "/assets/app.js", "/assets/app.css?v=0000000000", "/assets/app.js?v=stale"]) {
      const res = await app.get(url);
      assert.equal(res.status, 200);
      const cc = res.headers.get("cache-control") ?? "";
      assert.doesNotMatch(cc, /immutable/, url);
      assert.match(cc, /max-age=3600/, url);
    }
  });
});
