/**
 * ROUTES-2 · /auth/oidc is public. When the identity provider could not be
 * discovered — down, or answering something that is not a discovery document —
 * the OAuthError went uncaught: a 500 "Something went wrong" and a
 * request_failures row per request, which the health page counts as a fault.
 * Anybody could write those rows by reloading a sign-in link. It is a 503 now.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, startTestApp } from "./harness.test-data.ts";
import { countRequestFailures } from "../ops/errors.ts";
import { clearDiscoveryCache } from "../auth/oidc.ts";

const oidc = { issuer: "https://idp.invalid", clientId: "c", clientSecret: "s", label: "single sign-on" };

for (const [label, fetchImpl] of [
  ["the provider cannot be reached", (async () => { throw new TypeError("fetch failed"); }) as typeof fetch],
  ["the provider answers an error", (async () => new Response("nope", { status: 502 })) as typeof fetch],
  ["the provider answers something that is not JSON", (async () => new Response("<html>", { status: 200 })) as typeof fetch],
] as const) {
  test(`starting a sign-in when ${label} is a 503, not a fault`, async () => {
    clearDiscoveryCache();
    const db = freshDb();
    const app = await startTestApp(db, { memberId: null, config: { oidc }, fetchImpl });
    try {
      const res = await app.get("/auth/oidc");
      assert.equal(res.status, 503);
      assert.match(await res.text(), /single sign-on is not answering/);
      assert.deepEqual(app.failures, []);
      assert.equal(countRequestFailures(db), 0);
    } finally {
      await app.close();
    }
  });
}
