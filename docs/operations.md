# Running Pathayam

Pathayam runs as one container with one SQLite file, and needs no external
service.

## Requirements

- Node 24 or newer, or Docker.
- A public origin for Google sign-in. The intended topology is a tunnel
  (Cloudflare Tunnel or equivalent) in front of a machine on a home network.

## From source

```bash
npm install
npm run dev
```

`npm run dev` runs the TypeScript sources directly with type stripping and
restarts on change. Without `BASE_URL` the origin defaults to
`http://localhost:$PORT`.

```bash
npm run typecheck    # tsc --noEmit
npm test             # the whole suite
npm run build        # compile to dist/
npm start            # run dist/
```

### Demo data

```bash
DATA_DIR=./demo-data npm run demo
DATA_DIR=./demo-data DEMO_MODE=1 npm run dev
```

Generates 36 months of a household of four using the same simulation the test
suite runs ([testing.md](testing.md)). `DEMO_MODE` adds a member picker to the
sign-in page.

The seeder refuses to run against a database that already contains accounts.

The hosted demo at demo.pathayam.app bakes this seed into its image and copies
it back over the database on every boot, so it resets whenever it wakes from
idle. The deploy workflow also rebuilds it every Wednesday at 04:00 IST, so the
seed's dates stay current between releases.

## Docker Compose

[`compose.yaml`](../compose.yaml) is the intended deployment. Put the settings
in a `.env` beside it:

```bash
BASE_URL=https://budget.example.com
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SECRETS_KEY=...            # openssl rand -base64 32, once; keep it
HEARTBEAT_URL=https://hc-ping.com/...
```

```bash
docker compose up -d                  # production
docker compose --profile dev up       # development, with the login bypass
docker compose --profile seed up seed # a development household
docker compose --profile test up test # the suite and the typecheck
```

The production service binds to **loopback** (the tunnel reaches it, the LAN
does not), sets `TRUST_PROXY`, and mounts a named volume at `/data`. `BASE_URL`
is required and the stack refuses to come up without it.

The image builds in four stages: `deps`, `dev`, `build`, `runtime`. The
development login module exists in `dev` only. The `build` stage compiles, then
deletes both the compiled module and its source, then asserts the compiled file
is absent.

The container runs unprivileged, `/data` is the only writable path, and
`/healthz` doubles as the Docker health check.

Two variables are read by **compose**, not by the app: `PORT` chooses the host
port the production service publishes, and `DEV_PORT` does the same for the dev
profile (and sets its `BASE_URL`).

### Without compose

```bash
docker build -t pathayam .
docker run -d --name pathayam \
  -p 127.0.0.1:8080:8080 \
  -v pathayam-data:/data \
  -e BASE_URL=https://budget.example.com \
  -e GOOGLE_CLIENT_ID=... -e GOOGLE_CLIENT_SECRET=... \
  -e SECRETS_KEY="$(cat /path/to/secrets-key)" \
  -e TRUST_PROXY=true -e HEARTBEAT_URL=https://hc-ping.com/... \
  pathayam
```

### HTTPS without a proxy

Behind a Cloudflare Tunnel or a reverse proxy, HTTPS ends in front of the app
and none of this applies. A box that faces the internet directly can serve
HTTPS itself, with a Let's Encrypt certificate it gets and renews on its own:

```bash
BASE_URL=https://budget.example.com
TLS_ACME_DOMAIN=budget.example.com
CLOUDFLARE_API_TOKEN=...       # Cloudflare token: Zone · DNS · Edit, this zone only
ACME_EMAIL=you@example.com     # optional
```

In `compose.yaml`, uncomment the `443:8443` and `80:8080` lines and set
`TRUST_PROXY` to `"false"`. The app proves the domain with a `_acme-challenge`
TXT record made through the Cloudflare API (the domain's DNS has to be on
Cloudflare; port 80 is not used for it), keeps the account key and certificate
in `/data/acme` (0600), checks every 12 hours and renews when fewer than 30
days are left. A renewed certificate is used for new connections at once;
nothing restarts and no connection is dropped. If a renewal fails it keeps the
current certificate, logs `tls renewal failed` with the days left, and tries
again with backoff.

Until the first certificate arrives (usually under a minute), the plain port
serves the app as before. After that it answers `/healthz` (the container's
health check) and the mail receiver's signed hand-offs (`/inbound/email` and
`/inbound/check`, which it sends to `http://pathayam:8080`), and redirects
everything else to `BASE_URL`.

