/**
 * /auth/oidc answers 503 when the provider's discovery document times out,
 * rather than holding the request open for as long as the provider does.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, startTestApp } from "./harness.test-data.ts";

// Not shared with any other test: discovery is cached per issuer for the life
// of the process.
const ISSUER = "https://slow-idp.example/realms/home";

test("a discovery fetch that times out is a 503, not a hang or a 500", async () => {
  let signalled = false;
  // Stands in for the timer firing: rejects the way fetch does on a timeout,
  // but only if the route gave the fetch a signal to be cancelled by.
  const fetchImpl = ((_url: string, init?: RequestInit) => {
    // Without a signal the real provider would hang for ever; fail plainly
    // instead, so the test reports the missing timeout rather than stalling.
    if (!init?.signal) return Promise.reject(new Error("no signal given"));
    signalled = true;
    return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
  }) as unknown as typeof fetch;

  const app = await startTestApp(freshDb(), {
    memberId: null,
    config: { oidc: { issuer: ISSUER, clientId: "c", clientSecret: "s", label: "Home SSO" } },
    fetchImpl,
  });
  try {
    const res = await app.get("/auth/oidc", { signal: AbortSignal.timeout(5_000) });
    assert.ok(signalled, "discovery was fetched with no timeout of its own");
    assert.equal(res.status, 503);
    assert.deepEqual(app.failures, [], "a slow provider was recorded as this server's fault");
  } finally {
    await app.close();
  }
});
