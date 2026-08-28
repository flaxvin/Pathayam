/**
 * `04` §3.4 · The Gmail authorisation grant.
 *
 * Separate from sign-in on purpose. Login (`auth/google.ts`) asks only for
 * `openid email profile` and keeps nothing but the identity — that minimalism
 * is a security property worth not losing. Reading a mailbox is a different,
 * heavier consent: it needs `gmail.readonly`, offline access so the app can
 * poll without the user present, and a **refresh token that must be stored**.
 *
 * So this is its own flow, opt-in, and the token it yields is held like the
 * statement identity: never exported, never logged, deleted on revocation.
 *
 * The scope is read-only and nothing broader. `04` §3.4 also constrains what
 * is *read*: only messages from configured bank senders (enforced in
 * `fetch.ts`'s query), and only the extracted fields are ever kept.
 */

import { randomBytes, createHash } from "node:crypto";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/** Read-only Gmail, and the address, so the connection can name itself. */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly email";

export interface GmailAuthStart {
  url: string;
  state: string;
  codeVerifier: string;
}

export function beginGmailConnect(opts: {
  clientId: string; redirectUri: string;
}): GmailAuthStart {
  const state = randomBytes(16).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    // offline + consent are what actually yield a refresh token; without both,
    // Google returns only a one-hour access token and unattended polling is
    // impossible. `consent` is required to re-issue the refresh token if the
    // household reconnects.
    access_type: "offline",
    prompt: "consent",
  });

  return { url: `${AUTH_ENDPOINT}?${params}`, state, codeVerifier };
}

export class GmailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailAuthError";
  }
}

export interface GmailTokens {
  refreshToken: string;
  accessToken: string;
  /** Seconds from now. */
  expiresIn: number;
  scope: string;
}

export async function exchangeGmailCode(opts: {
  clientId: string; clientSecret: string; redirectUri: string;
  code: string; codeVerifier: string; fetchImpl?: typeof fetch;
}): Promise<GmailTokens> {
  const body = await postToken(opts.fetchImpl ?? fetch, {
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
    code: opts.code,
    code_verifier: opts.codeVerifier,
  });

  if (!body.refresh_token) {
    // Almost always means the grant was made without offline access, or Google
    // suppressed the refresh token on a repeat consent — hence prompt=consent.
    throw new GmailAuthError(
      "Google did not return a refresh token. Reconnect and grant offline access.",
    );
  }

  return {
    refreshToken: body.refresh_token,
    accessToken: body.access_token ?? "",
    expiresIn: body.expires_in ?? 3600,
    scope: body.scope ?? GMAIL_SCOPE,
  };
}

/** Refresh an access token from the stored refresh token. */
export async function refreshAccessToken(opts: {
  clientId: string; clientSecret: string; refreshToken: string; fetchImpl?: typeof fetch;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const body = await postToken(opts.fetchImpl ?? fetch, {
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
  });

  if (!body.access_token) {
    // A revoked or expired refresh token lands here; the caller treats it as a
    // dropped connection.
    throw new GmailAuthError("Google would not renew the connection. Reconnect Gmail.");
  }
  return { accessToken: body.access_token, expiresIn: body.expires_in ?? 3600 };
}

/** Tell Google to forget the grant, on revocation. Best-effort. */
export async function revokeToken(
  token: string, fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchImpl(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // The local token is deleted regardless; a failed remote revoke must not
    // block that.
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

async function postToken(
  doFetch: typeof fetch, params: Record<string, string>,
): Promise<TokenResponse> {
  const response = await doFetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!response.ok) {
    throw new GmailAuthError(`Google rejected the request (HTTP ${response.status}).`);
  }
  return (await response.json()) as TokenResponse;
}
