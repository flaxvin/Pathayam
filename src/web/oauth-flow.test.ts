/**
 * OAUTH over HTTP · an AI app connecting the way claude.ai and ChatGPT do,
 * from the first 401 to a working read-only token, asked of the running
 * server. src/auth/oauth.test.ts proves the rules one at a time; this proves
 * a real client's requests are judged by them, through the middleware.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";
import { execute, queryOne } from "../db/db.ts";
import { request } from "node:http";
import { removeMember, startImpersonation, createSession, SESSION_COOKIE } from "../auth/sessions.ts";
import { resetOAuthRateLimits } from "../auth/oauth.ts";
import { resetTokenRateLimits } from "../auth/tokens.ts";
import { historyFor } from "../core/events.ts";

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const BASE = "http://127.0.0.1"; // testConfig's BASE_URL
const RESOURCE = `${BASE}/mcp`;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** A request from an AI provider's server: no cookie, no Origin, no redirects followed. */
function server(app: TestApp, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(app.baseUrl + path, { redirect: "manual", ...init });
}

function form(app: TestApp, path: string, fields: Record<string, string>): Promise<Response> {
  return server(app, path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

async function register(app: TestApp, redirectUris = [CALLBACK]): Promise<string> {
  const res = await server(app, "/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: redirectUris, token_endpoint_auth_method: "none" }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    client_id: clientId, redirect_uri: CALLBACK, response_type: "code",
    code_challenge: challenge, code_challenge_method: "S256",
    state: "st-123", resource: RESOURCE, scope: "read", ...extra,
  }).toString();
}

/** Approve on the consent page as the signed-in member, and return the code. */
async function approve(app: TestApp, clientId: string, challenge: string, fields: Record<string, string> = {}) {
  const query = authorizeQuery(clientId, challenge);
  const res = await app.post("/oauth/authorize", {
    ...Object.fromEntries(new URLSearchParams(query)), decision: "approve", redact: "1", ...fields,
  });
  assert.equal(res.status, 303);
  const location = new URL(res.headers.get("location")!);
  assert.equal(`${location.origin}${location.pathname}`, CALLBACK);
  assert.equal(location.searchParams.get("state"), "st-123");
  assert.equal(location.searchParams.get("iss"), BASE);
  return location.searchParams.get("code")!;
}

async function exchange(app: TestApp, clientId: string, code: string, verifier: string, extra: Record<string, string> = {}) {
  return form(app, "/oauth/token", {
    grant_type: "authorization_code", code, redirect_uri: CALLBACK,
    client_id: clientId, code_verifier: verifier, resource: RESOURCE, ...extra,
  });
}

interface Tokens { access_token: string; refresh_token: string; expires_in: number; scope: string; token_type: string }

async function connect(app: TestApp): Promise<{ clientId: string; tokens: Tokens }> {
  const clientId = await register(app);
  const { verifier, challenge } = pkce();
  const code = await approve(app, clientId, challenge);
  const res = await exchange(app, clientId, code, verifier);
  assert.equal(res.status, 200);
  return { clientId, tokens: (await res.json()) as Tokens };
}

function bearer(token: string): RequestInit {
  return { headers: { Authorization: `Bearer ${token}` } };
}

/** A raw POST, because `fetch` will not send a Host it did not choose. */
function rawPost(
  app: TestApp, path: string, headers: Record<string, string>, fields: Record<string, string>,
): Promise<number> {
  const u = new URL(app.baseUrl);
  const body = new URLSearchParams(fields).toString();
  return new Promise((ok, fail) => {
    const req = request(
      {
        host: u.hostname, port: u.port, method: "POST", path,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": String(Buffer.byteLength(body)),
          ...headers,
        },
      },
      (res) => { res.resume(); res.on("end", () => ok(res.statusCode!)); },
    );
    req.on("error", fail);
    req.end(body);
  });
}