Checks: `docker compose logs pathayam` shows `https listening`;
`curl -sI http://budget.example.com/` answers `308` with `Location: https://…`;
`openssl s_client -connect budget.example.com:443 -servername budget.example.com -brief </dev/null`
shows `Verification: OK`. Try it first with `ACME_DIRECTORY=staging`, then
empty it.

### On Fly.io

Settings go in as Fly secrets, which the app reads as environment variables.
Set `SECRETS_KEY` once per app, before anyone saves Google keys, and never
rotate it casually:

```bash
fly secrets set SECRETS_KEY="$(openssl rand -base64 32)" -a <app>
fly secrets list -a <app>        # check: SECRETS_KEY is listed
```

Fly ends HTTPS at its edge, so `TLS_ACME_DOMAIN` stays unset there. The forwarding address's mail receiver is the exception: it gets its own certificate ([forwarding.md](forwarding.md#tls-for-the-receiver)).

Setting a secret restarts the app's machines once. To take it back,
`fly secrets unset SECRETS_KEY -a <app>`; stored Google secrets and sealed
refresh tokens then cannot be opened, so members re-enter their keys and
reconnect Gmail. No budget data depends on it. Each hosted instance gets its
own key. The public demo (`pathayam-demo`) has one too, though `DEMO_MODE`
refuses Gmail regardless.

## Signing in

Three ways, and you need at least one:

