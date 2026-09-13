/**
 * B121 · F21.1 · Installable means the icons actually load.
 *
 * The manifest named `/assets/icon-192.png`, `/assets/icon-512.png` and a
 * maskable one from the day it was written. The static middleware served the
 * stylesheet, the script and the SVG, and threw NotFound for everything else
 * under `/assets/` — so all three 404'd. Chrome will not offer to install a web
 * app until at least one icon of 192px or more loads, which means the app had a
 * manifest, a service-worker-free design, HTTPS in production, and no install
 * prompt on any device, for its whole life.
 *
 * `link-coverage.test.ts` did not see it: a manifest is not a link. So the
 * manifest is checked against what the app serves, here, over real HTTP.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

describe("F21.1 · the app is installable", () => {
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

  test("the manifest is served, and says what an install needs to know", async () => {
    const res = await app.get("/manifest.webmanifest");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/manifest\+json/);

    const manifest = JSON.parse(await res.text());
    assert.equal(manifest.name, "Pathayam");
    assert.equal(manifest.start_url, "/");
    assert.equal(manifest.display, "standalone");
    assert.ok(manifest.icons.length > 0);
  });

  test("every icon the manifest names is actually served", async () => {
    const manifest = JSON.parse(await (await app.get("/manifest.webmanifest")).text());
    for (const icon of manifest.icons as ManifestIcon[]) {
      const res = await app.get(icon.src);
      assert.equal(res.status, 200, `${icon.src} answered ${res.status}`);
      assert.equal(
        res.headers.get("content-type"), icon.type,
        `${icon.src} is served as something other than what the manifest promised`,
      );
      const bytes = (await res.arrayBuffer()).byteLength;
      assert.ok(bytes > 500, `${icon.src} is ${bytes} bytes, which is not an icon`);
    }
  });

  test("one of them is at least 192px, which is what Chrome requires", async () => {
    const manifest = JSON.parse(await (await app.get("/manifest.webmanifest")).text());
    const big = (manifest.icons as ManifestIcon[]).filter(
      (i) => Number(i.sizes.split("x")[0]) >= 192,
    );
    assert.ok(big.length > 0, "no icon is large enough for an install prompt");

    // And the bytes really are that size: a 512 entry pointing at a 32px file
    // passes every check above and fails on the phone.
    for (const icon of big) {
      const png = Buffer.from(await (await app.get(icon.src)).arrayBuffer());
      assert.deepEqual(
        [...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        `${icon.src} is not a PNG`,
      );
      // IHDR width and height are big-endian 32-bit at bytes 16 and 20.
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      const declared = Number(icon.sizes.split("x")[0]);
      assert.equal(width, declared, `${icon.src} is ${width}px wide, not ${declared}`);
      assert.equal(height, declared, `${icon.src} is ${height}px tall, not ${declared}`);
    }
  });

  test("a maskable icon is offered, so Android does not letterbox the tile", async () => {
    const manifest = JSON.parse(await (await app.get("/manifest.webmanifest")).text());
    assert.ok(
      (manifest.icons as ManifestIcon[]).some((i) => i.purpose === "maskable"),
      "without one, a launcher crops the square tile and the corners go with it",
    );
  });

  test("the page links the icons a manifest cannot carry", async () => {
    const html = await (await app.get("/")).text();
    // iOS reads none of the manifest's icons.
    assert.match(html, /rel="apple-touch-icon" href="\/assets\/apple-touch-icon\.png"/);
    assert.match(html, /rel="icon" href="\/assets\/icon\.svg"/);
    assert.match(html, /rel="manifest"/);
    assert.match(html, /name="theme-color"/);
  });

  test("the icons it links are served too", async () => {
    for (const path of [
      "/assets/icon.svg",
      "/assets/apple-touch-icon.png",
      "/assets/favicon-32.png",
      "/assets/favicon-16.png",
    ]) {
      assert.equal((await app.get(path)).status, 200, `${path} is linked and not served`);
    }
  });

  test("an asset that does not exist is still a 404", async () => {
    assert.equal((await app.get("/assets/nothing-here.png")).status, 404);
  });
});
