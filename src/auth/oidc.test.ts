/**
 * Signing in against somebody else's identity provider.
 *
 * The tests that matter are the rejections. An authorization-code exchange
 * happens over TLS straight to the provider, so the happy path is mostly the
 * provider's business; what this module has to get right is refusing a token
 * that came from the wrong place, was minted for a different application, or
 * has expired — and saying something useful when the configuration is wrong,
 * because that error arrives in the middle of a redirect chain where nobody
 * can read a stack trace.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { discover, beginOidc, parseOidcIdToken, exchangeOidcCode, clearDiscoveryCache } from "./oidc.ts";
import { OAuthError } from "./google.ts";

const ISSUER = "https://auth.example/realms/home";
const CLIENT = "pathayam";

const DOC = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

/** A fetch that serves a discovery document and records what was asked for. */
function stubFetch(doc: unknown = DOC, status = 200) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    calls.push(String(url));
    return jsonResponse(doc, status);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function idToken(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

const VALID = {
  iss: ISSUER, aud: CLIENT, sub: "user-1",
  email: "Ravi@Example.com", name: "Ravi", exp: 4_000_000_000,
};

beforeEach(() => clearDiscoveryCache());

describe("discovery", () => {
  test("asks for the well-known document under the issuer, path and all", async () => {
    const { impl, calls } = stubFetch();
    await discover(ISSUER, impl);
    assert.equal(calls[0], `${ISSUER}/.well-known/openid-configuration`);
  });

  test("a trailing slash on the issuer does not double up", async () => {
    const { impl, calls } = stubFetch();
    await discover(`${ISSUER}/`, impl);
    assert.equal(calls[0], `${ISSUER}/.well-known/openid-configuration`);
  });

  test("is cached, so the provider is not asked twice per sign-in", async () => {
    const { impl, calls } = stubFetch();
    await discover(ISSUER, impl);
    await discover(ISSUER, impl);
    assert.equal(calls.length, 1);
  });

  test("a provider calling itself something else is refused", async () => {
    // The shape of a mix-up attack, and also what a typo looks like.
    const { impl } = stubFetch({ ...DOC, issuer: "https://someone-else.example" });
    await assert.rejects(() => discover(ISSUER, impl), OAuthError);
  });

  test("a document missing its endpoints is refused by name", async () => {
    const { impl } = stubFetch({ issuer: ISSUER });
    await assert.rejects(
      () => discover(ISSUER, impl),
      (e: Error) => /authorization_endpoint/.test(e.message),
    );
  });

  test("an unreachable provider says where it tried, in full", async () => {
    /*
     * The URL is compared whole rather than looked for inside the message.
     * "the message mentions the issuer" passes for a message naming any URL
     * that merely begins with it — including the bare issuer, which is the one
     * thing this must not say. What a self-hoster needs is the *discovery*
     * URL: the well-known path is appended to the issuer without stripping a
     * path element, and getting that wrong is the usual misconfiguration.
     * Pinning the exact string is what makes this test able to fail.
     */
    const impl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    await assert.rejects(
      () => discover(ISSUER, impl),
      (e: Error) => {
        // The trailing "." is the sentence's, not the URL's.
        const named = e.message.match(/https?:\/\/\S+/)?.[0].replace(/\.$/, "");
        assert.equal(
          named, `${ISSUER}/.well-known/openid-configuration`,
          "the error does not name the document it actually asked for",
        );
        assert.match(e.message, /ECONNREFUSED/, "the underlying cause is swallowed");
        return true;
      },
    );
  });

  test("a 404 points at the setting to check", async () => {
    const { impl } = stubFetch({}, 404);
    await assert.rejects(() => discover(ISSUER, impl), (e: Error) => /OIDC_ISSUER/.test(e.message));
  });
});

describe("the redirect", () => {
  test("carries PKCE, state and the client", async () => {
    const { impl } = stubFetch();
    const start = await beginOidc({ issuer: ISSUER, clientId: CLIENT, clientSecret: "s" },
      "https://budget.example/auth/oidc/callback", impl);
    const url = new URL(start.url);
    assert.equal(url.origin + url.pathname, DOC.authorization_endpoint);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("code_challenge"));
    assert.equal(url.searchParams.get("state"), start.state);
    assert.equal(url.searchParams.get("client_id"), CLIENT);
    assert.match(url.searchParams.get("scope")!, /openid/);
  });

  test("the verifier is not the challenge", async () => {
    // Sending the verifier as the challenge defeats the whole mechanism.
    const { impl } = stubFetch();
    const start = await beginOidc({ issuer: ISSUER, clientId: CLIENT, clientSecret: "s" },
      "https://budget.example/cb", impl);
    assert.notEqual(new URL(start.url).searchParams.get("code_challenge"), start.codeVerifier);
  });

  test("two starts do not share a state", async () => {
    const { impl } = stubFetch();
    const a = await beginOidc({ issuer: ISSUER, clientId: CLIENT, clientSecret: "s" }, "https://b/cb", impl);
    const b = await beginOidc({ issuer: ISSUER, clientId: CLIENT, clientSecret: "s" }, "https://b/cb", impl);
    assert.notEqual(a.state, b.state);
    assert.notEqual(a.codeVerifier, b.codeVerifier);
  });
});

