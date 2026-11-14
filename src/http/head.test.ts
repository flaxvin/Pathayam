/**
 * WEB-8 · HEAD answers as GET does, without the body.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

test("WEB-8 · HEAD /healthz is 200 like GET, and a page's HEAD sends no body", async () => {
  const db = freshDb();
  seedMember(db);
  const app = await startTestApp(db);
  try {
    const health = await app.get("/healthz", { method: "HEAD" });
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "");

    const budget = await app.get("/", { method: "HEAD" });
    assert.equal(budget.status, 200);
    assert.match(budget.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await budget.text(), "");

    // Still nothing that writes: a HEAD to a POST-only route is not a POST.
    const write = await app.get("/assign", { method: "HEAD" });
    assert.equal(write.status, 405);
    assert.deepEqual(app.failures, []);
  } finally {
    await app.close();
  }
});
