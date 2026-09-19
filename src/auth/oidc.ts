/**
 * Sign-in against any OpenID Connect provider.
 *
 * Password sign-in removed the hard dependency on Google; this removes the
 * *soft* one. A household running Authelia, Authentik, Keycloak or Zitadel
 * already has an identity provider, and asking them to keep a second set of
 * credentials in this app — or a Google project — is asking them to weaken
 * what they have set up.
 *
 * It is the top request by a wide margin on comparable self-hosted budgeting
 * apps, which is not surprising: somebody who self-hosts a ledger is exactly
 * the person who already runs SSO.
 *
 * ## Discovery, rather than four endpoints in the environment
 *
 * The provider is configured with one value — its issuer URL — and everything
 * else is read from `/.well-known/openid-configuration`. Four endpoints pasted
 * into environment variables is four chances to paste one wrong, and the error
 * that produces arrives halfway through a redirect chain where it cannot be
 * read.
 *
 * The document is fetched once and cached for the life of the process. It
 * changes about never, and re-fetching it on every sign-in would put the
 * provider on the critical path twice instead of once.
 *
 * ## What is verified, and what is not
 *
 * The code is exchanged at the token endpoint directly, over TLS, so the
 * response came from the provider by construction rather than by signature.
 * The ID token's issuer, audience and expiry are still checked, because those
 * catch a genuinely different failure: a token minted by the right provider
 * for a *different application*, replayed here.
 *
 * The signature itself is not verified. Doing so means fetching JWKS, matching
 * a key id, and implementing RS256 verification, and it defends against an
 * attacker who can already MITM a TLS connection to the provider — at which
 * point the token is the least of it. This is written down rather than left
 * implicit because "we don't verify the signature" should be a decision
 * somebody can find and disagree with.
 */

import { randomBytes, createHash } from "node:crypto";
import { OAuthError } from "./google.ts";

export interface OidcProfile {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
  emailVerified: boolean;
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  issuer: string;
}

const cache = new Map<string, Discovery>();

/** Exposed so tests can start from nothing; not used by the app. */
export function clearDiscoveryCache(): void {
  cache.clear();
}

export async function discover(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Discovery> {
  const cached = cache.get(issuer);
  if (cached) return cached;

  /*
   * The spec says the document sits at exactly this path under the issuer,
   * with no path element of the issuer stripped — so a provider hosted at
   * https://auth.example/realms/home discovers at
   * https://auth.example/realms/home/.well-known/openid-configuration.
   */
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;

  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new OAuthError(
      `Could not reach the identity provider at ${url}. ${(error as Error).message}`,
    );
  }
  if (!response.ok) {
    throw new OAuthError(
      `The identity provider at ${url} answered ${response.status}. Check OIDC_ISSUER.`,
    );
  }

  let document: Partial<Discovery>;
  try {
    document = await response.json() as Partial<Discovery>;
  } catch {
    throw new OAuthError(`${url} did not return a discovery document.`);
  }

  if (!document.authorization_endpoint || !document.token_endpoint || !document.issuer) {
    throw new OAuthError(
      `${url} is missing authorization_endpoint, token_endpoint or issuer.`,
    );
  }

  /*
   * The issuer in the document must match the one configured. A mismatch means
   * the discovery document is describing somebody else, which is the shape of
   * a mix-up attack — and it is also what a trailing slash in the environment
   * looks like, so the message says both.
   */
  if (document.issuer.replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) {
    throw new OAuthError(
      `That provider calls itself ${document.issuer}, but OIDC_ISSUER is ${issuer}. ` +
      "They have to match exactly.",
    );
  }

  const discovery = document as Discovery;
  cache.set(issuer, discovery);
  return discovery;
}

export interface OidcStart {
  url: string;
  state: string;
  codeVerifier: string;
}

export async function beginOidc(
  config: OidcConfig,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcStart> {
  const discovery = await discover(config.issuer, fetchImpl);
  const state = randomBytes(16).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const separator = discovery.authorization_endpoint.includes("?") ? "&" : "?";
  return {
    url: `${discovery.authorization_endpoint}${separator}${params}`,
    state, codeVerifier,
  };
}

/**
 * Claims from an ID token, checked but not signature-verified — see the note
 * at the top of this file.
 */
export function parseOidcIdToken(
  idToken: string, issuer: string, audience: string, now = Date.now(),
): OidcProfile {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OAuthError("That identity token is malformed.");

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new OAuthError("That identity token could not be read.");
  }

  if (typeof claims.iss !== "string" ||
      claims.iss.replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) {
    throw new OAuthError("That identity token came from a different provider.");
  }
  /*
   * `aud` may be a string or an array — a provider that issues one token for
   * several clients uses the array form, and treating it as a string would
   * reject a perfectly valid token.
   */
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) {
    throw new OAuthError("That identity token was issued for a different application.");
  }
  if (typeof claims.exp === "number" && claims.exp * 1000 < now) {
    throw new OAuthError("That sign-in took too long — please try again.");
  }
  if (typeof claims.sub !== "string") {
    throw new OAuthError("That identity token carries no subject.");
  }
  if (typeof claims.email !== "string" || !claims.email) {
    throw new OAuthError(
      "The provider returned no email address. This app identifies members by email, " +
      "so the 'email' scope has to be granted and an address set on the account.",
    );
  }

  return {
    sub: claims.sub,
    email: claims.email.toLowerCase(),
    name: typeof claims.name === "string" && claims.name
      ? claims.name
      : typeof claims.preferred_username === "string" && claims.preferred_username
        ? claims.preferred_username
        : claims.email.split("@")[0]!,
    picture: typeof claims.picture === "string" ? claims.picture : null,
    emailVerified: claims.email_verified === true,
  };
}

export async function exchangeOidcCode(opts: {
  config: OidcConfig;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<OidcProfile> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const discovery = await discover(opts.config.issuer, fetchImpl);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.config.clientId,
    client_secret: opts.config.clientSecret,
    code_verifier: opts.codeVerifier,
  });

  const response = await fetchImpl(discovery.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    /*
     * The provider's own error text, when there is any. "invalid_client" with
     * the provider's wording beats a generic failure: it is nearly always a
     * mistyped secret or a redirect URI that does not match, and saying which
     * saves an hour.
     */
    let detail = "";
    try {
      const failure = await response.json() as { error?: string; error_description?: string };
      detail = failure.error_description || failure.error || "";
    } catch { /* not JSON; the status will have to do */ }
    throw new OAuthError(
      `The identity provider refused the sign-in${detail ? `: ${detail}` : ` (${response.status})`}.`,
    );
  }

  const tokens = await response.json() as { id_token?: string; access_token?: string };
  if (!tokens.id_token) {
    throw new OAuthError("The identity provider returned no id_token.");
  }

  return parseOidcIdToken(
    tokens.id_token, opts.config.issuer, opts.config.clientId, opts.now,
  );
}