| | Set | Notes |
|---|---|---|
| Password | `LOCAL_LOGIN=1` | No external service. On a household with no members, `/auth/first-run` creates the first one and sets their password; it 404s from then on. Members added later get theirs through a [password link](#password-links). |
| Any OIDC provider | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Authelia, Authentik, Keycloak, Zitadel. One issuer URL; the endpoints are discovered from it. `OIDC_LABEL` names the button. |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Below. Also the deployment's own Gmail client when `FEATURE_GMAIL` is on. Not needed for Gmail when members bring their own keys (`FEATURE_GMAIL_BYO`). |

They can be on at once, and a member may have more than one. Passwords are scrypt
(`node:crypto`, no dependency added), stored in `member_passwords`, which is
in `NEVER_EXPORTED`, so a hash never travels in an export. Eight wrong guesses
locks that credential for fifteen minutes. The lock is per credential rather
than per IP, because a determined attacker can use more than one address.

`LOCAL_LOGIN` turning off does **not** disable a password that already exists.
Otherwise one environment variable would lock a household out of its own
ledger.

Change or set your own password at `/settings/password`. Changing an existing
one requires the current one, so a borrowed session is not a permanent
takeover, and signs out every other device the member is signed in on; the one
that made the change stays signed in.

### Password links

Somebody added to a household that signs in with passwords alone has no
password yet, and neither does somebody added back (removal clears it). On
Settings, beside each such member, **Make a password link** shows a one-time
link to send them: it opens signed out, lets them choose a password, and signs
them in. It works once and expires after 72 hours; making another replaces it.
The button is offered whenever password sign-in is (`LOCAL_LOGIN`, or any
password already set) and the member has none. With Google or OIDC on as well,
it gives them a second way in that does not depend on that service.

Two cases need whoever runs the server instead, and the button says so when it
refuses: a member who keeps private records (a private account, a personal
budget with anything in it, saved statement details, a connected mailbox, tax
figures), because whoever sets their password could read them; and a member
who has forgotten the password they have. Why is in
[security](security.md#password-links).

```bash
npm run password-link -- priya@example.com                     # dry run: who, and what would happen
npm run password-link -- priya@example.com --execute           # make the link and print it
npm run password-link -- priya@example.com --execute --reset   # forgotten password: clear it first
```

In the Docker image, `docker compose exec pathayam node dist/password-link.js
priya@example.com …` with the same flags.

It reads the same configuration as the app (`DATABASE_PATH` or `DATA_DIR`, and
`BASE_URL` for the link it prints) and can run while the app does. Without
`--execute` it changes nothing: it prints the member, whether they have a
password, their unused links, their sessions and what they keep privately, and
what it would do. With `--execute` it prints the same before and after, and the
link (once; only its hash is stored). For a member who has a password,
`--execute` alone is refused: `--reset` is what asks for that password to be
cleared, and it signs them out on every device too (their API tokens are left
alone; revoke those from their Settings if the password was compromised rather
than forgotten). Exit status: 0 done or dry run, 1 refused (no such member,
removed, a password without `--reset`), 2 a usage mistake.

## Single sign-on

Set `OIDC_ISSUER` to the provider's issuer URL. Everything else is read from
`{issuer}/.well-known/openid-configuration`, because pasting four endpoints into
environment variables makes a mistake more likely, and the resulting error
appears mid-redirect where it is hard to read. Register
`{BASE_URL}/auth/oidc/callback` as the redirect URI, and grant the `openid`,
`email` and `profile` scopes; members are matched by email address, so an
account with no email cannot sign in.

The ID token's issuer, audience and expiry are checked. Its **signature is
not**: the code is exchanged over TLS directly with the provider, so the
response came from it by construction, and verifying the signature would defend
only against somebody who can already MITM that connection. Because this is a
deliberate trade-off, it is documented here and in `auth/oidc.ts` rather than
left implicit.

## Google sign-in

1. Google Cloud console → APIs & Services → Credentials → OAuth 2.0 Client ID →
   **Web application**.
2. Authorised redirect URI: `https://your-origin/auth/google/callback`, exactly,
   including the scheme.
3. Put the client id and secret in the environment, and `BASE_URL` to match.

The first person to sign in becomes the household's first member. After that,
members are invited from Settings; an email that has not been invited is turned
away and the attempt is recorded.

Gmail ingestion is a **separate, later grant** with `gmail.readonly`, asked for
only when you turn it on and revocable from Settings.

### Gmail with your own Google keys

With `FEATURE_GMAIL_BYO` (on in every preset), a member pastes the client ID
and secret of a Google Cloud OAuth client they own into Settings → Gmail, for
themselves or for the whole household. A new connection uses, in order: the
member's own keys, the household's, then `GOOGLE_CLIENT_ID` when
`FEATURE_GMAIL` is on. A connection remembers which client issued its refresh
token and always renews under that one; if those keys are replaced or
removed, the fetch asks the member to reconnect.

The secret is sealed with AES-256-GCM under `SECRETS_KEY` and stored in
`gmail_clients`, which is in `NEVER_EXPORTED`. With `SECRETS_KEY` set, Gmail
refresh tokens are sealed too; a token stored before the key was set stays
readable and is sealed on the next connect. Without `SECRETS_KEY`, the
Settings form is replaced by a sentence asking the operator to set one, and
nothing is stored. Changing the key makes every sealed secret unreadable: the
household re-enters its keys and reconnects, and no budget data is affected.

The client needs `${BASE_URL}` as an authorised JavaScript origin and
`${BASE_URL}/gmail/callback` as an authorised redirect URI (Settings shows
both). Its consent screen must be **In production**; while it says *Testing*,
Google expires refresh tokens after seven days. The member-facing steps are
in the guide: <https://pathayam.app/guides.html#gmail-keys>.

## Configuration

Everything the app reads, and nothing it does not:

| Variable | Default | Notes |
|---|---|---|
| `BASE_URL` | `http://localhost:$PORT` | The public origin, exactly. OAuth redirects, cookie scoping and the same-origin write check all depend on it. A write addressed to any other hostname (or this hostname on another port) is refused with 403 (only an IP address or `localhost` is accepted besides), so a reverse proxy must pass the original `Host` through, or set `X-Forwarded-Host` with `TRUST_PROXY`. |
| `GOOGLE_CLIENT_ID` | None | Required for Google sign-in. |
| `GOOGLE_CLIENT_SECRET` | None | |
| `SECRETS_KEY` | None | Seals stored credentials: a member's or the household's own Google client secret, and Gmail refresh tokens. At least 32 characters (`openssl rand -base64 32`); shorter refuses to start. Keep it outside the data volume (a Fly secret). Unset, own Google keys cannot be saved. |
| `INBOUND_DOMAIN` | None | The forwarding address's domain, for example `in.example.com`: what the mail receiver answers for. A value that is not a mail domain stops startup. See [forwarding.md](forwarding.md). |
| `INBOUND_ROUTE` | None | This household's prefix on a receiver shared by several (`hh1` makes `hh1.<token>@…`). Empty when the receiver serves this instance alone. Letters and digits, at most 32. |
| `INBOUND_SECRET` | None | Signs each hand-off from the receiver; the receiver's `MX_ROUTES` entry carries the same value. At least 32 characters (`openssl rand -base64 32`). Without it and `INBOUND_DOMAIN`, Settings says forwarding is not set up. |
| `PORT` | `8080` | |
| `TLS_ACME_DOMAIN` | None | Serve HTTPS with a Let's Encrypt certificate for this name, got and renewed by the app ([HTTPS without a proxy](#https-without-a-proxy)). Off unless set; `BASE_URL` must then be `https://`. |
| `HTTPS_PORT` | `443` | Where HTTPS listens when `TLS_ACME_DOMAIN` is set. Compose uses `8443` and publishes it as 443, because the container runs unprivileged. |
| `CLOUDFLARE_API_TOKEN` | None | Required with `TLS_ACME_DOMAIN` (and the mail receiver's `MX_TLS_ACME_DOMAIN`): a Cloudflare API token with *Zone · DNS · Edit* for the zone. A Fly secret or `.env`, never committed. |
| `CLOUDFLARE_ZONE_ID` | found by name | |
| `ACME_EMAIL` | None | Where Let's Encrypt writes about the certificate. |
| `ACME_DIRECTORY` | `production` | `production`, `staging` (untrusted certificates, for a first try) or an ACME directory URL. |
| `ACME_DIR` | `$DATA_DIR/acme` | The ACME account key and the certificates, each file 0600. |
| `HOST` | `0.0.0.0` | |
| `DATA_DIR` | `./data` | Where the database, backups and attachments live. |
| `DATABASE_PATH` | `$DATA_DIR/pathayam.sqlite` | |
| `BACKUP_DIR` | `$DATA_DIR/backups` | |
| `ATTACHMENT_DIR` | `$DATA_DIR/attachments` | |
| `SESSION_DAYS` | `30` | How long a session lasts from sign-in (absolute, not extended by use). 1 to 3650; anything else stops startup. |
| `LOG_LEVEL` | `info` in production | `debug`, `info`, `warn` or `error` (any case); anything else refuses to start. No financial value is ever logged. |
| `TRUST_PROXY` | `false` | Read the client IP and forwarded host from proxy headers. Set it behind a tunnel. The IP is the right-most `X-Forwarded-For` entry, so exactly one proxy hop is assumed (see security.md). |
| `HEARTBEAT_URL` | None | **Set this.** Pinged on a *successful* verified restore. |
| `BACKUP_WEBHOOK_URL` | None | Alerted when a backup or its verification fails. |
| `ALPHA_VANTAGE_KEY` | None | Only for direct equities; mutual funds use a keyless provider. |
| `PLAN`, `FEATURE_*`, `MAX_MEMBERS`, `BACKUP_RETENTION_DAYS` | `selfhost` | Which modules this instance offers and its limits. See [Plans and modules](#plans-and-modules). |
| `AI_WRITE` | `off` | Whether an AI connection may change anything: `off`, `standard` or `full` (any case); anything else stops startup. See [Letting an AI make changes](#letting-an-ai-make-changes). |
| `MCP_ALLOWED_ORIGINS` | None | Comma-separated browser origins, besides `BASE_URL`'s, allowed to call `/mcp`. Connectors call from their servers and need none (ai.md). |
| `ADMIN_DEBUG` | `false` | Enables view-as-another-member, read-only by default, bannered. |
| `DEMO_MODE` | `false` | Bypasses authentication. Refuses to start alongside `DEV_LOGIN`, Google or OIDC credentials, or `LOCAL_LOGIN`, and against a database with passwords, linked Google accounts, a connected mailbox or a statement identity. |
| `DEV_LOGIN` | `false` | Local auth bypass. Absent from the production image; the app refuses to start with it in a production-shaped environment (production `NODE_ENV`, a public `BASE_URL`, Google or OIDC credentials, `LOCAL_LOGIN`). |

A disabled feature module **keeps its data**. Re-enabling restores it intact.

## Plans and modules

`PLAN` picks a preset. Each variable below that is set wins over the preset,
so `PLAN=solo` with `FEATURE_LOANS=true` is Solo with loans. Leave `PLAN`
unset and an instance is self-hosted: every module on except multi-currency,
and no limits. That is how every install before plans existed behaves, and
how the public demo runs.

A value the app cannot read stops it at startup with a message naming the
variable. That covers `PLAN=family`, `FEATURE_LOANS=flase` and
`MAX_MEMBERS=five`. A misspelt flag must not quietly switch a paid module on
or off. Flags take `true`/`false`, `1`/`0`, `yes`/`no` or `on`/`off`, in
any case.

### Limits

| Variable | selfhost | solo | household | power | Notes |
|---|---|---|---|---|---|
| `MAX_MEMBERS` | unlimited | 1 | 5 | unlimited | A whole number from 1 to 1000, or `unlimited` (or `0`). Adding a member, or adding back a removed one, is refused at the limit, and Settings shows no form to try. A household already over the limit, because its plan changed under it, keeps everyone and can only not add. |
| `BACKUP_RETENTION_DAYS` | 14 newest | 30 | 90 | 365 | Days, 1 to 3650, or `unlimited` (no age limit: the newest of each day is kept for good). Every backup from the last two days is kept, then the newest of each IST day back to the limit. The newest backup is never removed, however old. Unset on selfhost, the newest 14 backups are kept whatever their age (3.5 days at the six-hourly cadence). |

### Modules

| Variable | selfhost | solo | household | power | What switching it off removes |
|---|---|---|---|---|---|
| `FEATURE_LOANS` | on | off | on | on | `/loans`, the prepayment calculator, converting a card purchase to EMI, loan interest on Reports, the MCP `loans` and `loan_schedule` tools. |
| `FEATURE_FAMILY_LOANS` | on | off | on | on | `/family`, lending within the family. |
| `FEATURE_ASSETS` | on | off | on | on | `/portfolio` (CAS and SafeGold imports, valuations, allocation), `/net-worth`, `/fire`, the net-worth tile on Overview, price refreshes (no outbound calls at all), and the MCP `portfolio`, `realised_gains`, `net_worth` and `financial_independence` tools. |
| `FEATURE_DEPOSITS` | on | on | on | on | Deposit terms on accounts (`/accounts/:id/deposit`), maturities on Overview. A deposit is then worth its balance. |
| `FEATURE_INSURANCE` | on | on | on | on | `/insurance`, renewals on Overview, the 80C/80D suggestion on Tax, the MCP `insurance` tool. |
| `FEATURE_GOALS` | on | on | on | on | `/goals`, the MCP `goals` tool. |
| `FEATURE_TAX` | on | on | on | on | `/tax`, the MCP `tax_estimate` tool. |
| `FEATURE_REPORTS` | on | on | on | on | `/reports`, `/query` and `/query.csv`. Search stays, at `/search`, without the CSV. |
| `FEATURE_SCHEDULES` | on | on | on | on | `/schedules`, "Will you make it?" and schedules due on Overview, the MCP `cashflow` tool. |
| `FEATURE_RULES` | on | on | on | on | `/rules` and the rule suggestions on Review. Rules already saved still categorise imports. |
| `FEATURE_ATTACHMENTS` | on | on | on | on | Receipts on a transaction. |
| `FEATURE_IMPORT_CSV` | on | on | on | on | Bank CSV import. |
| `FEATURE_IMPORT_PDF` | on | on | on | on | Statement PDF upload. |
| `FEATURE_IMPORT_BUDGET_APP` | on | on | on | on | YNAB and Actual Budget exports. `/import` itself goes only when all three import flags are off. |
| `FEATURE_GMAIL` | on | off | off | off | Connecting a mailbox with the deployment's own Google client (`GOOGLE_CLIENT_ID`). The hosted service never asks Google for mailbox access under its own name (privacy.html). |
| `FEATURE_GMAIL_BYO` | on | on | on | on | Connecting a mailbox with a Google client the member or household brings (Settings → Gmail, needs `SECRETS_KEY`). With `FEATURE_GMAIL` also off, `/gmail/*` and the card-digit prompts go. |
| `FEATURE_API_TOKENS` | on | off | on | on | `/tokens`. A token minted earlier gets 403 everywhere except `/mcp`, and works again when the flag comes back on. |
| `FEATURE_AI` | on | off | on | on | AI connections: `/mcp`, signing in from an AI app (`/oauth/*`, the `.well-known` metadata), Connect an AI (`/tokens/ai`) and `/export/analysis.json`. Existing connections stop answering. `/export.json` stays. |
| `FEATURE_FORWARDING` | on | off | off | off | The forwarding address (Settings → Forwarding address) and the receiver's hand-off, `/inbound/email`. A paid add-on on every hosted tier: set it to `true` for a household that bought it. Needs `INBOUND_*` and a receiver ([forwarding.md](forwarding.md)). |
| `FEATURE_MULTI_CURRENCY` | off | off | off | off | Q18 settled on ₹-only accounts. |

A module that is off **disappears**, as F28.2 requires. Its pages answer 404,
and nothing on any page links to them: the nav, the More page, the command
palette, dashboards and forms are all covered. Its data stays in the database,
untouched, and comes back when the flag does. The budget, accounts, cards,
transactions, Review, month close, reconciliation, search, the export, Health
and Settings are never gated.

Every combination is tested by walking the whole app with a simulated
three-year household that used every module (`src/web/plan-*.test.ts`). The
walks cover each preset, every module on, every module off, each flag off on
its own, and a pairwise covering array, so every pair of flags is walked in all
four on/off states. A walk fails on any 500, any page of a module that is off
answering anything but 404, any link or form pointing at a page that is off,
and any MCP tool listed for a module that is off.

### Letting an AI make changes

`AI_WRITE` is not a module and no preset sets it: every plan is read-only for
AI connections until an operator sets it on its own. It matters only with
`FEATURE_AI` on; with AI connections off everything under them is a 404
anyway.

| `AI_WRITE` | What a connection the member allowed to make changes may do |
|---|---|
| `off` (default) | Nothing. Every connection is read-only, the change tools are not listed, and the consent page and Connect an AI offer no "allow changes" box. |
| `standard` | File, split and write memos on transactions, and propose a payee's usual envelope (a rule waiting in Review). Adding a transaction, assigning money and recording a transfer leave a suggestion in Review that the member approves or rejects. |
| `full` | The same, and adding a transaction, assigning money and recording a transfer are made directly. |

A member still has to tick "allow changes" for each connection; without it a
connection is read-only whatever `AI_WRITE` says. Turning `AI_WRITE` back to
`off` makes every connection read-only at once (an app that signed in gets a
read-only token at its next hourly refresh; until then the tools are not
offered). Nothing is deleted. What a connection may and may not change, the
caps, and undoing are in [ai.md](ai.md#changes-an-ai-can-make).

## Backups, and being able to restore

The whole dataset is one SQLite file in an open format the `sqlite3` CLI reads
without this application. Copy it out whenever you like.

The scheduled job performs a restore **verification**: it restores the most
recent backup into a scratch database, opened read-only so the live database
cannot be affected, and compares record counts and magnitude totals across every
durable table. `src/ops/coverage.test.ts` asserts that every durable table is
included in that comparison.

- The result appears on the **health page**, which can also take a backup or
  run a verification on demand. A manual backup prunes to the same 14 the job
  keeps. On the demo (`DEMO_MODE`) both buttons are refused: every visitor is
  signed in, and each is a full-database copy on a disk the reset never clears.
- A failure fires `BACKUP_WEBHOOK_URL`.
- A success pings `HEARTBEAT_URL`. Every other alert originates from the
  deployment, so a deployment that is down cannot raise one. Point
  `HEARTBEAT_URL` at a dead-man's-switch service that alerts on the ping's
  absence, with an expected interval of the schedule plus slack.

### Restoring

Stop the app, then:

```bash
docker compose exec pathayam node dist/restore.js --list
docker compose exec pathayam node dist/restore.js --latest
```

It keeps the database it replaced as `pathayam.sqlite.replaced-<timestamp>`,
reads the restored copy back, and prints the control totals. After a crash the
last writes live only in the `-wal`; with `--force` that journal moves with the
kept copy and is folded into it, so the `.replaced` file holds everything up to
the crash. If the fold fails it says so, and the kept `-wal`/`-shm` stay beside
it. Keep the three together.

> **Do not copy a backup over the database file directly.** SQLite maintains
> `-wal` and `-shm` sidecar files, which persist after a crash. Replacing the
> database while they remain produces `database disk image is malformed` on the
> next query. `restore.ts` moves them aside with the replaced copy, in the correct order.

## Updating

```bash
git pull
docker compose build pathayam
docker compose up -d pathayam
```

Migrations run at startup, in order, inside transactions, each applied once.
There is no manual migration step. The app **refuses to start** against a
database written by a newer build rather than guessing at a schema it does not
know.

## Health

`/health` reports the last backup and its verification, the schema version,
whether the development bypass is absent, stale price and valuation inputs, and
the state of any Gmail grant. `/healthz` is the container's health check: signed
out it answers only `{status, serving, version}`: 200 while the database
answers, 503 when it does not, never failed by anything recorded in the past.
With a session or an API token it adds every check, the machine-readable
version of `/health`.
