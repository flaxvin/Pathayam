import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openDatabase, ensureHousehold, execute, queryOne } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import {
  protectedResourceMetadata, authorizationServerMetadata, mcpUnauthorized, mcpResource,
  redirectUriProblem, redirectUriMatches, registerClient, pruneOAuth, pkceMatches,
  isOurResource, parseAuthorizeRequest, approveAuthorization, tokenRequest, getClient,
  clientIdFrom, MAX_CLIENTS, OAuthError,
} from "./oauth.ts";
import { tokenMayReach, authenticateToken, listTokens } from "./tokens.ts";

const BASE = "https://budget.example";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m-ravi", "ravi@example.com", "Ravi", nowIST());
  return db;
}

function expectOAuthError(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof OAuthError && err.code === code);
}

describe("OAUTH · metadata", () => {
  test("protected resource metadata names /mcp and this server, and nothing else", () => {
    const prm = protectedResourceMetadata(`${BASE}/`);
    assert.equal(prm.resource, `${BASE}/mcp`);
    assert.deepEqual(prm.authorization_servers, [BASE], "no trailing slash: the issuer is compared as a string");
    assert.deepEqual(prm.scopes_supported, ["read"]);
  });

  test("authorization server metadata has what a client refuses to start without", () => {
    const as = authorizationServerMetadata(BASE);
    assert.equal(as.issuer, BASE);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(as.response_types_supported, ["code"]);
    assert.deepEqual(as.grant_types_supported, ["authorization_code", "refresh_token"]);
    assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
    assert.deepEqual(as.scopes_supported, ["read"]);
    assert.equal(as.registration_endpoint, `${BASE}/oauth/register`);
    assert.equal(as.authorization_response_iss_parameter_supported, true);
  });

  test("mcpUnauthorized is a 401 pointing at the metadata", () => {
    const res = mcpUnauthorized(BASE);
    assert.equal(res.status, 401);
    assert.equal(
      res.headers!["WWW-Authenticate"],
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource", scope="read"`,
    );
    assert.match(mcpUnauthorized(BASE, { invalidToken: true }).headers!["WWW-Authenticate"]!, /error="invalid_token"/);
  });

  test("the resource is ours with case aside, and nothing else is", () => {
    assert.ok(isOurResource(BASE, `${BASE}/mcp`));
    assert.ok(isOurResource(BASE, "HTTPS://Budget.Example/mcp"));
    assert.ok(isOurResource(BASE, `${BASE}/mcp/`));
    assert.ok(!isOurResource(BASE, BASE));
    assert.ok(!isOurResource(BASE, "https://other.example/mcp"));
    assert.ok(!isOurResource(BASE, `${BASE}/mcp#x`));
  });
});

