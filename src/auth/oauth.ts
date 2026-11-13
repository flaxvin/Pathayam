/**
 * OAUTH · An authorization server, so an AI app can connect by URL.
 *
 * claude.ai custom connectors, ChatGPT connectors and other MCP clients are
 * given one address — `${BASE_URL}/mcp` — and find everything else
 * themselves. The MCP authorization spec (revision 2026-07-28) and each
 * vendor's connector docs say how; docs/security.md and the notes in
 * /mnt/project-files/pathayam-ai/oauth.md name the pages. In order:
 *
 *   1. The app calls /mcp with no token and is answered 401 with a
 *      `WWW-Authenticate` naming the protected resource metadata (RFC 9728).
 *   2. That names this server as the authorization server; its metadata
 *      (RFC 8414) names the endpoints below.
 *   3. It registers itself (RFC 7591) — no account, so the registration is a
 *      claim and nothing more.
 *   4. It sends the member's browser to /oauth/authorize, where the member,
 *      signed in, reads who is asking and approves or declines.
 *   5. It trades the code for tokens at /oauth/token, proving with PKCE that
 *      it is the one that asked.
 *
 * What it is given is deliberately ordinary. The access token is an API token
 * (src/auth/tokens.ts) — `bgt_`, hashed, read-only, an hour long — so every
 * rule a token already lives under applies without being restated here: the
 * deny-list, the rate limit, revocation, member removal, last-used. The scope
 * is `read`, unless the deployment allows AI changes (AI_WRITE) and the member
 * ticked "allow changes" on the consent page: then it is also `budget:write`,
 * and the token can call the write tools over /mcp — and still nothing else
 * (AIW, docs/ai.md). Refresh tokens rotate, and an old one used again ends the
 * connection.
 *
 * Zero dependencies, like the rest: Node's crypto and the app's own database.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { Missing } from "../core/refusal.ts";
import type { Response } from "../http/router.ts";
import { getMember } from "./sessions.ts";
import {
  mintOAuthAccessToken, revokeGrantCredentials, OAUTH_ACCESS_TOKEN_SECONDS,
} from "./tokens.ts";

/** What every connection gets. */
export const OAUTH_SCOPE = "read";
/**
 * AIW · What a member may add on the consent page, when AI_WRITE allows it.
 * Advertised only then: a client never sees a scope it could not be given.
 */
export const OAUTH_WRITE_SCOPE = "budget:write";

/** The scopes a deployment offers. */
export function scopesSupported(opts: { write?: boolean } = {}): string[] {
  return opts.write ? [OAUTH_SCOPE, OAUTH_WRITE_SCOPE] : [OAUTH_SCOPE];
}

/** Whether a grant's stored scope includes changes. */
export function scopeWrites(scope: string | null | undefined): boolean {
  return (scope ?? "").split(/\s+/).includes(OAUTH_WRITE_SCOPE);
}

const CODE_SECONDS = 10 * 60;
const REFRESH_DAYS = 90;
/** Registering needs no account, so the table has a ceiling. */
export const MAX_CLIENTS = 200;
/** A registration nobody approved within a day is pruned. */
const UNAPPROVED_CLIENT_HOURS = 24;
const MAX_CLIENT_NAME = 100;
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Where things are
// ---------------------------------------------------------------------------

/** BASE_URL without a trailing slash: the issuer, compared as a string by clients. */
export function issuerOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** The MCP endpoint, which is the one resource tokens from here are for. */
export function mcpResource(baseUrl: string): string {
  return `${issuerOf(baseUrl)}/mcp`;
}

export function resourceMetadataUrl(baseUrl: string): string {
  return `${issuerOf(baseUrl)}/.well-known/oauth-protected-resource`;
}

/** RFC 9728 · Served at the root well-known path and at its /mcp suffix. */
export function protectedResourceMetadata(baseUrl: string, opts: { write?: boolean } = {}): Record<string, unknown> {
  return {
    resource: mcpResource(baseUrl),
    // Claude uses the first entry and no other, so there is exactly one.
    authorization_servers: [issuerOf(baseUrl)],
    scopes_supported: scopesSupported(opts),
    bearer_methods_supported: ["header"],
    resource_name: "Pathayam",
  };
}

