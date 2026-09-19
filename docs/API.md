# API reference

This app is a **server-rendered web application first**. There is no separate
"API server" — the same HTTP routes that render HTML also answer JSON, and a
**personal API token** lets your own scripts reach a safe subset of them.

This document is the contract for that surface: how to authenticate, what a
token may and may not touch, how responses are shaped, and the machine-readable
endpoints worth scripting against. It is generated from the code in
[`src/app.ts`](../src/app.ts), [`src/auth/tokens.ts`](../src/auth/tokens.ts),
and [`src/http/server.ts`](../src/http/server.ts) — where those disagree with
this file, the code wins; please open an issue.

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
  - [Portfolio & net-worth CSVs](#portfolio--net-worth-csvs)
- [Worked examples](#worked-examples)
- [Full route reference](#full-route-reference)
- [Security notes](#security-notes)

---

## Model at a glance

| | |
|---|---|
| **Transport** | Plain HTTP/1.1. Behind a reverse proxy in production (TLS terminates there). |
| **Base URL** | Your deployment's origin — `http://localhost:8080` in dev, e.g. `https://pathayam.example.com` in prod. |
| **Two ways in** | A **session cookie** (`pathayam_session`, set by signing in through a browser) or a **bearer token** (`Authorization: Bearer bgt_…`, for scripts). |
| **Token precedence** | A bearer token is honoured **only when there is no session cookie** on the request. Send one or the other, not both. |
| **Identity** | A token acts *as the member who minted it*. Every write is attributed to that member and names the token in the event log (F30.5). |
| **Format** | Send `Accept: application/json` to get JSON back from any route; otherwise you get HTML (or a redirect). |
| **State** | Every mutation is an append-only event (R37) — so anything a token does is undoable and shows up in "explain this number". |

There is **no OAuth, no API versioning path prefix, and no separate hostname**.
The API is the app, narrowed by a token.

---

## Authentication

### Minting a token

Tokens are created **from the web UI only** — never over the API (a token that
could mint tokens turns one leak into permanent access, F30.6). Sign in as a
member and open **Settings → API tokens** (`/tokens`):

1. Give the token a name (e.g. `nightly-export`) — this is what appears in the
   event log next to everything it does.
2. Choose a scope: **read** or **read-write**.
3. Optionally set an expiry in days.

The secret is shown **exactly once**, at creation, and is never retrievable
again — only a SHA-256 hash is stored, so the database cannot give it back even
to the server (F30.4). Copy it immediately. If you lose it, revoke it and mint a
new one.

A token looks like:

```
bgt_Xa3f9K2pLq7wYt0zR8sN1vB4cD6eF5gH2jK8mP0qRsT
```

The `bgt_` prefix is a human hint for spotting it in a config file; the entropy
is 32 random bytes, base64url-encoded.

### Using a token

Send it in the `Authorization` header on every request:

```bash
curl -sS https://pathayam.example.com/export.json \
  -H "Authorization: Bearer bgt_Xa3f9K2pLq7wYt0zR8sN1vB4cD6eF5gH2jK8mP0qRsT" \
  -H "Accept: application/json"
```

Revoked and expired tokens are rejected exactly like wrong ones — the server
never tells you *which* it was. Each accepted request updates the token's
`last_used_at`, which is how a household spots a token they forgot about
(visible back in Settings → API tokens).

### Scopes

| Scope | GET (reads) | POST (writes) |
|---|---|---|
| `read` | ✅ | ❌ `403 { "error": "That token is read-only." }` |
| `read-write` | ✅ | ✅ |

Scope is fixed at mint time. To change it, revoke and re-mint.

### Writes and the same-origin check

Every unsafe method (`POST`, and anything else that is not a read) must either
carry a **bearer token** or come from this app's own pages, proved by an
`Origin` header — otherwise it is refused with `403`. It is what stops another
site making a browser submit a form on somebody's behalf with their cookie
attached.

**A token-authenticated call is exempt**, which is the case that matters here:
your scripts send `Authorization: Bearer …` and no cookie, so there is no
session for anybody to ride. Nothing extra to set.

A browser-side script using the session cookie instead does need to send an
`Origin` belonging to the deployment — which `fetch` from a page of the app does
on its own.

### What a token can never reach

Regardless of scope, a token is refused (`403`) on these path prefixes (F30.6,
enforced as a deny-list in [`tokenMayReach`](../src/auth/tokens.ts)):

| Prefix | Why it's blocked |
|---|---|
| `/tokens` | A token must not mint or revoke tokens — including itself. |
| `/members` | The household allow-list — `/members/invite` today. A token must not change who is allowed in. A settings sub-page for the same thing is denied alongside it, so it is covered before it exists. |
| `/impersonate` | Impersonation is a session-only, logged human action (R38.12). |
| `/auth` | Sign-in, SSO, and the dev-bypass state. |
| `/signout` | Nothing for a token to sign out of. |

```json
// 403 on any forbidden prefix
{
  "error": "An API token cannot reach this. Tokens cannot sign in, impersonate, mint other tokens, or change who is allowed in."
}
```

---

## Rate limiting

Each token gets a **fixed window of 120 requests per 60 seconds**, counted
independently of any browser session (F30.7) so a runaway script cannot lock the
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

Content negotiation is by the **`Accept` header** — nothing else. If it contains
`application/json`, you get JSON; otherwise you get HTML.

```bash
# JSON
curl -H "Accept: application/json" .../move -X POST ...
# HTML (default browser behaviour)
curl .../move -X POST ...
```

This applies to *every* route, not just the machine endpoints. A `POST` you'd
normally make from a form returns, in JSON mode, the redirect target and a
human message instead of a `303` (see below).

---

## Idempotency

Any mutation (`POST`) accepts an **`Idempotency-Key`** header (R36). Replaying a
request with the same key, member, method, path and payload returns the original
outcome instead of performing the action twice — the safe way to retry after a
dropped connection.

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

---

## Response & error shapes

**Successful mutation (JSON mode)** — a `200` with the redirect the browser
*would* have followed and a message:

```json
{ "redirect": "/accounts/9f2…", "message": "Saved." }
```

**Redirect (JSON mode)** — the same idea for plain redirects:

```json
{ "redirect": "/review" }
```

**Reads** — routes that render a page return HTML even in JSON mode unless the
route explicitly emits JSON. The endpoints under
[Machine-readable endpoints](#machine-readable-endpoints) are the ones designed
to be consumed as data.

**Errors** — two shapes, by where the error is raised:

| Origin | Body |
|---|---|
| The auth / token layer (401, 403, 429) | JSON: `{ "error": "…" }` |
| A handler validation error (e.g. 400, 404, 409) thrown as an `HttpError` | The message as **plain text** with the right status code |
| An unexpected server fault | `500` plain text `Something went wrong on the server.` (details go to the structured log, never the response) |

So a script should branch on the **status code**, and read `.error` from the
body only for `401/403/429`. A financial value is never placed in a log line or
an error body (S7).

Common statuses: `200` OK · `204` No Content · `303` See Other (HTML redirect) ·
`400` bad input · `401` not authenticated · `403` forbidden / read-only / out of
a token's reach · `404` not found · `405` method not allowed · `409`
idempotency conflict · `429` rate-limited · `500` server fault · `503` health
check failing (from `/healthz`).

---

## Machine-readable endpoints

These are the routes built to be scripted. All are `GET`, all are reachable by a
`read` token, and all require authentication.

### `GET /healthz`

An unauthenticated liveness/health probe for external monitoring (F27.3).
Returns `200` when healthy, `503` when any check has failed.

```bash
curl -sS https://pathayam.example.com/healthz
```
```json
{
  "status": "healthy",
  "version": "0.1.0",
  "checks": [
    { "group": "Backups", "name": "Last backup", "state": "healthy", "reason": "…" },
    { "group": "Backups", "name": "Restore verification", "state": "healthy", "reason": "…" },
    { "group": "Prices", "name": "Price feed", "state": "degraded", "reason": "…" }
  ]
}
```

`status` is the worst of the individual `state` values (`healthy` /
`degraded` / `failed`); only `failed` flips the HTTP status to `503`.

### `GET /export.json`

The **entire budget** as a single JSON document (F15) — the same export used for
backups. Served as a download.

```bash
curl -sS https://pathayam.example.com/export.json \
  -H "Authorization: Bearer bgt_…" -H "Accept: application/json" \
  -o budget-$(date +%F).json
```

> **Note:** the export deliberately excludes statement identity (PAN / DOB /
> mobile) and Gmail refresh tokens — that data is never exported and never
> travels (F15).

### `GET /export.csv`

Every transaction as CSV, for a spreadsheet.

```bash
curl -sS https://pathayam.example.com/export.csv \
  -H "Authorization: Bearer bgt_…" -o transactions.csv
```

### Portfolio & net-worth CSVs

Available when the assets feature is enabled. One shape each (F19.13):

| Endpoint | Contents |
|---|---|
| `GET /portfolio/holdings.csv` | Current holdings — units, average cost, price, value, gain. |
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

---

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
routes require authentication except `/signin`, `/auth/*`, and `/healthz`.

Legend: **R** = any token · **W** = read-write token only · **—** = session
only (out of a token's reach).

### Budget & money

| Method | Path | Token | Purpose |
|---|---|---|---|
| GET | `/` | R | The month budget grid. |
| POST | `/assign` | W | Assign to a category. |
| GET/POST | `/move` | R/W | Move between envelopes. |
| GET/POST | `/hold` | R/W | Hold income for next month. |
| GET/POST | `/auto-assign` | R/W | Fund-to-target, with preview. |
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
| GET/POST | `/accounts/:id/statement` | R/W | Record a card statement: amount, date, due date, minimum. |
| GET | `/accounts/:id/cards` | R | Cards on one account, including add-ons. |
| POST | `/accounts/:id/cards/:cardId/close` | W | Close an add-on card. |
| GET | `/cards` | R | Every credit card in due-date order, with what is unfunded. |
| GET/POST | `/accounts/:id/reconcile` | R/W | Reconcile to a statement balance. |
| GET/POST | `/add` | R/W | Create a transaction. |
| POST | `/transfer` | W | Transfer between accounts. |
| GET | `/transaction/:id` | R | Transaction detail, splits, history. |
| POST | `/transaction/:id` | W | Edit a transaction. |
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
| GET/POST | `/import` | R/W | CSV paste import. |
| POST | `/import/pdf` | W | Statement-PDF upload. |
| POST | `/import/map` | W | Save a column mapping. |
| POST | `/import/undo` | W | Undo an import batch. |
| POST | `/import/profiles/:id/delete` | W | Delete a saved mapping. |
| GET | `/rules` | R | Rules list. |
| POST | `/rules/test` · `/rules/new` · `/rules/:id/apply` · `/rules/:id/delete` · `/rules/confirm` · `/rules/dismiss` | W | Manage rules. |
| GET | `/payees` | R | Payees. |
| POST | `/payees/merge` | W | Merge two payees. |
| GET | `/household` | R | What each member has committed to the shared budget this month. |
| GET | `/members/:id/remove` | R | What removing a member does, and how the balance between you can end. |
| POST | `/members/:id/remove` | W | Remove a member, settling what is outstanding first (`15` §6A). |
| POST | `/household/pick-up` | W | Commit more, taking on what the household is behind by. |
| POST | `/household/call-it-even` | W | Close part of a balance by agreement; it becomes spending on the giving side. |
| GET | `/categories` | R | Categories, for the budget being viewed (`?budget=`). |
| POST | `/groups/new` · `/groups/:id/rename` · `/groups/:id/delete` | W | Add, rename or remove a category group. A group must be empty to be deleted. |
| POST | `/categories/new` · `/categories/:id/rename` · `/categories/:id/hide` · `/categories/:id/delete` | W | Manage categories. |
| GET/POST | `/tax` | W | Income tax estimate for the signed-in member and one financial year (`fy`). POST saves gross income and deductions. Refuses a year whose rates the app does not have. |
| POST | `/categories/:id/merge` | W | Merge this category into `winner_id`: assignments are summed month by month, history and targets move across, and this one is deleted. Refuses a payment category and a merge across budgets. |
| POST | `/categories/:id/target` | W | Set or clear a category's target. |
| POST | `/categories/:id/reorder` · `/groups/:id/reorder` | W | Move a category or group up or down. |

### Schedules, goals & loans

| Method | Path | Token | Purpose |
|---|---|---|---|
| GET | `/schedules` | R | Recurring items & cashflow calendar. |
| POST | `/schedules/new` · `/schedules/confirm` · `/schedules/dismiss` · `/schedules/:id/paid` · `/schedules/:id/skip` | W | Manage schedules. A schedule may be money in or money out. |
| POST | `/schedules/:id/edit` · `/schedules/:id/delete` | W | Change or remove a schedule. Removing leaves everything it already recorded. |
| POST | `/schedules/:id/splits` | W | Set or clear the envelopes a schedule divides into. Lines arrive as `split_category_N` / `split_amount_N` and must add up to the schedule's amount. Posting the schedule then posts a split transaction. |
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
| POST | `/loans/:id/close` | W | File away a paid-off loan (R21). |
| POST | `/loans/:id/settle` | W | Settle a loan early, recording the lender's foreclosure charge (R19.5). |
| POST | `/transaction/:id/convert-to-emi` | W | Convert a card purchase to an instalment plan (`06` §7.4, F8.5). |
| GET | `/loans/:id/statement` | R | One loan's statement view. |
| GET | `/loans/:id/schedule.csv` | R | Amortisation schedule as CSV. |

### Family lending

| Method | Path | Token | Purpose |
|---|---|---|---|
| GET | `/family` · `/family/:id` | R | Lent/borrowed and one arrangement. |
| POST | `/family/new` · `/family/:id/advance` · `/family/:id/repayment` · `/family/:id/write-off` · `/family/:id/close` | W | Manage family loans. |

### Portfolio, assets & net worth

| Method | Path | Token | Purpose |
|---|---|---|---|
| GET | `/portfolio` | R | Holdings, XIRR, other assets. |
| GET | `/portfolio/:id` | R | One instrument. |
| GET/POST | `/portfolio/add` | R/W | Add a holding. |
| GET/POST | `/portfolio/:id/sell` | R/W | Record a sale. |
| GET/POST | `/portfolio/cas` | R/W | Import a CDSL CAS. |
| POST | `/portfolio/cas/confirm` | W | Confirm a parsed CAS. |
| GET | `/portfolio/allocation` | R | Allocation by class/region/currency. |
| POST | `/portfolio/instrument/:id/classify` | W | Set an instrument's class. |
| POST | `/portfolio/refresh` | W | Refresh prices. |
| GET | `/net-worth` | R | Net-worth decomposition & history. |
| GET | `/fire` | R | Financial-independence projection from trailing spending. |
| POST | `/net-worth/snapshot` | W | Take a dated snapshot. |
| GET/POST | `/portfolio/asset/new` | R/W | Add a hand-valued asset. |
| GET/POST | `/portfolio/asset/:id/dispose` | W | Record that a hand-valued asset is gone, and optionally the money arriving. Values it at zero on the date and closes the account; the dated history stays. |
| GET/POST | `/portfolio/asset/:id/revalue` | R/W | Say what one asset is worth today. |
| GET/POST | `/portfolio/valuations` | R/W | Update every hand-valued asset in one sitting. |
| GET/POST | `/portfolio/:id/price` | R/W | Record a price for one instrument. |
| GET/POST | `/portfolio/:id/split` | R/W | Record a stock split or bonus issue. |
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
| POST | `/settings/theme` · `/settings/learning` · `/settings/overspend-model` · `/settings/identity` · `/settings/digest` · `/settings/password` | W | Change settings. |
| GET | `/activity` | R | Every change ever made, with its undo. |
| POST | `/activity/:id/undo` | W | Undo one recorded event (30 days, R37.8). |
| GET | `/health` | R | Health dashboard (HTML). |
| POST | `/health/backup` · `/health/verify` | W | Run a backup / verify a restore. |
| POST | `/gmail/disconnect` · `/gmail/fetch` | W | Manage Gmail ingestion. |
| GET | `/export.json` · `/export.csv` | R | Full data exports. |
| GET | `/healthz` | R (public) | Machine health probe. |

### Session-only (out of a token's reach)

These return `403` to any token — use a browser session.

| Method | Path | Why |
|---|---|---|
| GET/POST | `/tokens`, `/tokens/:id/revoke` | Minting/revoking tokens (F30.6). |
| POST | `/members/invite` | The household allow-list. |
| POST | `/impersonate/start` · `/impersonate/writes` · `/impersonate/exit` | Impersonation (R38.12). |
| POST | `/sessions/revoke` | Session management. |
| GET | `/auth/google` · `/auth/google/callback` · `/gmail/connect` · `/gmail/callback` | OAuth flows (interactive). |
| POST | `/auth/dev` · `/signout` | Sign-in / sign-out. |
| GET/POST | `/auth/first-run` | The first password on a household with no members. 404 once any member exists. |
| POST | `/auth/password` | Password sign-in (F1.6). 404 unless `LOCAL_LOGIN` is set or a password already exists. |
| GET/POST | `/settings/password` | Set or change your own password. Changing one requires the current password. |

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
- **A token is narrower than a session by design** — it cannot authenticate a
  human, impersonate, mint tokens, or change the household allow-list, whatever
  its scope. This is a deny-list, so new routes are *unreachable by tokens until
  proven safe*, not the reverse.
- **Everything a token does is logged and undoable** — attributed to the member,
  naming the token (F30.5), as an append-only event (R37).
- **Never send identity or credentials over the API.** Statement identity and
  Gmail tokens are not exportable and not returned by any endpoint.
