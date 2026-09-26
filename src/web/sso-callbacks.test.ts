/**
 * The Google and OpenID Connect callbacks, driven end to end against a stubbed
 * provider.
 *
 * `auth/oidc.test.ts` and the Google tests in `auth/sessions.test.ts` prove the
 * ID-token parsing. These prove what the app then does with a parsed profile —
 * which is where the verified-email claim was read and then ignored.
 */

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { queryOne } from "../db/db.ts";

const ISSUER = "https://idp.example";
const OIDC = { issuer: ISSUER, clientId: "pathayam", clientSecret: "s", label: "SSO" };
const GOOGLE = { clientId: "cid", clientSecret: "sec" };

function b64(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

function idToken(claims: Record<string, unknown>): string {
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

/**
 * A provider that serves the discovery document and answers every token
 * exchange with whatever `answer` currently returns.
 */
function provider() {
  const state = { answer: (): Response => new Response("{}", { status: 400 }) };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/auth`,
        token_endpoint: `${ISSUER}/token`,
      });
    }
    return state.answer();
  }) as typeof fetch;
  return { state, fetchImpl };
}

function tokenFor(claims: Record<string, unknown>): () => Response {
  return () => Response.json({
    id_token: idToken({ exp: Math.floor(Date.now() / 1000) + 600, ...claims }),
  });
}

/** Start the flow and read back the state the app handed the provider. */
async function beginAt(baseUrl: string, path: string): Promise<string> {
  const res = await fetch(baseUrl + path, { redirect: "manual" });
  return new URL(res.headers.get("location")!).searchParams.get("state")!;
}

function household() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  seedMember(db, "m-priya", "Priya");
  const email = queryOne<{ email: string }>(db, `SELECT email FROM members WHERE id = 'm-priya'`)!.email;
  return { db, email };
}

describe("SSO callbacks", () => {
  test("SECURITY-OPS-17 · OIDC refuses an address the provider has not verified", async () => {
    const { db, email } = household();
    const idp = provider();
    const app = await startTestApp(db, { memberId: null, config: { oidc: OIDC }, fetchImpl: idp.fetchImpl });
    try {
      for (const verified of [false, undefined]) {
        idp.state.answer = tokenFor({
          iss: ISSUER, aud: "pathayam", sub: "attacker", email, email_verified: verified,
        });
        const state = await beginAt(app.baseUrl, "/auth/oidc");
        const res = await fetch(`${app.baseUrl}/auth/oidc/callback?state=${state}&code=x`, { redirect: "manual" });
        assert.equal(res.status, 403, `email_verified: ${verified}`);
        assert.equal(res.headers.get("set-cookie"), null);
      }
      assert.equal(
        queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM auth_attempts WHERE outcome = 'unverified-email'`)!.n,
        2,
      );

      // A verified address still signs in.
      idp.state.answer = tokenFor({ iss: ISSUER, aud: "pathayam", sub: "priya", email, email_verified: true });
      const state = await beginAt(app.baseUrl, "/auth/oidc");
      const ok = await fetch(`${app.baseUrl}/auth/oidc/callback?state=${state}&code=x`, { redirect: "manual" });
      assert.equal(ok.status, 303);
      assert.match(ok.headers.get("set-cookie") ?? "", /pathayam_session=/);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("SECURITY-OPS-17 · Google refuses an unverified address and leaves google_sub alone", async () => {
    const { db, email } = household();
    const idp = provider();
    const app = await startTestApp(db, { memberId: null, config: { google: GOOGLE }, fetchImpl: idp.fetchImpl });
    try {
      idp.state.answer = tokenFor({
        iss: "https://accounts.google.com", aud: "cid", sub: "attacker", email, email_verified: false,
      });
      const state = await beginAt(app.baseUrl, "/auth/google");
      const res = await fetch(`${app.baseUrl}/auth/google/callback?state=${state}&code=x`, { redirect: "manual" });
      assert.equal(res.status, 403);
      assert.equal(res.headers.get("set-cookie"), null);
      assert.equal(
        queryOne<{ google_sub: string | null }>(db, `SELECT google_sub FROM members WHERE id = 'm-priya'`)!.google_sub,
        null,
      );
    } finally {
      await app.close();
    }
  });

  test("SECURITY-OPS-17 · an unverified address cannot become an empty household's first member", async () => {
    const db = freshDb();
    const idp = provider();
    const app = await startTestApp(db, { memberId: null, config: { oidc: OIDC }, fetchImpl: idp.fetchImpl });
    try {
      idp.state.answer = tokenFor({
        iss: ISSUER, aud: "pathayam", sub: "x", email: "someone@example.com", email_verified: false,
      });
      const state = await beginAt(app.baseUrl, "/auth/oidc");
      const res = await fetch(`${app.baseUrl}/auth/oidc/callback?state=${state}&code=x`, { redirect: "manual" });
      assert.equal(res.status, 403);
      assert.equal(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM members`)!.n, 0);
    } finally {
      await app.close();
    }
  });

  test("SECURITY-OPS-18 · a code the provider rejects is a 400 and an auth attempt, not a fault", async () => {
    const { db } = household();
    const idp = provider(); // answers every token exchange with a 400
    const app = await startTestApp(db, {
      memberId: null, config: { oidc: OIDC, google: GOOGLE }, fetchImpl: idp.fetchImpl,
    });
    try {
      for (const flow of ["/auth/google", "/auth/oidc"]) {
        const state = await beginAt(app.baseUrl, flow);
        const res = await fetch(`${app.baseUrl}${flow}/callback?state=${state}&code=forged`, { redirect: "manual" });
        assert.equal(res.status, 400, flow);
        assert.equal(res.headers.get("set-cookie"), null);
      }
      assert.deepEqual(app.failures, [], "recorded as a server fault");
      assert.equal(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM request_failures`)!.n, 0);
      assert.equal(
        queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM auth_attempts WHERE outcome = 'rejected-code'`)!.n,
        2,
      );
    } finally {
      await app.close();
    }
  });

  test("SECURITY-OPS-19 · an OIDC state used an hour later is expired, with no Google to prune it", async () => {
    const { db, email } = household();
    const idp = provider();
    idp.state.answer = tokenFor({ iss: ISSUER, aud: "pathayam", sub: "priya", email, email_verified: true });
    const app = await startTestApp(db, { memberId: null, config: { oidc: OIDC }, fetchImpl: idp.fetchImpl });
    try {
      const state = await beginAt(app.baseUrl, "/auth/oidc");
      mock.timers.enable({ apis: ["Date"], now: Date.now() + 60 * 60_000 });
      try {
        const res = await fetch(`${app.baseUrl}/auth/oidc/callback?state=${state}&code=x`, { redirect: "manual" });
        assert.equal(res.status, 400);
        assert.equal(res.headers.get("set-cookie"), null);
      } finally {
        mock.timers.reset();
      }
    } finally {
      await app.close();
    }
  });
});
