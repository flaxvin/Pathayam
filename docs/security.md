# Security

A self-hosted app holding one household's complete financial history. The threat
model is modest — a handful of trusted people, behind a tunnel, on a machine
they own — and the consequences of getting it wrong are not.

A full review was run against the whole app in September 2026. It found
twenty-two defects in two families. All are fixed; the record of what else was
checked and found sound is below, so the next review starts from there rather
than repeating it.

## What the review found

### Eighteen routes acted on somebody else's things

The largest single failure found in this app, and covered in
[privacy.md](privacy.md): every parameterised route aimed at one member's
private account, transaction, envelope, group and receipt, signed in as somebody
else. Five read — including the receipt's bytes — and thirteen wrote.

### Four open redirects

The theme toggle, the review queue, the impersonation banner, and **sign-in**
took a redirect target from the request and used it as given.

Sign-in is the one that matters: an open redirect there lands somebody on
another site at the exact moment they have proved who they are and are expecting
to be somewhere familiar.

The instructive part is that one of the four *did* check, with
`startsWith("/")`. That reads as a check and is not one — `//evil.example`
starts with a slash and is a protocol-relative URL the browser resolves to
another host. All four now share one `safePath` helper, and a static test fails
if a redirect target ever reaches a response without passing through it.

### Two template hardenings

Neither exploitable; both shaped like the bug rather than being it. An attribute
built by string concatenation without escaping, and a `when()` helper that
accepted a plain string and wrapped it in `raw` — so a callback returning a
payee name would have reached the page unescaped. It takes `SafeHtml` only now.

## Cross-site writes

Every unsafe method must carry an `Origin` belonging to this app, with `Referer`
as the fallback for browsers that omit `Origin` on same-origin form posts. That
fallback is sound rather than a hole: `Referrer-Policy: same-origin` means a
same-origin post carries a Referer and a cross-origin post does not.

Bearer-authenticated calls are exempt — they carry no cookie, so a browser
cannot be tricked into making one on somebody's behalf, which is the entire
mechanism CSRF depends on.

This is enforced in **one middleware**, not by a hidden token in each of a
hundred and five forms, because the hundred and sixth is the one somebody
forgets — and it covers every route added after today. It is the second lock:
the session cookie is `SameSite=Lax` and no GET in the router changes state, a
property a test verifies by walking every handler.

## What was checked and found sound

| | |
|---|---|
| **SQL injection** | Every query parameterised. The one dynamically-built `UPDATE` assembles its `SET` clause from literal column names; values go through placeholders. |
| **XSS** | The template tag escapes by default — `& < > " '`, so attribute contexts are covered — and an unescaped value has to be typed on purpose. Every `raw()` call site audited; the SVG chart builders escape every label they interpolate. |
| **Sessions** | 32 bytes of `randomBytes`, stored as a SHA-256 hash and looked up by hash, `HttpOnly`, `SameSite=Lax`, `Secure` when the base URL is HTTPS. |
| **API tokens** | Hashed lookup, constant-time comparison, revocation and expiry checked after, with their own fixed-window rate limit. |
| **Rate limiting** | On the OAuth callback and on API tokens — the two paths where a credential is presented. |
| **Path traversal** | Not reachable: attachments are bytes in the database, and no filesystem path is built from user input. |
| **Uploads** | A MIME allowlist of images and PDF — no SVG, no HTML — enforced against both the declared type and the extension, 10 MB cap, served with `nosniff`. PDFs download rather than render inline. |
| **Secrets** | Statement identity (PAN, date of birth) and Gmail tokens are named in `NEVER_EXPORTED`. The request log records method, **pathname**, status and duration — no query string, no body, no headers. |
| **SSRF** | Every outbound host is a hardcoded Google or price-feed endpoint; user-supplied values reach only path segments, through `encodeURIComponent`. |
| **Response headers** | CSP with no `unsafe-inline` for scripts, `frame-ancestors 'none'`, `form-action 'self'`, `base-uri 'self'`, `object-src 'none'`, plus `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Permissions-Policy`, `Cache-Control: no-store`. |
| **Untrusted files** | The PDF and CSV parsers fuzzed with empty, truncated, garbage, all-null, absurd-length and **self-referential page-tree** inputs. No hang, no crash, every case under 11ms — including the recursive case, which is the classic infinite-loop trap in a PDF reader. |
| **Configuration** | The app refuses to start with `DEMO_MODE` and `DEV_LOGIN` both set, and demo mode is gated behind its own deployment check. |
| **Dependencies** | None at runtime. There is no supply chain to audit. |

## Deliberately not defended against

Worth stating so nobody assumes otherwise:

- **Somebody with the database file.** It is not encrypted at rest. Disk
  encryption is the operating system's job.
- **A malicious household member.** Privacy separates members who trust each
  other and want some things kept personal. It is not an adversarial boundary:
  a member with an account can see the household's money, by design.
- **Somebody with root on the host.** Sessions, tokens and the database are all
  readable there.

## Reporting

It is one household's app. If you are reading this because you found something,
open an issue — or if it is serious enough to be worth not writing down in
public, say so in the issue without the detail and we will find a better
channel.