describe("OAUTH · registration (RFC 7591)", () => {
  test("redirect URIs: https, or http on loopback; never a script, a fragment or a password", () => {
    assert.equal(redirectUriProblem(CALLBACK), null);
    assert.equal(redirectUriProblem("https://chatgpt.com/connector_platform_oauth_redirect"), null);
    assert.equal(redirectUriProblem("http://localhost:3118/callback"), null);
    assert.equal(redirectUriProblem("http://127.0.0.1/callback"), null);
    assert.equal(redirectUriProblem("http://[::1]:9000/cb"), null);
    for (const bad of [
      "javascript:alert(1)", "data:text/html,hi", "http://evil.example/cb", "cursor://x/cb",
      "https://a.example/cb#frag", "https://user:pw@a.example/cb", "/relative", "",
      "http://localhost.evil.example/cb", "https://a.example/\ncb", `https://a.example/${"x".repeat(2100)}`,
    ]) {
      assert.notEqual(redirectUriProblem(bad), null, bad);
    }
  });

  test("a loopback redirect matches on any port; everything else exactly", () => {
    const registered = [CALLBACK, "http://localhost/callback", "http://127.0.0.1/callback"];
    assert.ok(redirectUriMatches(registered, CALLBACK));
    assert.ok(redirectUriMatches(registered, "http://localhost:3118/callback"));
    assert.ok(redirectUriMatches(registered, "http://127.0.0.1:50000/callback"));
    assert.ok(!redirectUriMatches(registered, "http://localhost:3118/other"));
    assert.ok(!redirectUriMatches(registered, `${CALLBACK}/x`));
    assert.ok(!redirectUriMatches(registered, "https://claude.ai:444/api/mcp/auth_callback"));
    assert.ok(!redirectUriMatches(registered, "http://[::1]:3118/callback"), "a different loopback host");
  });

  test("RFC 8252 §7.3 · Gemini CLI registers a loopback port and may come back on another", () => {
    // Gemini CLI registers http://localhost:<port>/oauth/callback by DCR, and
    // a later sign-in may listen on a different free port.
    const registered = ["http://localhost:7777/oauth/callback", "http://[::1]:7777/oauth/callback"];
    assert.ok(redirectUriMatches(registered, "http://localhost:7777/oauth/callback"));
    assert.ok(redirectUriMatches(registered, "http://localhost:49152/oauth/callback"));
    assert.ok(redirectUriMatches(registered, "http://localhost/oauth/callback"));
    assert.ok(redirectUriMatches(registered, "http://[::1]:5000/oauth/callback"));
    // Scheme, host and path still have to agree; only the port is free.
    assert.ok(!redirectUriMatches(registered, "https://localhost:7777/oauth/callback"));
    assert.ok(!redirectUriMatches(registered, "http://127.0.0.1:7777/oauth/callback"));
    assert.ok(!redirectUriMatches(registered, "http://localhost:7777/oauth/callback2"));
    assert.ok(!redirectUriMatches(registered, "http://localhost:7777/oauth/callback?x=1"));
    // And never for a name that is not loopback.
    assert.ok(!redirectUriMatches(["https://app.example:8443/cb"], "https://app.example:9443/cb"));
    assert.ok(!redirectUriMatches(["http://localhost.evil.example:1/cb"], "http://localhost.evil.example:2/cb"));
  });

  test("Gemini's relay redirect URIs on googleusercontent.com register as ordinary https", () => {
    const db = setup();
    const uris = Array.from({ length: 6 }, (_, i) => `https://oauth-redirect${i ? `-${i}` : ""}.googleusercontent.com/r/x`);
    const out = registerClient(db, { client_name: "Gemini", redirect_uris: uris });
    assert.deepEqual(out.redirect_uris, uris);
  });

  test("registers a public client, whatever authentication it asks for", () => {
    const db = setup();
    const out = registerClient(db, {
      client_name: "Claude", redirect_uris: [CALLBACK], token_endpoint_auth_method: "client_secret_basic",
    });
    assert.match(String(out.client_id), /^pcl_/);
    assert.equal(out.token_endpoint_auth_method, "none");
    assert.equal(out.client_secret, undefined);
    assert.equal(getClient(db, String(out.client_id))!.client_name, "Claude");
  });

  test("refuses oversize names, too many URIs, other grants, and no URIs", () => {
    const db = setup();
    expectOAuthError(() => registerClient(db, { client_name: "x".repeat(101), redirect_uris: [CALLBACK] }), "invalid_client_metadata");
    expectOAuthError(() => registerClient(db, { redirect_uris: Array(11).fill(CALLBACK) }), "invalid_redirect_uri");
    expectOAuthError(() => registerClient(db, { redirect_uris: [CALLBACK], grant_types: ["client_credentials"] }), "invalid_client_metadata");
    expectOAuthError(() => registerClient(db, { redirect_uris: [CALLBACK], response_types: ["token"] }), "invalid_client_metadata");
    expectOAuthError(() => registerClient(db, {}), "invalid_redirect_uri");
    expectOAuthError(() => registerClient(db, { redirect_uris: ["javascript:alert(1)"] }), "invalid_redirect_uri");
  });

  test("there is a ceiling, and a registration nobody approved is pruned after a day", () => {
    const db = setup();
    const then = new Date("2026-11-01T00:00:00Z");
    for (let i = 0; i < MAX_CLIENTS; i++) registerClient(db, { redirect_uris: [CALLBACK] }, then);
    expectOAuthError(() => registerClient(db, { redirect_uris: [CALLBACK] }, then), "temporarily_unavailable");

    pruneOAuth(db, new Date("2026-11-02T01:00:00Z"));
    assert.equal(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM oauth_clients`)!.n, 0);
    registerClient(db, { redirect_uris: [CALLBACK] }, new Date("2026-11-02T01:00:00Z"));
  });

  test("a client name cannot carry control or direction-override characters", () => {
    const db = setup();
    const out = registerClient(db, { client_name: "Cla‮ude\u0007", redirect_uris: [CALLBACK] });
    assert.equal(out.client_name, "Claude");
  });
});

describe("OAUTH · codes and tokens", () => {
  test("PKCE S256: base64url of the verifier's SHA-256, and nothing near it", () => {
    const verifier = "dBjftJeZ4CVP-mJ92K1qUdiNlC5yYmlIgQnl4pz0EAU";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    assert.ok(pkceMatches(verifier, challenge));
    assert.ok(!pkceMatches(verifier, verifier), "plain is not S256");
    assert.ok(!pkceMatches(`${verifier}x`, challenge));
    assert.ok(!pkceMatches(verifier, challenge.slice(0, -1)));
    assert.ok(!pkceMatches("short", createHash("sha256").update("short").digest("base64url")));
  });

  test("a public client may name itself by HTTP Basic with no secret", () => {
    assert.equal(clientIdFrom({}, `Basic ${Buffer.from("pcl_abc:").toString("base64")}`), "pcl_abc");
    assert.equal(clientIdFrom({ client_id: "pcl_x" }, undefined), "pcl_x");
    assert.equal(clientIdFrom({}, "Bearer bgt_x"), undefined);
  });

  test("whatever scope is asked for, the token is read-only and an hour long", () => {
    const db = setup();
    const { client_id } = registerClient(db, { client_name: "Claude", redirect_uris: [CALLBACK] }) as { client_id: string };
    const verifier = "a".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params: Record<string, string> = {
      client_id, redirect_uri: CALLBACK, response_type: "code", code_challenge: challenge,
      code_challenge_method: "S256", scope: "read write admin", resource: mcpResource(BASE),
    };
    const parsed = parseAuthorizeRequest(db, BASE, (n) => params[n]);
    assert.ok("ok" in parsed);
    const code = approveAuthorization(db, { memberId: "m-ravi", source: "ui" }, parsed.ok, { redact: false });

    const now = new Date();
    const tokens = tokenRequest(db, BASE, {
      grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: verifier,
    }, client_id, now);
    assert.equal(tokens.scope, "read");
    const auth = authenticateToken(db, `Bearer ${tokens.access_token}`);
    assert.equal(auth!.scope, "read");
    assert.equal(auth!.token.redact, 0);

    // An hour is a moment, not a date: past it the token is refused the same day.
    const later = nowIST(new Date(now.getTime() + 3601_000));
    assert.equal(authenticateToken(db, `Bearer ${tokens.access_token}`, later.slice(0, 10), later), null);

    // Not in the hand-minted list; Settings shows it as a connection instead.
    assert.deepEqual(listTokens(db, "m-ravi"), []);

    // And the schema itself will not hold any other scope.
    assert.throws(() => execute(db, `UPDATE oauth_grants SET scope = 'read-write'`));
  });

  test("an unknown grant type, client or resource is refused in OAuth's words", () => {
    const db = setup();
    const { client_id } = registerClient(db, { redirect_uris: [CALLBACK] }) as { client_id: string };
    expectOAuthError(() => tokenRequest(db, BASE, { grant_type: "password" }, client_id), "unsupported_grant_type");
    expectOAuthError(() => tokenRequest(db, BASE, { grant_type: "authorization_code" }, "pcl_nobody"), "invalid_client");
    expectOAuthError(
      () => tokenRequest(db, BASE, { grant_type: "authorization_code", code: "x", resource: "https://other.example/mcp" }, client_id),
      "invalid_target",
    );
    expectOAuthError(() => tokenRequest(db, BASE, { grant_type: "authorization_code", code: "nope" }, client_id), "invalid_grant");
  });

  test("a bearer token can never reach the OAuth routes", () => {
    for (const path of ["/oauth/authorize", "/oauth/token", "/oauth//register", "/oauth/"]) {
      assert.equal(tokenMayReach(path), false, path);
    }
    assert.equal(tokenMayReach("/export.json"), true);
  });
});