/** RFC 8414 · What a client checks before it starts. */
export function authorizationServerMetadata(baseUrl: string, opts: { write?: boolean } = {}): Record<string, unknown> {
  const issuer = issuerOf(baseUrl);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // Without this field a spec-following client refuses to proceed at all.
    code_challenge_methods_supported: ["S256"],
    // Public clients only: an AI app is a client nobody here vetted, and a
    // secret it was handed by an open registration endpoint proves nothing.
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: scopesSupported(opts),
    // RFC 9207 · Every authorization response, error or not, names us.
    // ChatGPT uses its stable redirect URI only for a server that does.
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${issuer}/api`,
  };
}

/**
 * The answer to an MCP request with no usable token: 401, and where to start.
 *
 * Claude starts sign-in only on a 401 (it ignores the header on a 200), and
 * reads the metadata location from `resource_metadata`. `scope` says what to
 * ask for. A token that was sent and is no good says so, per RFC 6750 §3.1, so
 * a client knows to refresh rather than start over.
 */
export function mcpUnauthorized(baseUrl: string, opts: { invalidToken?: boolean } = {}): Response {
  const parts = [
    `resource_metadata="${resourceMetadataUrl(baseUrl)}"`,
    `scope="${OAUTH_SCOPE}"`,
  ];
  if (opts.invalidToken) {
    parts.push(`error="invalid_token"`, `error_description="The access token is missing, expired or revoked."`);
  }
  return {
    status: 401,
    headers: { "WWW-Authenticate": `Bearer ${parts.join(", ")}` },
    json: {
      error: opts.invalidToken ? "invalid_token" : "unauthorized",
      error_description: "Connect this app to Pathayam first: it needs an access token.",
    },
  };
}

// ---------------------------------------------------------------------------
// Errors in OAuth's own vocabulary
// ---------------------------------------------------------------------------

/** RFC 6749 §5.2 and RFC 7591 §3.2.2 · An error a client is meant to read. */
export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, description: string, status = 400) {
    super(description);
    this.code = code;
    this.status = status;
    this.name = "OAuthError";
  }
  toResponse(): Response {
    return {
      status: this.status,
      headers: { Pragma: "no-cache" },
      json: { error: this.code, error_description: this.message },
    };
  }
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function at(now: Date, plusSeconds = 0): string {
  return nowIST(new Date(now.getTime() + plusSeconds * 1000));
}

/** Equal strings, compared in constant time; unequal lengths are simply unequal. */
function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// Rate limits, per address
// ---------------------------------------------------------------------------

/*
 * In memory, a fixed window per address, like the token limiter: one process
 * on one box (Q8). The registration limit is low because a registration is a
 * row anybody can make; the token limit is high enough never to trouble a
 * real client, which refreshes once an hour.
 */
const limits = new Map<string, { count: number; resetAt: number }>();
export const OAUTH_LIMIT_CAP = 10_000;

/** How many addresses the limiter is holding, for a test. */
export function oauthRateLimitSize(): number {
  return limits.size;
}

export function checkOAuthRateLimit(
  kind: "register" | "token", ip: string, now = Date.now(),
): { allowed: boolean; retryAfterSeconds: number } {
  const [windowMs, max] = kind === "register" ? [60 * 60_000, 20] : [60_000, 60];
  const key = `${kind}:${ip}`;
  const bucket = limits.get(key);
  if (!bucket || now >= bucket.resetAt) {
    /*
     * WEB-7 · Bounded, as PendingStates is (SECURITY-OPS-19). Every new
     * address added a bucket nothing removed, so anonymous posts to
     * /oauth/register or /oauth/token from fresh addresses (an IPv6 /64 is
     * plenty) grew the process without limit. Past the cap, finished windows
     * go first, then the oldest buckets.
     */
    limits.delete(key);
    if (limits.size >= OAUTH_LIMIT_CAP) {
      for (const [k, b] of limits) if (now >= b.resetAt) limits.delete(k);
      for (const k of limits.keys()) {
        if (limits.size < OAUTH_LIMIT_CAP) break;
        limits.delete(k);
      }
    }
    limits.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  bucket.count++;
  return { allowed: bucket.count <= max, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
}

export function resetOAuthRateLimits(): void {
  limits.clear();
}

// ---------------------------------------------------------------------------
// Clients (RFC 7591)
// ---------------------------------------------------------------------------

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string;
  source: string;
  created_at: string;
  last_used_at: string | null;
}

export function getClient(db: DB, clientId: string | undefined): OAuthClient | null {
  if (!clientId) return null;
  return queryOne<OAuthClient>(db, `SELECT * FROM oauth_clients WHERE client_id = ?`, clientId);
}

export function redirectUrisOf(client: OAuthClient): string[] {
  try {
    const list = JSON.parse(client.redirect_uris) as unknown;
    return Array.isArray(list) ? list.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** http on this machine's own name, which only a local process can answer. */
export function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Why a redirect URI is refused, or null when it is acceptable.
 *
 * HTTPS anywhere, or plain http on loopback — the MCP spec's rule ("either
 * localhost or HTTPS"), which also keeps javascript:, data: and app schemes
 * out. No fragment (RFC 6749 §3.1.2) and no user:password@ to make a host
 * read differently on the consent page than it does to a browser.
 */
export function redirectUriProblem(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return "A redirect URI must be a non-empty string.";
  if (value.length > MAX_REDIRECT_URI_LENGTH) return "That redirect URI is too long.";
  if (/[\u0000- \u007f]/.test(value)) return "A redirect URI cannot contain spaces or control characters.";
  if (value.includes("#")) return "A redirect URI cannot have a fragment.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "A redirect URI must be an absolute URL.";
  }
  if (url.username || url.password) return "A redirect URI cannot carry a user name or password.";
  if (url.protocol === "https:") return url.hostname ? null : "A redirect URI needs a host.";
  if (isLoopback(url)) return null;
  return "A redirect URI must use https, or http on localhost or 127.0.0.1.";
}

/**
 * Whether the redirect URI an authorization request names is one the client
 * registered. Exact, string for string — except that a loopback URI matches
 * on any port, because a native client (Claude Code) listens on whichever
 * port is free and registers it without one (RFC 8252 §7.3; Claude's docs ask
 * for the same of `localhost`).
 */
export function redirectUriMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let g: URL;
  try {
    g = new URL(given);
  } catch {
    return false;
  }
  if (!isLoopback(g) || given.includes("#")) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return isLoopback(u) && u.hostname === g.hostname
        && u.pathname === g.pathname && u.search === g.search;
    } catch {
      return false;
    }
  });
}

/** A name for the consent page, without the means to forge its layout. */
function cleanClientName(value: string | undefined): string {
  const name = (value ?? "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "").trim();
  return name === "" ? "An unnamed app" : name;
}

/**
 * Forget registrations nobody approved, codes long expired, and AI access
 * tokens past their hour. Run before each registration and token request, so
 * the tables stay as small as the household's actual connections.
 */
export function pruneOAuth(db: DB, now: Date = new Date()): void {
  const dayAgo = at(now, -24 * 3600);
  const clientCutoff = at(now, -UNAPPROVED_CLIENT_HOURS * 3600);
  // A code lives ten minutes; one used is kept a day so a replay is still
  // recognised as one.
  execute(db, `DELETE FROM oauth_codes WHERE expires_at < ?`, dayAgo);
  execute(db, `DELETE FROM oauth_refresh_tokens WHERE expires_at < ?`, at(now));
  // An approval whose code was never redeemed connected nothing.
  execute(
    db,
    `DELETE FROM oauth_grants
      WHERE created_at < ?
        AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.grant_id = oauth_grants.id)
        AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens r WHERE r.grant_id = oauth_grants.id)
        AND NOT EXISTS (SELECT 1 FROM api_tokens t WHERE t.oauth_grant_id = oauth_grants.id)`,
    dayAgo,
  );
  // An hour-long token a day past its hour is nobody's; its connection
  // lists when it was last used.
  execute(db, `DELETE FROM api_tokens WHERE oauth_grant_id IS NOT NULL AND expires_at < ?`, dayAgo);
  execute(
    db,
    `DELETE FROM oauth_clients
      WHERE created_at < ?
        AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id)
        AND NOT EXISTS (SELECT 1 FROM api_tokens t WHERE t.oauth_client_id = oauth_clients.client_id)`,
    clientCutoff,
  );
}

/**
 * RFC 7591 · Register a client. Throws OAuthError with RFC 7591's codes.
 *
 * What a client says about itself is checked, not believed: the name is only
 * ever shown beside the redirect host, which it cannot lie about. Whatever
 * authentication method it asks for, it is registered as a public client and
 * told so in the response, which RFC 7591 §3.2.1 lets a server do.
 */
export function registerClient(
  db: DB, body: Record<string, string | string[]>, now: Date = new Date(),
): Record<string, unknown> {
  return transact(db, () => {
    pruneOAuth(db, now);

    const uris = body.redirect_uris === undefined ? []
      : Array.isArray(body.redirect_uris) ? body.redirect_uris : [body.redirect_uris];
    if (uris.length === 0) {
      throw new OAuthError("invalid_redirect_uri", "At least one redirect URI is required.");
    }
    if (uris.length > MAX_REDIRECT_URIS) {
      throw new OAuthError("invalid_redirect_uri", `At most ${MAX_REDIRECT_URIS} redirect URIs.`);
    }
    for (const uri of uris) {
      const problem = redirectUriProblem(uri);
      if (problem) throw new OAuthError("invalid_redirect_uri", problem);
    }

    const rawName = typeof body.client_name === "string" ? body.client_name : undefined;
    if (rawName !== undefined && rawName.length > MAX_CLIENT_NAME) {
      throw new OAuthError("invalid_client_metadata", `A client name is at most ${MAX_CLIENT_NAME} characters.`);
    }

    const list = (name: string): string[] | null => {
      const v = body[name];
      return v === undefined ? null : Array.isArray(v) ? v : [v];
    };
    const grants = list("grant_types");
    if (grants && grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
      throw new OAuthError("invalid_client_metadata", "Only authorization_code and refresh_token grants are offered.");
    }
    const responses = list("response_types");
    if (responses && responses.some((r) => r !== "code")) {
      throw new OAuthError("invalid_client_metadata", "Only the code response type is offered.");
    }

    const count = queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM oauth_clients`)!.n;
    if (count >= MAX_CLIENTS) {
      throw new OAuthError(
        "temporarily_unavailable",
        "Too many apps are registered here. Unused registrations are cleared after a day.",
        503,
      );
    }

    const clientId = secret("pcl_");
    const name = cleanClientName(rawName);
    const createdAt = at(now);
    execute(
      db,
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, source, created_at)
       VALUES (?,?,?,'dcr',?)`,
      clientId, name, JSON.stringify(uris), createdAt,
    );

    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: OAUTH_SCOPE,
    };
  });
}

// ---------------------------------------------------------------------------
// The authorization request
// ---------------------------------------------------------------------------

export interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  resource: string;
  /** AIW · The app asked for budget:write. The member still decides on the consent page. */
  asksToWrite: boolean;
}

/**
 * The outcome of reading an authorization request.
 *
 * `fatal` is a request that cannot be answered at its redirect URI, because
 * the client or the URI is not one registered here — so it is shown to the
 * member instead of sent anywhere (RFC 6749 §4.1.2.1). `redirect` is an error
 * the client is told about at its own, verified, redirect URI.
 */
export type AuthorizeParse =
  | { ok: AuthorizeRequest }
  | { fatal: string }
  | { redirect: string };

/** Whether `given` names this server's MCP endpoint, scheme and host case aside. */
export function isOurResource(baseUrl: string, given: string): boolean {
  const canonical = (value: string): string | null => {
    try {
      const u = new URL(value);
      if (u.hash || value.includes("#")) return null;
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
    } catch {
      return null;
    }
  };
  const ours = canonical(mcpResource(baseUrl));
  return ours !== null && canonical(given) === ours;
}

/** The redirect back to the client, carrying `iss` on every one (RFC 9207). */
export function clientRedirect(
  baseUrl: string, redirectUri: string, params: Record<string, string | null>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  url.searchParams.set("iss", issuerOf(baseUrl));
  return url.toString();
}

export function parseAuthorizeRequest(
  db: DB, baseUrl: string, get: (name: string) => string | undefined,
): AuthorizeParse {
  const client = getClient(db, get("client_id"));
  if (!client) return { fatal: "That app is not registered here. Start connecting again from the app." };

  const registered = redirectUrisOf(client);
  const requested = get("redirect_uri");
  // Optional only when exactly one was registered, so there is nothing to choose.
  const redirectUri = requested ?? (registered.length === 1 ? registered[0]! : undefined);
  if (!redirectUri || !redirectUriMatches(registered, redirectUri) || redirectUriProblem(redirectUri)) {
    return { fatal: "That app asked to be sent somewhere it did not register, so it was not sent anywhere." };
  }

  const state = get("state") ?? null;
  const fail = (error: string, description: string): AuthorizeParse => ({
    redirect: clientRedirect(baseUrl, redirectUri, { error, error_description: description, state }),
  });

  if (get("response_type") !== "code") {
    return fail("unsupported_response_type", "Only response_type=code is supported.");
  }
  const challenge = get("code_challenge");
  if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return fail("invalid_request", "A PKCE code_challenge is required.");
  }
  if (get("code_challenge_method") !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256.");
  }
  const resource = get("resource");
  if (resource !== undefined && !isOurResource(baseUrl, resource)) {
    return fail("invalid_target", `The only resource here is ${mcpResource(baseUrl)}.`);
  }
  // Whatever scope is asked for, read is what is granted unless the member
  // ticks "allow changes" (AIW), and the token response says which. Asking for
  // more is not an error worth failing over: the member is the one who decides.

  return {
    ok: {
      client, redirectUri, state, codeChallenge: challenge, resource: mcpResource(baseUrl),
      asksToWrite: scopeWrites(get("scope")),
    },
  };
}

/** The host a consent page leads with: what the member can check. */
export function redirectHost(redirectUri: string): string {
  try {
    return new URL(redirectUri).host;
  } catch {
    return redirectUri;
  }
}

/**
 * The member said yes: make the connection, record it, and return the code.
 *
 * The event is the approval, once, in words, in the activity log — the
 * equivalent of "Created the API token" for a token minted by hand.
 */
export function approveAuthorization(
  db: DB, actor: Actor, request: AuthorizeRequest, opts: { redact: boolean; write?: boolean },
  now: Date = new Date(),
): string {
  return transact(db, () => {
    const memberId = actor.memberId;
    if (!memberId) throw new Error("A connection belongs to a member.");
    const grantId = newId();
    const scope = opts.write ? `${OAUTH_SCOPE} ${OAUTH_WRITE_SCOPE}` : OAUTH_SCOPE;
    execute(
      db,
      `INSERT INTO oauth_grants (id, client_id, member_id, scope, resource, redact, created_at, can_write)
       VALUES (?,?,?,?,?,?,?,?)`,
      grantId, request.client.client_id, memberId, OAUTH_SCOPE, request.resource,
      opts.redact ? 1 : 0, at(now), opts.write ? 1 : 0,
    );
    const code = secret("pac_");
    execute(
      db,
      `INSERT INTO oauth_codes
         (code_hash, grant_id, client_id, member_id, redirect_uri, code_challenge, scope, resource, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      sha256hex(code), grantId, request.client.client_id, memberId, request.redirectUri,
      request.codeChallenge, OAUTH_SCOPE, request.resource, at(now), at(now, CODE_SECONDS),
    );
    execute(db, `UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?`, at(now), request.client.client_id);
    const host = redirectHost(request.redirectUri);
    appendEvent(db, actor, {
      entity: "ai-connection", entityId: grantId, action: "create",
      after: { client: request.client.client_name, redirectHost: host, scope, redact: opts.redact },
      summary:
        `Connected the AI app "${request.client.client_name}" (${host}) ` +
        (opts.write ? "able to make changes" : "with read-only access") +
        (opts.redact ? ", account numbers masked" : ""),
    });
    return code;
  });
}