describe("the identity token", () => {
  test("a good one yields a profile, with the email lowercased", () => {
    const p = parseOidcIdToken(idToken(VALID), ISSUER, CLIENT);
    assert.equal(p.email, "ravi@example.com");
    assert.equal(p.sub, "user-1");
    assert.equal(p.name, "Ravi");
  });

  test("one from another issuer is refused", () => {
    assert.throws(
      () => parseOidcIdToken(idToken({ ...VALID, iss: "https://evil.example" }), ISSUER, CLIENT),
      OAuthError,
    );
  });

  test("one minted for another application is refused", () => {
    /*
     * The case TLS does not cover: the right provider, the right signature,
     * and a token that belongs to somebody else's client.
     */
    assert.throws(
      () => parseOidcIdToken(idToken({ ...VALID, aud: "some-other-app" }), ISSUER, CLIENT),
      OAuthError,
    );
  });

  test("an audience array containing us is accepted", () => {
    const p = parseOidcIdToken(idToken({ ...VALID, aud: ["other", CLIENT] }), ISSUER, CLIENT);
    assert.equal(p.sub, "user-1");
  });

  test("an expired one is refused", () => {
    assert.throws(
      () => parseOidcIdToken(idToken({ ...VALID, exp: 1_000 }), ISSUER, CLIENT),
      OAuthError,
    );
  });

  test("no email is refused, and says why it matters", () => {
    const { email, ...withoutEmail } = VALID;
    void email;
    assert.throws(
      () => parseOidcIdToken(idToken(withoutEmail), ISSUER, CLIENT),
      (e: Error) => /email/.test(e.message),
    );
  });

  test("a malformed token does not throw something unreadable", () => {
    for (const bad of ["", "one.two", "not-a-token", "a.!!!.c"]) {
      assert.throws(() => parseOidcIdToken(bad, ISSUER, CLIENT), OAuthError, `on ${bad}`);
    }
  });

  test("preferred_username stands in for a missing name", () => {
    const { name, ...rest } = VALID;
    void name;
    const p = parseOidcIdToken(idToken({ ...rest, preferred_username: "ravi.m" }), ISSUER, CLIENT);
    assert.equal(p.name, "ravi.m");
  });
});

describe("exchanging the code", () => {
  test("posts to the token endpoint with the verifier", async () => {
    const seen: { url: string; body: string }[] = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes(".well-known")) return jsonResponse(DOC);
      seen.push({ url: u, body: String(init?.body ?? "") });
      return jsonResponse({ id_token: idToken(VALID) });
    }) as unknown as typeof fetch;

    const profile = await exchangeOidcCode({
      config: { issuer: ISSUER, clientId: CLIENT, clientSecret: "shh" },
      redirectUri: "https://budget.example/cb", code: "abc", codeVerifier: "verifier-1",
      fetchImpl: impl,
    });

    assert.equal(profile.email, "ravi@example.com");
    assert.equal(seen[0]!.url, DOC.token_endpoint);
    assert.match(seen[0]!.body, /code_verifier=verifier-1/);
    assert.match(seen[0]!.body, /grant_type=authorization_code/);
  });

  test("a refusal repeats what the provider said", async () => {
    const impl = (async (url: string | URL) => {
      if (String(url).includes(".well-known")) return jsonResponse(DOC);
      return jsonResponse({ error: "invalid_client", error_description: "Bad client secret" }, 401);
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => exchangeOidcCode({
        config: { issuer: ISSUER, clientId: CLIENT, clientSecret: "wrong" },
        redirectUri: "https://budget.example/cb", code: "abc", codeVerifier: "v",
        fetchImpl: impl,
      }),
      (e: Error) => /Bad client secret/.test(e.message),
    );
  });

  test("a response with no id_token is refused", async () => {
    const impl = (async (url: string | URL) => {
      if (String(url).includes(".well-known")) return jsonResponse(DOC);
      return jsonResponse({ access_token: "only-this" });
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => exchangeOidcCode({
        config: { issuer: ISSUER, clientId: CLIENT, clientSecret: "s" },
        redirectUri: "https://b/cb", code: "abc", codeVerifier: "v", fetchImpl: impl,
      }),
      (e: Error) => /id_token/.test(e.message),
    );
  });
});
