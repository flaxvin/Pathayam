# API reference

This app is a **server-rendered web application first**. There is no separate
"API server": the same HTTP routes that render HTML also answer JSON, and a
**personal API token** lets your own scripts reach a safe subset of them.

This document describes that surface: how to authenticate, what a token can
and cannot reach, how responses are shaped, and which machine-readable
endpoints are best for scripts. It is generated from the code in
[`src/app.ts`](../src/app.ts), [`src/auth/tokens.ts`](../src/auth/tokens.ts),
and [`src/http/server.ts`](../src/http/server.ts). Where the code and this file
disagree, the code is correct; please open an issue.

- [Model at a glance](#model-at-a-glance)
- [Authentication](#authentication)
  - [Minting a token](#minting-a-token)
  - [Using a token](#using-a-token)
  - [Scopes](#scopes)
  - [What a token can never reach](#what-a-token-can-never-reach)
- [Rate limiting](#rate-limiting)
- [Requesting JSON](#requesting-json)
- [Idempotency](#idempotency)
- [Response & error shapes](#response--error-shapes)
- [Machine-readable endpoints](#machine-readable-endpoints)
  - [`GET /healthz`](#get-healthz)
  - [`GET /export.json`](#get-exportjson)
  - [`GET /export.csv`](#get-exportcsv)
  - [`GET /export/analysis.json`](#get-exportanalysisjson)
  - [Portfolio & net-worth CSVs](#portfolio--net-worth-csvs)
- [Worked examples](#worked-examples)
- [Full route reference](#full-route-reference)
- [Security notes](#security-notes)

---

## Model at a glance

| | |
|---|---|
| **Transport** | Plain HTTP/1.1. Behind a reverse proxy in production (TLS terminates there). |
| **Base URL** | Your deployment's origin: `http://localhost:8080` in dev, e.g. `https://pathayam.example.com` in prod. |
| **Two ways in** | A **session cookie** (`pathayam_session`, set by signing in through a browser) or a **bearer token** (`Authorization: Bearer bgt_…`, for scripts). |
| **Token precedence** | A bearer token is honoured **only when there is no session cookie** on the request. Send one or the other, not both. |
| **Identity** | A token acts *as the member who minted it*. Every write is attributed to that member and names the token in the event log (F30.5). |
| **Format** | Send `Accept: application/json` to get JSON back from any route; otherwise you get HTML (or a redirect). |
| **State** | Every mutation is an append-only event (R37), so anything a token does can be undone and shows up in "explain this number". |

There is **no OAuth, no API versioning path prefix, and no separate hostname**.
The API is the app itself, limited by what the token may reach.

---

## Authentication

### Minting a token

Tokens are created **from the web UI only**, never over the API (a token that
could mint tokens would turn one leak into permanent access, F30.6). Sign in as a
member and open **Settings → API tokens** (`/tokens`):

1. Give the token a name (e.g. `nightly-export`). This name appears in the
   event log next to everything it does.
2. Choose a scope: **read** or **read-write**.
3. Choose an expiry: 90 days, a year, or never. (The server takes a whole
   number of days from 1 to 3650, or none; anything else is refused with 422.)

The secret is shown **exactly once**, at creation, and cannot be retrieved
again. Only a SHA-256 hash is stored, so the database cannot give it back even
to the server (F30.4). Copy it straight away. If you lose it, revoke it and mint
a new one.

A token looks like:

```
bgt_Xa3f9K2pLq7wYt0zR8sN1vB4cD6eF5gH2jK8mP0qRsT
```

The `bgt_` prefix helps you spot it in a config file. The secret itself is
32 random bytes, base64url-encoded.

### Using a token

Send it in the `Authorization` header on every request:

```bash
curl -sS https://pathayam.example.com/export.json \
  -H "Authorization: Bearer bgt_Xa3f9K2pLq7wYt0zR8sN1vB4cD6eF5gH2jK8mP0qRsT" \
  -H "Accept: application/json"
```

Revoked and expired tokens are rejected exactly like wrong ones, and the
server never tells you *which* it was. A token also stops working when its member is
removed from the household, as their sessions do, and none can be minted while
viewing as another member. Each accepted request updates the token's
`last_used_at`, which helps a household spot a token they forgot about
(shown in Settings → API tokens).

### Scopes

| Scope | GET (reads) | POST (writes) |
|---|---|---|
| `read` | ✅ | ❌ `403 { "error": "That token is read-only." }` (except `POST /mcp`, whose tools are reads for a read token; see [ai.md](ai.md)) |
| `read-write` | ✅ | ✅, except an AI connection's token (below) |

An **AI connection's token** (one made on Connect an AI, or the access token
of an app that signed in over OAuth) writes only through `POST /mcp`, whatever
its scope. Anywhere else a write is `403 { "error": "An AI connection's token
changes things only through /mcp, and only with its tools." }`. A read-write
one exists only where `AI_WRITE` allows changes and the member ticked "allow
changes" ([ai.md](ai.md#changes-an-ai-can-make)).

Scope is fixed at mint time. To change it, revoke and re-mint.

### Writes and the same-origin check

Every unsafe method (`POST`, and anything else that is not a read) must either
carry a **bearer token** or come from this app's own pages. Otherwise it is
refused with `403`. This stops another site from making a browser submit a
form on somebody's behalf with their cookie attached. Two checks apply, in
order:

1. **The host.** The request must be addressed to `BASE_URL`'s host and port,
   or to an IP literal or `localhost`. A DNS name is held to `BASE_URL`
   because another site can re-point its own name at this machine (DNS
   rebinding) and then its `Origin` and the `Host` agree. Behind a reverse
   proxy, either pass the original `Host` through, or set `TRUST_PROXY` and
   send `X-Forwarded-Host` (its right-most entry is used). Failure:
   `403 That request was addressed to a different host than BASE_URL.`
2. **The origin.** An `Origin` header belonging to the deployment (`BASE_URL`,
   or the host the request was addressed by). With no `Origin`, a `Referer`
   from the deployment is accepted instead; with neither, the request is
   refused.

**A token-authenticated call is exempt from both**, which is the case that
matters here: your scripts send `Authorization: Bearer …` and no cookie, so
there is no session for anybody to misuse. There is nothing extra to set. A request that
also carries a session cookie is held to both checks whatever else it carries.

A browser-side script using the session cookie instead does need to send an
`Origin` belonging to the deployment. `fetch` from a page of the app does this
automatically.

### What a token can never reach

Regardless of scope, a token is refused (`403`) on these path prefixes (F30.6,
enforced as a deny-list in [`tokenMayReach`](../src/auth/tokens.ts)):

| Prefix | Why it's blocked |
|---|---|
| `/tokens` | A token must not mint or revoke tokens, including itself. |
| `/members` | The household allow-list: `/members/invite` and `/members/:id/remove`. A token must not change who is allowed in. A settings sub-page for the same thing is denied alongside it, so it is covered before it exists. |
| `/impersonate` | Impersonation is a session-only, logged human action (R38.12). |
| `/auth` | Sign-in, SSO, and the dev-bypass state. |
| `/signout` | Nothing for a token to sign out of. |
| `/settings/password` | A password is a way in that does not need the token. A token that could set one would outlive its own revocation, and setting it signs the member's browsers out. |
| `/sessions` | Signing the member's devices out is a decision for a person to make, so scripts cannot do it. |
| `/gmail/connect`, `/gmail/callback`, `/gmail/disconnect`, `/gmail/keys` | Linking or unlinking a mailbox, or changing which Google client it consents to, changes what can reach the household. It does not change the budget itself. `/gmail/fetch` stays reachable. |
| `/forwarding/create`, `/forwarding/remove` | Making, replacing or turning off a forwarding address changes what mail can reach Review. `/forwarding/retry` stays reachable. |
| `/oauth` | Approving an AI app hands out a fresh token with its own refresh token; a token that could do that would outlive its own revocation. |

```json
// 403 on any forbidden prefix
{
  "error": "An API token cannot reach this. Tokens cannot sign in, impersonate, mint other tokens, or change who is allowed in."
}
```

### Connecting an AI app (OAuth)

claude.ai custom connectors, ChatGPT connectors, Gemini and other MCP clients
connect by URL: give them `${BASE_URL}/mcp` and they find the rest. Pathayam is
its own OAuth 2.1 authorization server for this, following the MCP
authorization spec (revision 2026-07-28); the code is
[`src/auth/oauth.ts`](../src/auth/oauth.ts).

1. `/mcp` without a usable token answers `401` with
   `WWW-Authenticate: Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource", scope="read"`.
2. The protected resource metadata (RFC 9728) names `${BASE_URL}/mcp` as the
   resource and `BASE_URL` as the authorization server; its metadata (RFC 8414)
   names the endpoints below.
3. The app registers itself (RFC 7591). Redirect URIs must be `https`, or
   `http` on `localhost`, `127.0.0.1` or `[::1]` (matched on any port, for
   native clients such as Claude Code and Gemini CLI). No fragments, no
   credentials, at most 10. Public clients only (`token_endpoint_auth_method`
   is always `none`).
4. The member, signed in, approves on `/oauth/authorize`. PKCE `S256` is
   required, `resource` must be `${BASE_URL}/mcp` when given, and every
   redirect back carries `iss` (RFC 9207).
5. The app trades the code at `/oauth/token` for an access token and a
   refresh token.

The access token **is an ordinary API token**: `bgt_`, scope `read`, one hour
long, named after the app ("Claude (connector)"). Where `AI_WRITE` is
`standard` or `full`, the metadata also offers `budget:write`; the consent page
then shows an "allow changes" box, never ticked for the member whatever the app
asked, and a connection approved with it gets `read-write` access tokens (the
token response's `scope` is `read budget:write`). Whether it may write is read
again at every refresh, so turning `AI_WRITE` off makes it read-only within the
hour. Either way the token is an AI connection's, confined to `/mcp`.
Everything above applies to it unchanged: the deny-list, the rate limit,
revocation and member removal. Refresh tokens last 90 days and rotate on every
use; presenting an old one again ends the connection, as does using a code
twice. Errors are RFC 6749 JSON (`invalid_grant`, `invalid_client`, …).

Settings → API tokens lists each approval under **Connected AI apps**;
**Revoke** there (or revoking the access token itself) ends the access token
and the refresh token together. Approving and disconnecting are recorded in
the activity log.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/.well-known/oauth-protected-resource` · `/.well-known/oauth-protected-resource/mcp` | public | RFC 9728 protected resource metadata. CORS-open. |
| GET | `/.well-known/oauth-authorization-server` | public | RFC 8414 authorization server metadata. CORS-open. |
| POST | `/oauth/register` | public | RFC 7591 registration, JSON in and out. 20 an hour per address; at most 200 clients; one nobody approved within a day is removed. |
| GET/POST | `/oauth/authorize` | session only | The consent page and its answer. Refused while viewing as another member and on the demo. |
| POST | `/oauth/token` | public | `authorization_code` and `refresh_token` grants, form-encoded. |
| POST | `/oauth/revoke` | public | RFC 7009. Ends the connection the token belongs to; answers `200` whatever it was. |
| POST | `/tokens/connections/:id/revoke` | session only | Disconnect an AI app (Settings → API tokens). |
| POST | `/mcp` | bearer, `read` is enough | The MCP endpoint itself. Bearer only: a session cookie is not looked at. `GET` and `DELETE` are `405`. Tools, masking and the protocol versions served are in [ai.md](ai.md). The change tools are listed only to a read-write AI connection where `AI_WRITE` allows them ([ai.md](ai.md#changes-an-ai-can-make)). |
| GET/POST | `/tokens/ai` | session only | Connect an AI: the address to give an app, tokens with set-up commands (read-only unless "allow changes" is ticked where `AI_WRITE` allows it), connected apps, which can make changes, and what they have read. |
| POST | `/tokens/ai/undo-today` | session only | Undo every change one of the member's AI connections made today (`connection_id`). When somebody has changed those records since, it answers a page listing what would be discarded; `force=1` undoes anyway. |

---

### Modules that are switched off

An instance may run with modules switched off (`PLAN` and `FEATURE_*`, see
[operations.md](operations.md#plans-and-modules)). Every route of a module
that is off answers **404**, the same as a route that never existed, whichever
way the request authenticates. With `FEATURE_API_TOKENS` off, every bearer
token answers **403** `{"error":"API tokens are not available on this
instance."}` except on `/mcp`, which `FEATURE_AI` governs. With `FEATURE_AI`
off, an AI connection's token (made on Connect an AI, or an app's OAuth access
token) answers **403** `{"error":"AI connections are not available on this
instance."}` on every route. The token is kept,
and it works again once the module is back on. The Health screen names the plan
and every module that is off.

## Rate limiting

Each token gets a **fixed window of 120 requests per 60 seconds**, counted
independently of any browser session (F30.7), so a runaway script cannot lock the
household out of their own budget.

When you exceed it:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 37
```
```json
{ "error": "That token is going too fast. Try again shortly." }
```

The `Retry-After` header is the whole number of seconds until the window resets.
The limiter is in-process (the deployment is a single process on one box), so it
resets if the server restarts.

---

## Requesting JSON

Content negotiation uses the **`Accept` header** only. If it contains
`application/json`, you get JSON; otherwise you get HTML.

```bash
# JSON
curl -H "Accept: application/json" .../move -X POST ...
# HTML (default browser behaviour)
curl .../move -X POST ...
```

This applies to *every* route, whether or not it is a machine endpoint. A `POST` you'd
normally make from a form returns, in JSON mode, the redirect target and a
human message instead of a `303` (see below).

---

## Idempotency

Any mutation (`POST`) accepts an **`Idempotency-Key`** header (R36). Replaying a
request with the same key, member, method, path and payload returns the original
outcome instead of performing the action twice. This is the safe way to retry
after a dropped connection.

```bash
curl -sS .../add -X POST \
  -H "Authorization: Bearer bgt_…" \
  -H "Accept: application/json" \
  -H "Idempotency-Key: 6f1c2e9a-2b7d-4c11-9f3e-8a5b1d0c7e42" \
  --data 'account_id=…&amount=-45000&payee=Chai&category_id=…'
```

- **Same key, same payload** → the stored result is replayed; nothing new
  happens.
- **Same key, *different* payload** → the request is rejected as a conflict with
  the status code recorded for the original (an `IdempotencyConflict` surfaces
  as an HTTP error). Use a fresh key for a genuinely new action.

Generate a UUID per logical action. Reusing a key across unrelated writes will
mask the second one.

Routes that ask a question before writing (the "Already reconciled"
confirmation on an edit, delete or undo, and the preview before applying a rule
to history) answer the question afresh; only the write behind it is keyed. A
repeated reconcile shows the same checkpoint again rather than recording another.

---

## Response & error shapes

**Successful mutation (JSON mode):** a `200` with the redirect the browser
*would* have followed, and a message:

```json
{ "redirect": "/accounts/9f2…", "message": "Saved." }
```

**Redirect (JSON mode):** the same, for plain redirects:

```json
{ "redirect": "/review" }
```

**Reads:** routes that render a page return HTML even in JSON mode, unless the
route explicitly emits JSON. The endpoints under
[Machine-readable endpoints](#machine-readable-endpoints) are the ones designed
to be consumed as data.

**Errors:** in JSON mode every error is `{ "error": "…" }` with the right
status code (without `Accept: application/json` the same message comes back as
an HTML page):

| Origin | Status |
|---|---|
| The auth / token layer | `401`, `403`, `429` |
| A handler's answer | `400` malformed input · `404` an id, in the URL or a form field, that does not exist or is not yours · `409` idempotency conflict · `422` the app refuses what was asked, and says why |
| An unexpected server fault | `500`, `Something went wrong on the server. Nothing you typed has been lost.` (details go to the structured log, never the response) |

So a script should branch on the **status code** and show `.error` to a
person. A financial value is never placed in a log line or an error body (S7).

Common statuses: `200` OK · `204` No Content · `303` See Other (HTML redirect) ·
`400` bad input · `401` not authenticated · `403` forbidden / read-only / out of
a token's reach · `404` not found · `405` method not allowed · `409`
idempotency conflict · `422` refused, with the reason · `429` rate-limited · `500` server fault · `503` health
check failing (from `/healthz`).

---

## Machine-readable endpoints

These are the routes built to be scripted. All are `GET`, all are reachable by a
`read` token, and all require authentication.

### `GET /healthz`

A liveness probe for external monitoring (F27.3). Returns `200` while the
instance can serve (the database answers) and `503` when it cannot. Nothing
recorded in the past (a failed request, a missed backup) changes the status
code.

Signed out, it says nothing else, because the full diagnosis names counts,
backup gaps and build details that are private to the household.

```bash
curl -sS https://pathayam.example.com/healthz
```
```json
{ "status": "ok", "serving": true, "version": "1.0.0" }
```

With a session or a `read` token it adds every check:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" https://pathayam.example.com/healthz
```
```json
{
  "status": "healthy",
  "serving": true,
  "version": "1.0.0",
  "checks": [
    { "group": "Backups", "name": "Last backup", "state": "healthy", "reason": "…" },
    { "group": "Backups", "name": "Restore verification", "state": "healthy", "reason": "…" },
    { "group": "Prices", "name": "Price feed", "state": "degraded", "reason": "…" }
  ]
}
```

Authenticated, `status` is the worst of the individual `state` values
(`healthy` / `degraded` / `failed`) and is diagnostic only: `serving` decides
the HTTP status.

### `GET /export.json`

The **entire budget** as a single JSON document (F15), the same export used for
backups. Served as a download.

```bash
curl -sS https://pathayam.example.com/export.json \
  -H "Authorization: Bearer bgt_…" -H "Accept: application/json" \
  -o budget-$(date +%F).json
```

> **Note:** the export deliberately excludes statement identity (PAN / DOB /
> mobile) and Gmail refresh tokens. That data is never exported and never
> leaves the instance (F15).

### `GET /export.csv`

Every transaction as CSV, for a spreadsheet.

```bash
curl -sS https://pathayam.example.com/export.csv \
  -H "Authorization: Bearer bgt_…" -o transactions.csv
```

### `GET /export/analysis.json`

A **summary** of the member's figures, meant for pasting into an AI tool or
loading into a spreadsheet: the overview, each budget's current month and the
last `months` months (default 12, 1 to 36), spending by envelope and the top
20 payees per month, loans, portfolio, net worth, the next 30 days' cashflow,
goals, insurance and this financial year's tax estimate. Amounts are rupees
(two decimals), dates `YYYY-MM-DD`, and `currency` is stated once at the top.

It contains what the member sees on screen and nothing more: another member's
private accounts, loans, policies and personal budget are left out, including
from totals. It is not a backup, and there is no transaction list. A section
whose feature is switched off reads `{ "enabled": false }`. Read-only, so a
read token reaches it.

```bash
curl -sS "https://pathayam.example.com/export/analysis.json?months=24" \
  -H "Authorization: Bearer bgt_…" -o analysis.json
```

### Portfolio & net-worth CSVs

Available when the assets feature is enabled. One shape each (F19.13):

| Endpoint | Contents |
|---|---|
| `GET /portfolio/holdings.csv` | Current holdings: units, average cost, price, value, gain. |
| `GET /portfolio/lots.csv` | Individual FIFO lots with acquisition dates and costs. |
| `GET /portfolio/prices.csv` | Price history per instrument. |
| `GET /net-worth.csv` | The dated net-worth history. |

```bash
for f in holdings lots prices; do
  curl -sS "https://pathayam.example.com/portfolio/$f.csv" \
    -H "Authorization: Bearer bgt_…" -o "$f.csv"
done
curl -sS https://pathayam.example.com/net-worth.csv \
  -H "Authorization: Bearer bgt_…" -o net-worth.csv
```

Each download's filename carries the current IST date, e.g.
`holdings-2026-08-28.csv`.

**Cells that would run as a formula are escaped** in `/export.csv`,
`/query.csv`, the portfolio CSVs and `/net-worth.csv` (one cell function,
`src/core/csv.ts`). A payee or narration comes from whoever sent the statement
or alert, so a cell starting with `=`, `+`, `-`, `@`, tab or carriage return is
prefixed with `'` and opens as text. A plain number such as `-1250.5` is left
alone so amounts still sum. A script reading these files should strip that
leading `'` if it wants the original text.

---

### The mail receiver's hand-off: `POST /inbound/email`

Not for scripts: this is how the mail receiver (`src/mx`, see
[forwarding.md](forwarding.md)) passes a forwarded message to the app. It is
answered before sessions, tokens and the same-origin rule, and only when
`FEATURE_FORWARDING` is on. The body is the raw message (`message/rfc822`);
`X-Pathayam-Recipient` names the address, and `X-Pathayam-Signature` is
`t=<unix seconds>,v1=<hex HMAC-SHA256>` over `<t>.<recipient>.` and the body,
keyed with `INBOUND_SECRET` and at most five minutes old.

| Status | Meaning |
|---|---|
| `202` | Taken: imported, or logged and dropped (not a bank, no valid bank signature). |
| `401` | The signature is missing, wrong or stale. A missing, malformed or stale header is refused before the body is read. |
| `404` | No such address on this instance. The receiver refuses the message. |
| `413` | Over 26 MiB. |
| `503` | `INBOUND_DOMAIN` or `INBOUND_SECRET` is not set; or four hand-offs are already being read (with `Retry-After`), and the receiver tells the sender to retry. |

### The mail receiver's address check: `POST /inbound/check`

Also not for scripts: the receiver asks this before it takes a message, so mail
to an address nobody has is refused at once. No body; `X-Pathayam-Recipient`
names the address, and `X-Pathayam-Signature` is `t=<unix seconds>,v1=<hex
HMAC-SHA256>` over `check.<t>.<recipient>.`, keyed with `INBOUND_SECRET` and at
most five minutes old.

| Status | Meaning |
|---|---|
| `200` | `{"known": true}` for an address in use on this instance, `{"known": false}` otherwise. |
| `401` | The signature is missing, wrong or stale. Nothing is said about the address. |
| `503` | `INBOUND_DOMAIN` or `INBOUND_SECRET` is not set. |

## Worked examples

**A nightly backup, verifying it isn't empty:**

```bash
#!/usr/bin/env bash
set -euo pipefail
TOKEN="bgt_…"                       # a read-scoped token
BASE="https://pathayam.example.com"

# Fail fast if the app is unhealthy.
curl -fsS "$BASE/healthz" >/dev/null

out="budget-$(date +%F).json"
curl -fsS "$BASE/export.json" \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  -o "$out"

# A trivial sanity check before trusting the file.
bytes=$(wc -c < "$out")
[ "$bytes" -gt 1000 ] || { echo "export suspiciously small ($bytes bytes)"; exit 1; }
echo "saved $out ($bytes bytes)"
```

**Adding a transaction safely (read-write token, idempotent):**

```bash
KEY=$(uuidgen)
curl -fsS "$BASE/add" -X POST \
  -H "Authorization: Bearer $RW_TOKEN" \
  -H "Accept: application/json" \
  -H "Idempotency-Key: $KEY" \
  --data-urlencode "account_id=$ACCOUNT" \
  --data-urlencode "amount=-45000" \
  --data-urlencode "payee=Chai" \
  --data-urlencode "category_id=$CATEGORY"
# → { "redirect": "/accounts/…", "message": "Saved." }
# Retrying with the same $KEY is a no-op.
```

Amounts are **integer paise** (`-45000` = −₹450.00). See
[`docs/02-*`](README.md) for the money model.

---

## Full route reference

Every route below is served by [`src/app.ts`](../src/app.ts). "Token" shows
whether a **read** token (R), a **read-write** token (W), or **no token** (—,
session-only, because the path is in the forbidden list) can reach it. All
routes require authentication except `/signin`, `/auth/*`, `/healthz`,
`/privacy`, `/terms` and `/demo/enter`.

Legend: **R** = any token · **W** = read-write token only · **—** = session
only (out of a token's reach).

### Budget & money

| Method | Path | Token | Purpose |
|---|---|---|---|
| GET | `/` | R | The month budget grid. |
| POST | `/assign` | W | Assign to a category. |
| GET/POST | `/move` | R/W | Move between envelopes. |
| GET/POST | `/hold` | R/W | Hold income for next month. |
| GET/POST | `/auto-assign` | R/W | Fund-to-target, with preview, for one budget (`?budget=`, else the last one viewed), from that budget's Ready to Assign. |
| GET | `/overview` | R | Runway, due-soon bills, the month at a glance. |
| POST | `/budgets/personal` | W | Create your own personal budget, if you do not have one (`15` §2). |
| GET | `/more` | R | The hub of everything not in the primary nav. |
| POST | `/copy-last-month` | W | Copy last month's assignments into this one. |
| GET | `/explain/ready-to-assign` | R | Why RTA is what it is. |
| GET | `/explain/category/:id` | R | Explain a category's number. |

### Accounts & transactions

| Method | Path | Token | Purpose |
|---|---|---|---|
| GET | `/accounts` | R | All accounts and balances. |
| GET/POST | `/accounts/new` | R/W | Create an account. |
| GET | `/accounts/:id` | R | One account's register. |
| POST | `/accounts/:id/edit` · `/accounts/:id/close` · `/accounts/:id/reopen` | W | Rename, close (never delete) and reopen an account. |
| POST | `/accounts/:id/deposit` | W | Set or change a deposit's terms (`deposit_kind` `fd`/`rd`/`ppf`/`epf`/`other`, `deposit_principal`, `deposit_instalment`, `deposit_rate` as a percentage, `deposit_compounding`, `deposit_start_date`, `deposit_maturity_date`, `deposit_payout` `cumulative`/`periodic`). A fixed deposit, recurring deposit or other-asset tracking account only. `/accounts/new` takes the same fields. |
| POST | `/accounts/:id/deposit/remove` | W | Take a deposit's terms off; it is worth its balance again. |
| GET/POST | `/accounts/:id/statement` | R/W | Record a card statement: amount, date, due date, minimum. |
| GET | `/accounts/:id/cards` | R | Cards on one account, including add-ons. |
| POST | `/accounts/:id/cards` | W | Add a card to the account (`label`, optional `last4` and `holder_member_id`). |
| POST | `/accounts/:id/cards/:cardId/close` | W | Close an add-on card. |
| GET | `/cards` | R | Every credit card in due-date order, with what is unfunded. |
| GET/POST | `/accounts/:id/reconcile` | R/W | Reconcile to a statement balance. |
| GET/POST | `/add` | R/W | Create a transaction, with its envelope lines (`split_category_N` / `split_amount_N`; the first carries no amount and takes the remainder). |
| GET | `/transfer` | R | The transfer form. Accounts whose value is derived (loans, family loans) are not offered. |
| POST | `/transfer` | W | Transfer between accounts. |
| GET | `/transaction/:id` | R | Transaction detail, splits, history. |
| POST | `/transaction/:id` | W | Edit a transaction, including its envelope lines (same fields as `/add`). A legacy `category_id` is still read when no lines are sent; an *empty* one on an already-split transaction means "not mentioned", not "file it nowhere". **Partial edits:** a field you do not send keeps its stored value (`amount`, `direction`, `date`, `payee`, `memo`, `tags`, `owner_member_id`, the envelope lines, `cleared` and `reimbursable`), so `date=07-09-2026` alone moves only the date. A field you *do* send is applied: an empty `memo` clears it, an empty `payee` removes it, an empty `tags` removes them all, an empty `owner_member_id` makes it the household's; a blank `amount` is refused and a blank `date` keeps the old one. For the two flags, `cleared=1` / `reimbursable=1` sets and any other value (e.g. `0`) unsets. The web form also sends `cleared_present=1` and `reimbursable_present=1`, because an unticked checkbox sends nothing: a marker with no flag means "unticked", no marker and no flag means "not mentioned". |
| POST | `/transaction/:id/delete` | W | Delete (undoable). |
| POST | `/transaction/:id/categorise` | W | File one transaction into an envelope. Also the learning signal (B100). |
| POST | `/transaction/:id/settled` | W | Mark a reimbursable transaction as repaid. |
| POST | `/transaction/:id/attach` | W | Attach a receipt. |
| GET | `/attachment/:id` | R | Fetch a receipt's bytes. |
| POST | `/attachment/:id/delete` | W | Remove a receipt. |

### Review, import & rules

| Method | Path | Token | Purpose |
|---|---|---|---|
| GET | `/review` | R | The review queue. |
| POST | `/review/approve` · `/review/reject` · `/review/merge` | W | Act on staged items. |
| POST | `/review/ai/:id/approve` · `/review/ai/:id/reject` | W | Decide on a change one of the member's own AI connections suggested (`AI_WRITE=standard`). Approving makes it as the member; another member's is 404. Not reachable by an AI connection's token. |
| GET/POST | `/import` | R/W | CSV paste import. |
| POST | `/import/pdf` | W | Statement-PDF upload. |
| POST | `/import/map` | W | Save a column mapping. |
| POST | `/import/budget-app` | W | Import a YNAB or Actual Budget export: `csv`, `account_<n>` (an account id or `skip`, one per account in the file, in order), and `date_order` when every date reads both ways. Transactions only. |
| POST | `/import/undo` | W | Undo an import batch. |
| POST | `/import/profiles/:id/delete` | W | Delete a saved mapping. |
| GET | `/rules` | R | Rules list. |
| POST | `/rules/test` · `/rules/new` · `/rules/:id/apply` · `/rules/:id/delete` · `/rules/confirm` · `/rules/dismiss` | W | Manage rules. |
| GET | `/payees` | R | Payees. |
| POST | `/payees/merge` | W | Merge two payees. |
| GET | `/household` | R | What each member has committed to the shared budget this month. |
| GET | `/members/:id/remove` | — | What removing a member does, and how the balance between you can end. Session only. |
| POST | `/members/:id/remove` | — | Remove a member, settling what is outstanding first (`15` §6A). Session only. |
| POST | `/members/:id/password-link` | — | A one-time link that sets another member's first password, shown once on the page it returns. Refused (422) for yourself, a member with a password, one who has signed in before, or one holding records you cannot see. For those, run `npm run password-link` on the server. Session only. |
| POST | `/household/pick-up` | W | Commit more, taking on what the household is behind by. |
| POST | `/household/call-it-even` | W | Close part of a balance by agreement; it becomes spending on the giving side. |
| GET | `/categories` | R | Categories, for the budget being viewed (`?budget=`). |
| POST | `/groups/new` · `/groups/:id/rename` · `/groups/:id/delete` | W | Add, rename or remove a category group. A group must be empty to be deleted. |
| POST | `/categories/new` · `/categories/:id/rename` · `/categories/:id/hide` · `/categories/:id/delete` | W | Manage categories. |
| GET/POST | `/tax` | R/W | Income tax estimate for the signed-in member and one financial year (`fy`). POST saves gross income, deductions, TDS (`tds`) and an optional own figure for home loan interest under section 24(b) (`s24b`; blank uses the interest accrued on loans marked as for a self-occupied house). Refuses a year whose rates the app does not have. |
| POST | `/tax/payments` · `/tax/payments/:id/delete` | W | Record (`fy`, `kind` = `advance` or `self-assessment`, `date`, `amount`, `note`) or remove a tax payment of the signed-in member's own. Advance tax must be dated inside its financial year. Another member's payment is not found. |
| POST | `/categories/:id/merge` | W | Merge this category into `winner_id`: assignments are summed month by month, history and targets move across, and this one is deleted. Refuses a payment category and a merge across budgets. |
| POST | `/categories/:id/target` | W | Set or clear a category's target: `amount`, `kind` (`monthly` or `refill`; omitted keeps a stored refill) and optional `target_date` (makes it by-date). |
| POST | `/categories/:id/reorder` · `/groups/:id/reorder` | W | Move a category or group up or down. |

### Schedules, goals & loans

| Method | Path | Token | Purpose |
|---|---|---|---|
| GET | `/schedules` | R | Recurring items & cashflow calendar. |
| GET | `/schedules/new` | R | The form for a new schedule. |
| POST | `/schedules/new` · `/schedules/confirm` · `/schedules/dismiss` · `/schedules/:id/paid` · `/schedules/:id/skip` | W | Manage schedules. A schedule may be money in or money out; `/schedules/new` takes envelope lines like `/add`. `recurrence` must be one of the eight the app knows. An unrecognised value is refused, and is never treated as monthly. With `monthly-nth-weekday`, `recurrence_ordinal` (1–4, or −1 for last) and `recurrence_weekday` (0 = Sunday) say which one, and `next_due` is moved to the first such day on or after it. |
| POST | `/schedules/:id/edit` · `/schedules/:id/delete` | W | Change or remove a schedule, including its envelope lines (`split_category_N` / `split_amount_N`; the first carries no amount and takes the remainder). A new amount with no line fields re-files the stored lines the same way, or is refused when the other lines leave nothing for the first. Removing leaves everything it already recorded. |
| GET | `/goals` | R | Savings goals. |
| POST | `/goals/new` · `/goals/:id/complete` · `/goals/:id/edit` · `/goals/:id/delete` | W | Manage goals. |
| GET | `/loans` · `/loans/:id` | R | Loans and one loan's detail. |
| GET/POST | `/loans/new` | R/W | Create a loan. |
| GET/POST | `/loans/what-if` | R/W | Prepayment / rate what-if. |
| POST | `/loans/:id/disburse` | W | Record a tranche drawdown. |
| GET/POST | `/loans/:id/pay` | R/W | Record an instalment. |
| GET/POST | `/loans/:id/prepay` | R/W | Record a prepayment. |
| GET/POST | `/loans/:id/rate` | R/W | Record a rate reset. |
| POST | `/loans/:id/holder` | W | Change whose loan it is and whether it is private (H2, H2.2). |
| POST | `/loans/:id/property` | W | Say what the house the loan paid for is used for (`property_use` = `self-occupied`, `let-out`, or empty for neither). A self-occupied house's accrued interest is carried into its holder's tax estimate (TAX-1). Undoable from the activity log. |
| POST | `/loans/:id/close` | W | File away a paid-off loan (R21). |
| POST | `/loans/:id/settle` | W | Settle a loan early, recording the lender's foreclosure charge (R19.5). |
| POST | `/transaction/:id/convert-to-emi` | W | Convert a card purchase to an instalment plan (`06` §7.4, F8.5). |
| GET | `/loans/:id/statement` | R | The form for recording a lender's statement against one loan. |
| POST | `/loans/:id/statement` | W | Record a lender's statement: `lender_outstanding` (required, not negative), and optionally `interest_paid_ytd` and `instalments_remaining`. The difference from the app's own figure is reported as drift. |
| GET | `/loans/:id/schedule.csv` | R | Amortisation schedule as CSV. |

### Family lending

| Method | Path | Token | Purpose |
|---|---|---|---|
| GET | `/family` · `/family/:id` | R | Lent/borrowed and one arrangement. |
| POST | `/family/new` · `/family/:id/advance` · `/family/:id/repayment` · `/family/:id/write-off` · `/family/:id/close` | W | Manage family loans. |

### Insurance

| Method | Path | Token | Purpose |
|---|---|---|---|
| GET | `/insurance` · `/insurance/:id` | R | The policy register, and one policy. A private policy answers 404 to anyone but its holder. |
| POST | `/insurance/new` · `/insurance/:id/edit` | W | Record or change a policy. `policy_number` keeps only its last four characters. |
| POST | `/insurance/:id/paid` | W | Move the next due date on by the premium frequency. Posts no transaction. Optional `back` (a path) to return to. |
| POST | `/insurance/:id/status` | W | `status` = `lapsed`, `ended` or `active`. A lapsed or ended policy is kept. |
| POST | `/insurance/:id/delete` | W | Remove a policy recorded by mistake (undoable from Activity). |

### Portfolio, assets & net worth

| Method | Path | Token | Purpose |
|---|---|---|---|
| GET | `/portfolio` | R | Holdings, XIRR, other assets. |
| GET | `/portfolio/:id` | R | One instrument. |
| GET/POST | `/portfolio/add` | R/W | Add a holding. `?instrument=<id>` (where "Choose" on a searched scheme lands) buys that instrument; the POST takes `instrument_id` for it. |
| GET/POST | `/portfolio/:id/sell` | R/W | Record a sale. |
| GET/POST | `/portfolio/cas` | R/W | Import a CDSL CAS. |
| POST | `/portfolio/cas/confirm` | W | Confirm a parsed CAS. |
| GET/POST | `/portfolio/safegold` | R/W | Import a SafeGold statement (digital gold). A SafeGold PDF posted to `/import/pdf` lands on the same review. |
| GET | `/portfolio/safegold/review` | R | The review of a SafeGold plan a Gmail fetch read, by its `token`. |
| POST | `/portfolio/safegold/confirm` | W | Confirm a parsed SafeGold statement; `accept_mismatch=1` imports one whose rows miss its closing balance. |
| GET | `/portfolio/allocation` | R | Allocation by class/region/currency. |
| POST | `/portfolio/instrument/:id/classify` | W | Set an instrument's class. |
| POST | `/portfolio/instrument/:id/listed` | W | Say whether a bond is listed on an exchange. |
| POST | `/portfolio/refresh` | W | Refresh prices. |
| GET | `/net-worth` | R | Net-worth decomposition & history. |
| GET | `/fire` | R | Financial-independence projection from trailing spending. |
| POST | `/net-worth/snapshot` | W | Take a dated snapshot. |
| GET/POST | `/portfolio/asset/new` | R/W | Add a hand-valued asset. |
| GET/POST | `/portfolio/asset/:id/add` | W | Buy more of a hand-valued asset: records the payment leaving an account and the new stated value. |
| GET/POST | `/portfolio/asset/:id/dispose` | W | Record that a hand-valued asset is gone, and optionally the money arriving. Values it at zero on the date and closes the account; the dated history stays. |
| GET/POST | `/portfolio/asset/:id/revalue` | R/W | Say what one asset is worth today. |
| GET/POST | `/portfolio/valuations` | R/W | Update every hand-valued asset in one sitting. |
| GET/POST | `/portfolio/:id/price` | R/W | Record a price for one instrument. |
| GET/POST | `/portfolio/:id/split` | R/W | Record a stock split or bonus issue. It applies to every open holding of the instrument; the same action on the same date is refused a second time. |
| GET/POST | `/portfolio/:id/merge` | R/W | Record a merger or scheme amalgamation (R28). Cost and purchase dates carry forward, so nothing is realised. |
| GET | `/portfolio/holdings.csv` · `/portfolio/lots.csv` · `/portfolio/prices.csv` · `/net-worth.csv` | R | CSV exports. |

### Months, reports & query

| Method | Path | Token | Purpose |
|---|---|---|---|
| GET | `/months` · `/months/:month/close` | R | Month-close ritual & history. |
| POST | `/months/:month/close` · `/months/:month/reopen` | W | Close / reopen a month. |
| GET | `/reports` | R | Income vs spend, trends, loan interest. |
| GET | `/query` · `/search` | R | Filterable table. |
| GET | `/query.csv` | R | Query results as CSV. |

### Settings, health & data

| Method | Path | Token | Purpose |
|---|---|---|---|
| GET | `/settings` | R | Household settings. |
| POST | `/settings/theme` · `/settings/learning` · `/settings/overspend-model` · `/settings/identity` · `/settings/digest` | W | Change settings. |
| POST | `/settings/theme-toggle` | W | Flip between light and dark (`seen` says what a "system" theme shows; `return_to` a path to go back to). The no-JavaScript fallback for the header control. |
| GET | `/activity` | R | Every change ever made, with its undo. `?entity=` narrows to one kind of record; `?source=ai` to what AI connections changed (or a member approved from one). |
| POST | `/activity/:id/undo` | W | Undo one recorded event (30 days, R37.8). |
| GET | `/health` | R | Health dashboard (HTML). |
| POST | `/health/backup` · `/health/verify` | W | Run a backup / verify a restore. |
| POST | `/gmail/fetch` | W | Fetch from the connected mailbox now. (`/gmail/disconnect` is session only.) |
| POST | `/gmail/card-digits` | W | Save a card account's last four to eight digits (`account_id`, `card_digits`), offered after a fetch left its statement locked for want of them. Never echoed; the notice shows the last two. |
| POST | `/forwarding/retry` | W | Try the member's locked forwarded statements again with the statement details on file; each that opens is imported and deleted. |
| POST | `/forwarding/held/:id/delete` | W | Delete one locked forwarded statement. |
| GET | `/export.json` · `/export.csv` | R | Full data exports. |
| GET | `/export/analysis.json` | R | A summary of the member's figures for AI tools and spreadsheets (`months`, 1–36). |
| GET | `/healthz` | R (public) | Machine health probe. |

### Session-only (out of a token's reach)

These return `403` to any token. Use a browser session instead.

| Method | Path | Why |
|---|---|---|
| GET/POST | `/tokens` | Listing and minting tokens (F30.6). |
| POST | `/tokens/:id/revoke` | Revoking a token (F30.6). |
| POST | `/members/invite` | The household allow-list. |
| GET/POST | `/members/:id/remove` | Removing a member changes who is allowed in. |
| POST | `/members/:id/password-link` | A link that sets somebody's password is a way in. |
| POST | `/gmail/disconnect` | Unlinking a mailbox. |
| POST | `/gmail/keys` | Saving or removing your own, or the household's, Google OAuth client. |
| POST | `/forwarding/create` · `/forwarding/remove` | Making, replacing or turning off a forwarding address. |
| POST | `/impersonate/start` · `/impersonate/writes` · `/impersonate/exit` | Impersonation (R38.12). |
| POST | `/sessions/revoke` | Session management. |
| GET | `/auth/google` · `/auth/google/callback` · `/auth/oidc` · `/auth/oidc/callback` · `/gmail/connect` · `/gmail/callback` | OAuth and OIDC flows (interactive). |
| POST | `/auth/dev` · `/signout` | Sign-in / sign-out. |
| GET/POST | `/auth/first-run` | The first password on a household with no members. 404 unless `LOCAL_LOGIN` is set, and 404 once any member exists. |
| GET/POST | `/auth/setup/:token` | A one-time password link, opened signed out: set a first password and be signed in. Works once, for 72 hours; every unusable link answers the same 410. Rate limited. |
| POST | `/auth/password` | Password sign-in (F1.6). 404 unless `LOCAL_LOGIN` is set or a password already exists. |
| GET/POST | `/settings/password` | Set or change your own password. Changing one requires the current password. |

### Public and first-run pages

Not API endpoints, listed so the reference is complete. The first four need no
session.

| Method | Path | Purpose |
|---|---|---|
| GET | `/signin` | The sign-in page. |
| GET | `/privacy` · `/terms` | The privacy policy and terms of service. |
| POST | `/demo/enter` | Sign in to the demo household, as `member_id` or its oldest member. 404 unless `DEMO_MODE` is set. |
| GET/POST | `/setup` | First run for a signed-in member: a starting set of categories from monthly income and a few yes/no questions. |
| POST | `/setup/blank` | First run with no starting categories. |

> This table is a snapshot; the authoritative list is the router in
> [`src/app.ts`](../src/app.ts) and the deny-list in
> [`src/auth/tokens.ts`](../src/auth/tokens.ts).

---

## Security notes

- **The secret is shown once.** Store it in a secrets manager or an env var,
  never in the repo. If it leaks, revoke it in Settings → API tokens; revocation
  is immediate.
- **Prefer `read` scope.** Most automation (backups, dashboards, monitoring)
  never needs to write. A read token that leaks cannot change your budget.
- **Set an expiry** for tokens tied to a specific task.
- **A token is narrower than a session by design.** It cannot authenticate a
  person, impersonate, mint tokens, or change the household allow-list, whatever
  its scope. This is enforced by a deny-list of path prefixes: any route under
  a listed prefix, including one added later, is refused to tokens.
- **Everything a token does is logged and can be undone.** Each change is
  attributed to the member, names the token (F30.5) and is stored as an
  append-only event (R37).
- **Never send identity or credentials over the API.** Statement identity and
  Gmail tokens are not exportable and not returned by any endpoint.
