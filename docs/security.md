# Security

## Threat model

A self-hosted application holding one household's financial history, reachable
on a private origin, used by a small number of trusted people.

**In scope:** anything reachable over HTTP by an unauthenticated party or by a
member acting outside their own data; anything that leaves the machine.

**Out of scope:** an attacker with the database file, the host, or root. The
database is not encrypted at rest; disk encryption is the operating system's
responsibility. Privacy between members separates people who trust each other —
it is not an adversarial boundary.

## Authentication

**Google OAuth 2.0** with PKCE. No password is stored.

- The `state` value is 16 random bytes, held in memory, single-use, expiring
  after ten minutes.
- The email must already be a member with `allowed = 1`. Others are refused and
  the attempt recorded in `auth_attempts`.
- Sign-in attempts are rate limited per source address; exceeding the limit
  returns 429.

**Sessions.** 32 random bytes, base64url. Stored as a SHA-256 hash; the
plaintext exists only in the cookie. Cookie flags: `HttpOnly`, `SameSite=Lax`,
`Path=/`, and `Secure` when `BASE_URL` is HTTPS. Idle expiry is `SESSION_DAYS`.
Sessions can be revoked individually from Settings.

**API tokens.** `Authorization: Bearer`. Stored as a hash, compared in constant
time, checked for revocation and expiry after lookup. Scoped `read` or
`read-write`, with a deny-list of path prefixes a token may never reach —
including token management itself. Rate limited per token.

**Development login** (`DEV_LOGIN`) is absent from the production image: the
module is compiled then deleted, and the build asserts its absence. The
application also refuses to start with it enabled in a production-shaped
environment.

**Demo mode** (`DEMO_MODE`) bypasses authentication. It refuses to start
alongside `DEV_LOGIN` and applies its own deployment safety check.

## Authorisation

Per-member visibility is described in [privacy.md](privacy.md): visible-entity
guards on every parameterised route, `viewerMemberId` through every query that
can return data for a person, and 404 rather than 403.

## Cross-site request forgery

Two independent controls:

1. The session cookie is `SameSite=Lax`, and no `GET` handler in the router
   mutates state — verified by a test that walks every handler for write calls.
2. Every unsafe method must carry an `Origin` matching the deployment, or a
   `Referer` from it when `Origin` is absent. `Referrer-Policy: same-origin`
   guarantees a same-origin request carries a `Referer` and a cross-origin one
   does not. Failure returns 403.

Bearer-authenticated requests are exempt from (2): they carry no cookie.

The check is one middleware, applied before routing, and therefore covers every
route.

## Redirects

Any redirect target taken from a request passes through `safePath`, which
requires a path beginning with a single `/`, rejects `//` and `/\` (which
browsers resolve as another origin), and rejects control characters. Applied to
the sign-in return, the theme toggle, the review queue and the impersonation
banner.

## Output encoding

`src/http/html.ts` escapes `& < > " '` on every interpolation, covering both
element and attribute contexts. `raw()` is the only way to emit unescaped
output, and `when()` accepts only `SafeHtml`. Server-generated SVG escapes every
interpolated label.

`jsonScript()` escapes `<` as `<` for values embedded in script blocks.

## Input handling

- **SQL**: every query is parameterised. The single dynamically-assembled
  `UPDATE` builds its `SET` clause from literal column names.
- **Uploads**: MIME allow-list of `image/jpeg`, `image/png`, `image/webp`,
  `image/heic`, `image/heif`, `application/pdf`, checked against both the
  declared type and the extension. 10 MB limit. Stored as blobs, so no path is
  constructed from user input. Served with `nosniff`; PDFs are served
  `Content-Disposition: attachment`, images inline. The filename in the header
  is reduced to word characters, dots, spaces, parentheses and hyphens.
- **Untrusted parsers**: the PDF and CSV readers are fuzzed with empty,
  truncated, malformed, all-null, absurd-length and self-referential inputs.

## Transport and headers

Applied to every response:

```
Content-Security-Policy: default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';
  connect-src 'self'; frame-src 'none'; frame-ancestors 'none';
  form-action 'self'; base-uri 'self'; object-src 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: same-origin
Permissions-Policy: geolocation=(), camera=(), microphone=(), interest-cohort=()
Cache-Control: no-store
```

No third-party script, style, font or image is loaded.

## Secrets

- `statement_identity` and `gmail_connections` are listed in `NEVER_EXPORTED`
  and excluded from the JSON and CSV exports.
- Statement passwords are used and discarded; only a description of which
  candidate worked is retained.
- The request log records method, **path without query string**, status and
  duration. No body, no headers, no query parameters, no financial values.

## Outbound requests

Every outbound host is fixed in source: Google's OAuth and Gmail endpoints, and
two price providers. User-supplied values reach only path segments and query
values, through `encodeURIComponent`. `BACKUP_WEBHOOK_URL` and `HEARTBEAT_URL`
are operator-configured.

## Dependencies

None at runtime.

## Passwords

scrypt from `node:crypto` — N=32768, r=8, p=1 — with the parameters stored
inside the encoded hash, so the cost can be raised later without invalidating
existing passwords. An old hash keeps verifying and is rewritten on the next
successful sign-in.

- Stored in `member_passwords`, never on the member row. That row is read on
  nearly every request; a secret that is never loaded cannot be logged,
  serialised into a view model, or exported by accident.
- In `NEVER_EXPORTED`. A hash is not a password but it is an offline guessing
  target, and an export is the most portable thing this app produces.
- Verification is constant-time, and a malformed or hostile stored row fails
  rather than throwing — this is the sign-in path, and an exception there is a
  500 on a login page. Parameters read from the database are bounded before
  use, so a tampered row cannot ask scrypt for unbounded memory.
- Eight failures lock the credential for fifteen minutes. Per credential, not
  per address: IP rate limiting already exists and is the right tool against a
  flood from one place, and the wrong one against somebody patient with many.
- A wrong password and an unknown address are refused in identical words. The
  difference would disclose who is in this household.
- Changing a password requires the current one.