function sessionCookie(db: ReturnType<typeof freshDb>, memberId: string): string {
  const { token } = createSession(db, memberId, { userAgent: "test", ipHint: null, days: 1 });
  return `${SESSION_COOKIE}=${token}`;
}

function household() {
  const db = freshDb();
  seedMember(db, "m-priya", "Priya");
  seedMember(db, "m-ravi", "Ravi");
  return db;
}

describe("OAUTH · an AI app connects over HTTP", () => {
  beforeEach(() => {
    resetOAuthRateLimits();
    resetTokenRateLimits();
  });

  test("/mcp without a token is 401 with the header that starts sign-in", async () => {
    const app = await startTestApp(household(), { memberId: null });
    try {
      // A server's POST: no Origin, no cookie. Not the write rule's 403.
      const res = await server(app, "/mcp", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      assert.equal(res.status, 401);
      const header = res.headers.get("www-authenticate") ?? "";
      assert.match(header, /^Bearer /);
      assert.match(header, new RegExp(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`));
      assert.match(header, /scope="read"/);

      const bad = await server(app, "/mcp", { method: "POST", ...bearer("bgt_nonsense") });
      assert.equal(bad.status, 401);
      assert.match(bad.headers.get("www-authenticate") ?? "", /error="invalid_token"/);

      const get = await server(app, "/mcp");
      assert.equal(get.status, 401, "a GET is answered the same way");
    } finally {
      await app.close();
    }
  });

  test("the metadata documents name each other and the endpoints", async () => {
    const app = await startTestApp(household(), { memberId: null });
    try {
      for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
        const res = await server(app, path);
        assert.equal(res.status, 200, path);
        assert.equal(res.headers.get("access-control-allow-origin"), "*");
        const prm = (await res.json()) as Record<string, unknown>;
        assert.equal(prm.resource, RESOURCE);
        assert.deepEqual(prm.authorization_servers, [BASE]);
      }
      const as = (await (await server(app, "/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
      assert.equal(as.issuer, BASE);
      assert.equal(as.token_endpoint, `${BASE}/oauth/token`);
      assert.equal(as.registration_endpoint, `${BASE}/oauth/register`);
      assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
      assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
      assert.deepEqual(as.scopes_supported, ["read"]);
      assert.equal(as.authorization_response_iss_parameter_supported, true);

      const preflight = await server(app, "/oauth/token", { method: "OPTIONS" });
      assert.equal(preflight.status, 204);
      assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /POST/);
    } finally {
      await app.close();
    }
  });

  test("the whole flow ends in a read-only token that reads and cannot write or widen itself", async () => {
    const db = household();
    const app = await startTestApp(db, { memberId: "m-priya" });
    try {
      const clientId = await register(app);
      const { verifier, challenge } = pkce();

      const page = await app.get(`/oauth/authorize?${authorizeQuery(clientId, challenge)}`);
      assert.equal(page.status, 200);
      const text = await page.text();
      assert.match(text, /claude\.ai/, "the redirect host is on the page");
      assert.match(text, /read-only/i);
      // UI-19 · Connections are listed under More → Connect an AI, not Settings.
      assert.match(text, /More → Connect an AI/);
      assert.doesNotMatch(text, /Settings → API tokens/);
      // AI-6 · The member is told what the key can read besides the AI connection.
      assert.match(text, /data-ai-key-notice/);
      assert.match(text, /\/export\.json<\/code>, in full/);
      assert.match(text, /not in the AI access\s+log/);
      assert.match(text, /name="redact" value="1" checked/);
      assert.match(page.headers.get("content-security-policy") ?? "", /form-action 'self' https:\/\/claude\.ai/);

      const code = await approve(app, clientId, challenge);
      const res = await exchange(app, clientId, code, verifier);
      assert.equal(res.status, 200);
      const tokens = (await res.json()) as Tokens;
      assert.match(tokens.access_token, /^bgt_/);
      assert.equal(tokens.token_type, "Bearer");
      assert.equal(tokens.scope, "read");
      assert.equal(tokens.expires_in, 3600);
      assert.ok(tokens.refresh_token);

      const row = queryOne<{ scope: string; name: string; redact: number; oauth_client_id: string }>(
        db, `SELECT scope, name, redact, oauth_client_id FROM api_tokens WHERE oauth_client_id IS NOT NULL`,
      )!;
      assert.equal(row.scope, "read");
      assert.equal(row.name, "Claude (connector)");
      assert.equal(row.redact, 1, "the consent page's mask choice rides on the token");

      const exported = await server(app, "/export.json", bearer(tokens.access_token));
      assert.equal(exported.status, 200);

      const write = await server(app, "/settings/theme", {
        method: "POST",
        headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "theme=dark",
      });
      assert.equal(write.status, 403, "read scope cannot write");

      for (const path of ["/tokens", `/oauth/authorize?${authorizeQuery(clientId, challenge)}`]) {
        const res = await server(app, path, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" } });
        assert.equal(res.status, 403, `a token cannot reach ${path}`);
      }
      const consent = await server(app, "/oauth/authorize", {
        method: "POST",
        headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: `${authorizeQuery(clientId, challenge)}&decision=approve`,
      });
      assert.equal(consent.status, 403, "a token cannot approve a connection");

      const mcp = await server(app, "/mcp", { method: "POST", ...bearer(tokens.access_token) });
      assert.notEqual(mcp.status, 401, "the token gets past the /mcp gate");

      // Settings lists it as a connected app, apart from minted tokens.
      const settings = await (await app.get("/tokens")).text();
      assert.match(settings, /Connected AI apps/);
      assert.match(settings, /Claude/);

      const events = historyFor(db, "ai-connection", queryOne<{ id: string }>(db, `SELECT id FROM oauth_grants`)!.id);
      assert.match(events[0]!.summary ?? "", /Connected the AI app "Claude" \(claude\.ai\)/);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("a wrong verifier, a mismatched redirect URI and an expired code are each refused", async () => {
    const db = household();
    const app = await startTestApp(db, { memberId: "m-priya" });
    try {
      const clientId = await register(app);

      const one = pkce();
      const code1 = await approve(app, clientId, one.challenge);
      const wrong = await exchange(app, clientId, code1, pkce().verifier);
      assert.equal(wrong.status, 400);
      assert.equal(((await wrong.json()) as { error: string }).error, "invalid_grant");

      const two = pkce();
      const code2 = await approve(app, clientId, two.challenge);
      const mismatch = await exchange(app, clientId, code2, two.verifier, { redirect_uri: "https://claude.ai/elsewhere" });
      assert.equal(mismatch.status, 400);

      const three = pkce();
      const code3 = await approve(app, clientId, three.challenge);
      execute(db, `UPDATE oauth_codes SET expires_at = '2000-01-01T00:00:00.000+05:30' WHERE used_at IS NULL`);
      const expired = await exchange(app, clientId, code3, three.verifier);
      assert.equal(expired.status, 400);
      assert.equal(((await expired.json()) as { error: string }).error, "invalid_grant");

      // At the consent page, a redirect URI the app never registered is not
      // followed anywhere: it is shown to the member instead.
      const elsewhere = await app.get(
        `/oauth/authorize?${authorizeQuery(clientId, three.challenge, { redirect_uri: "https://evil.example/cb" })}`,
      );
      assert.equal(elsewhere.status, 400);
      assert.equal(elsewhere.headers.get("location"), null);

      // A missing PKCE challenge is told to the app at its own redirect URI.
      const noPkce = await app.get(`/oauth/authorize?${authorizeQuery(clientId, three.challenge, { code_challenge_method: "plain" })}`);
      assert.equal(noPkce.status, 303);
      assert.equal(new URL(noPkce.headers.get("location")!).searchParams.get("error"), "invalid_request");
    } finally {
      await app.close();
    }
  });

  test("a replayed code revokes what the first use issued", async () => {
    const app = await startTestApp(household(), { memberId: "m-priya" });
    try {
      const clientId = await register(app);
      const { verifier, challenge } = pkce();
      const code = await approve(app, clientId, challenge);
      const first = (await (await exchange(app, clientId, code, verifier)).json()) as Tokens;
      assert.equal((await server(app, "/export.json", bearer(first.access_token))).status, 200);

      const replay = await exchange(app, clientId, code, verifier);
      assert.equal(replay.status, 400);
      assert.notEqual((await server(app, "/export.json", bearer(first.access_token))).status, 200,
        "the first token is dead");
      const refresh = await form(app, "/oauth/token", {
        grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId,
      });
      assert.equal(refresh.status, 400);
    } finally {
      await app.close();
    }
  });

  test("refresh tokens rotate, and an old one used again ends the connection", async () => {
    const app = await startTestApp(household(), { memberId: "m-priya" });
    try {
      const { clientId, tokens } = await connect(app);
      const refresh = (fields: Record<string, string>) => form(app, "/oauth/token", {
        grant_type: "refresh_token", client_id: clientId, ...fields,
      });

      const r1 = await refresh({ refresh_token: tokens.refresh_token });
      assert.equal(r1.status, 200);
      const second = (await r1.json()) as Tokens;
      assert.notEqual(second.refresh_token, tokens.refresh_token);
      assert.notEqual(second.access_token, tokens.access_token);
      assert.equal(second.scope, "read");
      assert.equal((await server(app, "/export.json", bearer(second.access_token))).status, 200);

      // The first refresh token again: theft, as far as anybody can tell.
      const reuse = await refresh({ refresh_token: tokens.refresh_token });
      assert.equal(reuse.status, 400);
      assert.equal(((await reuse.json()) as { error: string }).error, "invalid_grant");

      assert.equal((await refresh({ refresh_token: second.refresh_token })).status, 400, "the current one died too");
      assert.notEqual((await server(app, "/export.json", bearer(second.access_token))).status, 200);
    } finally {
      await app.close();
    }
  });

  test("revoking in Settings ends the access token and the refresh token", async () => {
    const db = household();
    const app = await startTestApp(db, { memberId: "m-priya" });
    try {
      const { clientId, tokens } = await connect(app);
      const grantId = queryOne<{ id: string }>(db, `SELECT id FROM oauth_grants`)!.id;
      const res = await app.post(`/tokens/connections/${grantId}/revoke`);
      assert.equal(res.status, 303);
      assert.notEqual((await server(app, "/export.json", bearer(tokens.access_token))).status, 200);
      const refresh = await form(app, "/oauth/token", {
        grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId,
      });
      assert.equal(refresh.status, 400);
      assert.doesNotMatch(await (await app.get("/tokens")).text(), /Connected AI apps/);

      // And revoking the access token itself, by its id, ends its connection.
      const again = await connect(app);
      const tokenId = queryOne<{ id: string }>(
        db, `SELECT id FROM api_tokens WHERE revoked_at IS NULL AND oauth_grant_id IS NOT NULL`,
      )!.id;
      assert.equal((await app.post(`/tokens/${tokenId}/revoke`)).status, 303);
      const after = await form(app, "/oauth/token", {
        grant_type: "refresh_token", refresh_token: again.tokens.refresh_token, client_id: again.clientId,
      });
      assert.equal(after.status, 400);
    } finally {
      await app.close();
    }
  });

  test("a removed member's connection stops working and cannot refresh", async () => {
    const db = household();
    const app = await startTestApp(db, { memberId: "m-priya" });
    try {
      const { clientId, tokens } = await connect(app);
      removeMember(db, { memberId: "m-ravi", source: "ui" }, "m-priya");
      assert.notEqual((await server(app, "/export.json", bearer(tokens.access_token))).status, 200);
      const mcp = await server(app, "/mcp", { method: "POST", ...bearer(tokens.access_token) });
      assert.equal(mcp.status, 401);
      const refresh = await form(app, "/oauth/token", {
        grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId,
      });
      assert.equal(refresh.status, 400);
    } finally {
      await app.close();
    }
  });

  test("signed out, the consent page sends the member to sign in and back, query intact", async () => {
    const app = await startTestApp(household(), { memberId: null });
    try {
      const clientId = await register(app);
      const query = authorizeQuery(clientId, pkce().challenge);
      const res = await app.get(`/oauth/authorize?${query}`);
      assert.equal(res.status, 303);
      const location = new URL(res.headers.get("location")!, app.baseUrl);
      assert.equal(location.pathname, "/signin");
      assert.equal(location.searchParams.get("next"), `/oauth/authorize?${query}`);
    } finally {
      await app.close();
    }
  });

  test("the consent POST is held to the same-origin rule", async () => {
    const db = household();
    const app = await startTestApp(db, { memberId: "m-priya" });
    try {
      const clientId = await register(app);
      const fields = { ...Object.fromEntries(new URLSearchParams(authorizeQuery(clientId, pkce().challenge))), decision: "approve" };
      const evil = await app.post("/oauth/authorize", fields, { headers: { Origin: "https://evil.example" } });
      assert.equal(evil.status, 403);
      const rebound = await rawPost(app, "/oauth/authorize", {
        Host: "evil.example", Origin: "http://evil.example", Cookie: sessionCookie(db, "m-priya"),
      }, fields);
      assert.equal(rebound, 403, "a DNS-rebound Host is refused");
      assert.equal(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM oauth_codes`)!.n, 0);

      const deny = await app.post("/oauth/authorize", { ...fields, decision: "deny" });
      assert.equal(deny.status, 303);
      const location = new URL(deny.headers.get("location")!);
      assert.equal(location.searchParams.get("error"), "access_denied");
      assert.equal(location.searchParams.get("state"), "st-123");
      assert.equal(location.searchParams.get("code"), null);
    } finally {
      await app.close();
    }
  });

  test("not while viewing as somebody else, and not on the demo", async () => {
    const db = household();
    const app = await startTestApp(db, { memberId: "m-priya" });
    try {
      const clientId = await register(app);
      const sessionId = queryOne<{ id: string }>(db, `SELECT id FROM sessions WHERE member_id = 'm-priya'`)!.id;
      startImpersonation(db, { memberId: "m-priya", source: "ui" }, sessionId, "m-ravi");
      const res = await app.get(`/oauth/authorize?${authorizeQuery(clientId, pkce().challenge)}`);
      assert.equal(res.status, 403);
    } finally {
      await app.close();
    }

    const demo = await startTestApp(household(), { memberId: "m-priya", config: { demoMode: true } });
    try {
      const reg = await server(demo, "/oauth/register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [CALLBACK] }),
      });
      assert.equal(reg.status, 403);
      const page = await demo.get(`/oauth/authorize?client_id=x`);
      assert.equal(page.status, 403);
    } finally {
      await demo.close();
    }
  });

  test("registration refuses what is not https or loopback, and is rate-limited", async () => {
    const app = await startTestApp(household(), { memberId: null });
    try {
      const reg = (uris: unknown) => server(app, "/oauth/register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "x", redirect_uris: uris }),
      });
      for (const bad of [["javascript:alert(1)"], ["http://evil.example/cb"], ["https://a.example/cb#frag"], []]) {
        const res = await reg(bad);
        assert.equal(res.status, 400, JSON.stringify(bad));
        assert.equal(((await res.json()) as { error: string }).error, "invalid_redirect_uri");
      }
      const ok = await reg(["http://localhost/callback", "http://127.0.0.1/callback"]);
      assert.equal(ok.status, 201);
      let last = 201;
      for (let i = 0; i < 25; i++) last = (await reg([CALLBACK])).status;
      assert.equal(last, 429);
    } finally {
      await app.close();
    }
  });
});
