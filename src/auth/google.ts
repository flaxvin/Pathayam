/**
 * F1.1 · Google SSO. The only way in, in production — there is no password
 * store to breach.
 *
 * Authorization-code flow. The ID token is read from Google's token endpoint
 * directly, over TLS, authenticated by our client secret, so its payload is
 * trustworthy without a separate JWKS signature check — the signature matters
 * when a token arrives from the *browser*, which under this flow it never
 * does. The issuer, audience and expiry are still checked, because a
 * misconfigured client is a real failure mode and cheap to catch.
 */

import { randomBytes, createHash } from "node:crypto";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const VALID_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
  emailVerified: boolean;
}

export interface OAuthStart {
  url: string;
  state: string;
  codeVerifier: string;
}

/** Build the redirect to Google, with PKCE and a CSRF state value. */
export function beginOAuth(opts: { clientId: string; redirectUri: string }): OAuthStart {
  const state = randomBytes(16).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    // The app never acts on the user's behalf at Google, so no refresh token
    // is requested and nothing is stored beyond the profile.
    prompt: "select_account",
  });

  return { url: `${AUTH_ENDPOINT}?${params}`, state, codeVerifier };
}

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
}): Promise<GoogleProfile> {
  const doFetch = opts.fetchImpl ?? fetch;

  const response = await doFetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: "authorization_code",
      code: opts.code,
      code_verifier: opts.codeVerifier,
    }),
  });

  if (!response.ok) {
    throw new OAuthError(`Google rejected the sign-in (HTTP ${response.status}).`);
  }

  const payload = (await response.json()) as { id_token?: string };
  if (!payload.id_token) throw new OAuthError("Google did not return an identity token.");

  return parseIdToken(payload.id_token, opts.clientId);
}

/**
 * Decode and sanity-check an ID token. Exported so it can be tested without a
 * network round-trip.
 */
export function parseIdToken(idToken: string, expectedAudience: string, now = Date.now()): GoogleProfile {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OAuthError("That identity token is malformed.");

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new OAuthError("That identity token could not be read.");
  }

  if (typeof claims.iss !== "string" || !VALID_ISSUERS.has(claims.iss)) {
    throw new OAuthError("That identity token did not come from Google.");
  }
  if (claims.aud !== expectedAudience) {
    throw new OAuthError("That identity token was issued for a different application.");
  }
  if (typeof claims.exp === "number" && claims.exp * 1000 < now) {
    throw new OAuthError("That sign-in took too long — please try again.");
  }
  if (typeof claims.sub !== "string" || typeof claims.email !== "string") {
    throw new OAuthError("Google did not return an email address.");
  }

  return {
    sub: claims.sub,
    email: claims.email.toLowerCase(),
    name: typeof claims.name === "string" && claims.name ? claims.name : claims.email.split("@")[0]!,
    picture: typeof claims.picture === "string" ? claims.picture : null,
    emailVerified: claims.email_verified === true,
  };
}