// ---------------------------------------------------------------------------
// The token endpoint
// ---------------------------------------------------------------------------

interface GrantRow {
  id: string;
  client_id: string;
  member_id: string;
  scope: string;
  resource: string;
  redact: number;
  /** AIW · The member ticked "allow changes" (budget:write) on the consent page. */
  can_write: number;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface CodeRow {
  code_hash: string;
  grant_id: string;
  client_id: string;
  member_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  expires_at: string;
  used_at: string | null;
}

interface RefreshRow {
  token_hash: string;
  grant_id: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** RFC 7636 · base64url(SHA-256(verifier)) against the stored challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return constantTimeEqual(computed, challenge);
}

function getGrant(db: DB, id: string): GrantRow | null {
  return queryOne<GrantRow>(db, `SELECT * FROM oauth_grants WHERE id = ?`, id);
}

/** A connection ended by evidence of theft, recorded so the member can see why. */
function revokeForReuse(db: DB, grant: GrantRow, what: string): void {
  if (grant.revoked_at) return;
  revokeGrantCredentials(db, grant.id);
  const client = getClient(db, grant.client_id);
  appendEvent(db, { memberId: grant.member_id, source: "system", sourceDetail: "oauth" }, {
    entity: "ai-connection", entityId: grant.id, action: "revoke",
    summary:
      `Disconnected the AI app "${client?.client_name ?? "unknown"}" because ${what} was used twice. ` +
      "Connect it again from the app if that was you.",
  });
}

/** The member a connection acts for, if they still may. */
function memberStillIn(db: DB, memberId: string): boolean {
  const member = getMember(db, memberId);
  return Boolean(member && !member.removed_at && member.allowed);
}

function issueTokens(db: DB, grant: GrantRow, now: Date, opts: { write?: boolean }): TokenResponse {
  const client = getClient(db, grant.client_id)!;
  // AIW · Both the member's tick and the deployment's switch, read now: an
  // operator who turns AI_WRITE off has every connection read-only from its
  // next refresh, an hour at most.
  const writes = Boolean(opts.write) && grant.can_write === 1;
  const access = mintOAuthAccessToken(db, {
    memberId: grant.member_id,
    name: `${client.client_name} (connector)`,
    clientId: grant.client_id,
    grantId: grant.id,
    redact: grant.redact === 1,
    scope: writes ? "read-write" : "read",
  }, now);
  const refresh = secret("prt_");
  execute(
    db,
    `INSERT INTO oauth_refresh_tokens (token_hash, grant_id, created_at, expires_at) VALUES (?,?,?,?)`,
    sha256hex(refresh), grant.id, at(now), at(now, REFRESH_DAYS * 86400),
  );
  execute(db, `UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?`, at(now), grant.client_id);
  return {
    access_token: access.secret,
    token_type: "Bearer",
    expires_in: OAUTH_ACCESS_TOKEN_SECONDS,
    refresh_token: refresh,
    scope: writes ? `${OAUTH_SCOPE} ${OAUTH_WRITE_SCOPE}` : OAUTH_SCOPE,
  };
}

/** The client a public client says it is: the body, or HTTP Basic with no secret. */
export function clientIdFrom(body: Record<string, string | string[]>, authorization: string | undefined): string | undefined {
  const fromBody = typeof body.client_id === "string" ? body.client_id : undefined;
  if (fromBody) return fromBody;
  const basic = /^Basic\s+(\S+)$/i.exec(authorization ?? "");
  if (!basic) return undefined;
  const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
  const id = decoded.split(":")[0];
  try {
    return id ? decodeURIComponent(id) : undefined;
  } catch {
    return undefined;
  }
}

/** POST /oauth/token. Throws OAuthError; returns the RFC 6749 §5.1 body. */
export function tokenRequest(
  db: DB, baseUrl: string, body: Record<string, string | string[]>,
  clientId: string | undefined, now: Date = new Date(),
  /** AIW · Whether this deployment lets AI connections make changes at all. */
  opts: { write?: boolean } = {},
): TokenResponse {
  const one = (name: string): string | undefined => {
    const v = body[name];
    return Array.isArray(v) ? undefined : v; // a repeated parameter is not a value (RFC 6749 §3.1)
  };

  // Answered, not thrown, so the revocations survive the refusal.
  const outcome = transact(db, (): TokenResponse | OAuthError => {
    pruneOAuth(db, now);
    const client = getClient(db, clientId);
    if (!client) return new OAuthError("invalid_client", "That client is not registered here.", 401);

    const resource = one("resource");
    if (resource !== undefined && !isOurResource(baseUrl, resource)) {
      return new OAuthError("invalid_target", `The only resource here is ${mcpResource(baseUrl)}.`);
    }

    const grantType = one("grant_type");
    if (grantType === "authorization_code") {
      const code = one("code");
      if (!code) return new OAuthError("invalid_request", "code is required.");
      const row = queryOne<CodeRow>(db, `SELECT * FROM oauth_codes WHERE code_hash = ?`, sha256hex(code));
      if (!row || row.client_id !== client.client_id) {
        return new OAuthError("invalid_grant", "That code is not valid.");
      }
      const grant = getGrant(db, row.grant_id);
      if (!grant) return new OAuthError("invalid_grant", "That code is not valid.");
      if (row.used_at) {
        // RFC 6749 §4.1.2 · A second use means somebody else has the code;
        // what the first use issued is revoked with it.
        revokeForReuse(db, grant, "its authorization code");
        return new OAuthError("invalid_grant", "That code was already used.");
      }
      execute(db, `UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?`, at(now), row.code_hash);
      if (row.expires_at <= at(now)) return new OAuthError("invalid_grant", "That code has expired.");
      if (one("redirect_uri") !== row.redirect_uri) {
        return new OAuthError("invalid_grant", "redirect_uri does not match the one the code was issued to.");
      }
      const verifier = one("code_verifier");
      if (!verifier || !pkceMatches(verifier, row.code_challenge)) {
        return new OAuthError("invalid_grant", "The PKCE code_verifier does not match.");
      }
      if (grant.revoked_at || !memberStillIn(db, grant.member_id)) {
        return new OAuthError("invalid_grant", "That connection has been revoked.");
      }
      return issueTokens(db, grant, now, opts);
    }

    if (grantType === "refresh_token") {
      const token = one("refresh_token");
      if (!token) return new OAuthError("invalid_request", "refresh_token is required.");
      const row = queryOne<RefreshRow>(
        db, `SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?`, sha256hex(token),
      );
      const grant = row ? getGrant(db, row.grant_id) : null;
      if (!row || !grant || grant.client_id !== client.client_id) {
        return new OAuthError("invalid_grant", "That refresh token is not valid.");
      }
      if (row.used_at && !row.revoked_at) {
        // OAuth 2.1 §4.3.1 · A rotated token used again: one of the two
        // holders is not the app, and there is no telling which.
        revokeForReuse(db, grant, "an old refresh token");
        return new OAuthError("invalid_grant", "That refresh token was already used.");
      }
      if (row.revoked_at || grant.revoked_at || row.expires_at <= at(now) || !memberStillIn(db, grant.member_id)) {
        return new OAuthError("invalid_grant", "That refresh token is no longer valid.");
      }
      execute(db, `UPDATE oauth_refresh_tokens SET used_at = ? WHERE token_hash = ?`, at(now), row.token_hash);
      return issueTokens(db, grant, now, opts);
    }

    return new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  });

  if (outcome instanceof OAuthError) throw outcome;
  return outcome;
}

/**
 * RFC 7009 · POST /oauth/revoke. An app disconnecting itself ends the whole
 * connection, whichever of its tokens it names. A token that is not this
 * client's, or not anything, is answered the same way — 200 and nothing done —
 * so the endpoint says nothing about what exists.
 */
export function revocationRequest(
  db: DB, body: Record<string, string | string[]>, clientId: string | undefined,
): void {
  const token = typeof body.token === "string" ? body.token : undefined;
  if (!token) throw new OAuthError("invalid_request", "token is required.");
  const client = getClient(db, clientId);
  if (!client) throw new OAuthError("invalid_client", "That client is not registered here.", 401);
  transact(db, () => {
    const digest = sha256hex(token);
    const grantId =
      queryOne<{ grant_id: string }>(db, `SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash = ?`, digest)?.grant_id
      ?? queryOne<{ grant_id: string }>(
        db, `SELECT oauth_grant_id AS grant_id FROM api_tokens WHERE token_hash = ? AND oauth_grant_id IS NOT NULL`, digest,
      )?.grant_id;
    const grant = grantId ? getGrant(db, grantId) : null;
    if (!grant || grant.client_id !== client.client_id || grant.revoked_at) return;
    revokeGrantCredentials(db, grant.id);
    appendEvent(db, { memberId: grant.member_id, source: "api", sourceDetail: client.client_name }, {
      entity: "ai-connection", entityId: grant.id, action: "revoke",
      summary: `The AI app "${client.client_name}" disconnected itself`,
    });
  });
}

// ---------------------------------------------------------------------------
// Settings → API tokens · Connected AI apps
// ---------------------------------------------------------------------------

export interface Connection {
  id: string;
  clientName: string;
  redirectHost: string;
  redact: boolean;
  /** AIW · The member allowed it to make changes. */
  canWrite: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * A member's live connections. One that was approved but never redeemed is
 * listed too: it is a door the member opened, and they may want it shut.
 */
export function listConnections(db: DB, memberId: string): Connection[] {
  const rows = queryAll<GrantRow & { client_name: string; redirect_uris: string }>(
    db,
    `SELECT g.*, c.client_name, c.redirect_uris
       FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id
      WHERE g.member_id = ? AND g.revoked_at IS NULL
      ORDER BY g.created_at DESC`,
    memberId,
  );
  return rows.map((r) => {
    const redirect = queryOne<{ redirect_uri: string }>(
      db, `SELECT redirect_uri FROM oauth_codes WHERE grant_id = ? ORDER BY created_at DESC LIMIT 1`, r.id,
    )?.redirect_uri;
    let hosts: string[] = [];
    try {
      hosts = (JSON.parse(r.redirect_uris) as string[]).map(redirectHost);
    } catch { /* shown as unknown */ }
    return {
      id: r.id,
      clientName: r.client_name,
      redirectHost: redirect ? redirectHost(redirect) : [...new Set(hosts)].join(", ") || "unknown",
      redact: r.redact === 1,
      canWrite: r.can_write === 1,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    };
  });
}

export function revokeConnection(db: DB, actor: Actor, grantId: string): void {
  transact(db, () => {
    const grant = getGrant(db, grantId);
    if (!grant || grant.member_id !== actor.memberId || grant.revoked_at) {
      // Only one's own, and not saying which of the two it was.
      throw new Missing("That connection does not exist.");
    }
    revokeGrantCredentials(db, grant.id);
    const client = getClient(db, grant.client_id);
    appendEvent(db, actor, {
      entity: "ai-connection", entityId: grant.id, action: "revoke",
      summary: `Disconnected the AI app "${client?.client_name ?? "unknown"}"`,
    });
  });
}
