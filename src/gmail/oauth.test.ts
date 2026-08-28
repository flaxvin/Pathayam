import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  beginGmailConnect, exchangeGmailCode, refreshAccessToken, GmailAuthError,
} from "./oauth.ts";

describe("04 §3.4 · the Gmail authorisation is offline and read-only", () => {
  test("the consent URL asks for exactly what unattended reading needs", () => {
    const { url } = beginGmailConnect({
      clientId: "id", redirectUri: "https://x/gmail/callback",
    });
    const u = new URL(url);
    assert.equal(u.host, "accounts.google.com");
    assert.match(u.searchParams.get("scope")!, /gmail\.readonly/);
    assert.equal(u.searchParams.get("access_type"), "offline", "needed for a refresh token");
    assert.equal(u.searchParams.get("prompt"), "consent", "re-issues the refresh token");
    assert.ok(u.searchParams.has("code_challenge"), "PKCE");
    // Read-only: never a write or send scope.
    assert.doesNotMatch(u.searchParams.get("scope")!, /gmail\.(send|modify|compose)/);
  });

  test("the exchange yields a refresh token", async () => {
    const fake = (async () => new Response(JSON.stringify({
      access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "s",
    }), { status: 200 })) as unknown as typeof fetch;

    const tokens = await exchangeGmailCode({
      clientId: "id", clientSecret: "sec", redirectUri: "r", code: "c", codeVerifier: "v",
      fetchImpl: fake,
    });
    assert.equal(tokens.refreshToken, "rt");
  });

  test("a grant without offline access is rejected with a clear message", async () => {
    const fake = (async () => new Response(JSON.stringify({
      access_token: "at", expires_in: 3600, // no refresh_token
    }), { status: 200 })) as unknown as typeof fetch;

    await assert.rejects(
      () => exchangeGmailCode({
        clientId: "id", clientSecret: "sec", redirectUri: "r", code: "c", codeVerifier: "v",
        fetchImpl: fake,
      }),
      GmailAuthError,
    );
  });

  test("a revoked refresh token surfaces as a dropped connection", async () => {
    const fake = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    await assert.rejects(
      () => refreshAccessToken({ clientId: "id", clientSecret: "s", refreshToken: "rt", fetchImpl: fake }),
      GmailAuthError,
    );
  });
});
