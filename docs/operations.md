# Running it

One container, one SQLite file, and no external service required at all.

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

## Docker Compose

[`compose.yaml`](../compose.yaml) is the intended deployment. Put the settings
in a `.env` beside it:

```bash
BASE_URL=https://budget.example.com
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
HEARTBEAT_URL=https://hc-ping.com/...
```

```bash
docker compose up -d                  # production
docker compose --profile dev up       # development, with the login bypass
docker compose --profile seed up seed # a development household
docker compose --profile test up test # the suite and the typecheck
```

The production service binds to **loopback** — the tunnel reaches it, the LAN
does not — sets `TRUST_PROXY`, and mounts a named volume at `/data`. `BASE_URL`
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
  -e TRUST_PROXY=true -e HEARTBEAT_URL=https://hc-ping.com/... \
  pathayam
```

## Signing in

Two ways, and you need at least one:

| | Set | Notes |
|---|---|---|
| Password | `LOCAL_LOGIN=1` | No external service. On a household with no members, `/auth/first-run` creates the first one and sets their password; it 404s from then on. |
| Any OIDC provider | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Authelia, Authentik, Keycloak, Zitadel. One issuer URL; the endpoints are discovered from it. `OIDC_LABEL` names the button. |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Below. Needed for Gmail import whether or not it is used for sign-in. |

Both can be on at once, and a member may have both. Passwords are scrypt
(`node:crypto`, no dependency added), stored in `member_passwords` — which is
in `NEVER_EXPORTED`, so a hash never travels in an export. Eight wrong guesses
locks that credential for fifteen minutes; the lock is per credential rather
than per IP, because the attacker worth stopping has more than one address.

`LOCAL_LOGIN` turning off does **not** disable a password that already exists.
Otherwise one environment variable would lock a household out of its own
ledger.

Change or set your own password at `/settings/password`. Changing an existing
one requires the current one, so a borrowed session is not a permanent
takeover.

## Single sign-on

Set `OIDC_ISSUER` to the provider's issuer URL — everything else is read from
`{issuer}/.well-known/openid-configuration`, because four endpoints pasted into
environment variables is four chances to paste one wrong, and the resulting
error arrives mid-redirect where nobody can read it. Register
`{BASE_URL}/auth/oidc/callback` as the redirect URI, and grant the `openid`,
`email` and `profile` scopes; members are matched by email address, so an
account with no email cannot sign in.

The ID token's issuer, audience and expiry are checked. Its **signature is
not** — the code is exchanged over TLS directly with the provider, so the
response came from it by construction, and verifying the signature would defend
only against somebody who can already MITM that connection. That is a decision
worth disagreeing with, which is why it is written here and in `auth/oidc.ts`
rather than left implicit.

## Google sign-in

1. Google Cloud console → APIs & Services → Credentials → OAuth 2.0 Client ID →
   **Web application**.
2. Authorised redirect URI: `https://your-origin/auth/google/callback` — exactly,
   including the scheme.
3. Put the client id and secret in the environment, and `BASE_URL` to match.

The first person to sign in becomes the household's first member. After that,
members are invited from Settings; an email that has not been invited is turned
away and the attempt is recorded.

Gmail ingestion is a **separate, later grant** with `gmail.readonly`, asked for
only when you turn it on and revocable from Settings.

## Configuration

Everything the app reads, and nothing it does not:

| Variable | Default | Notes |
|---|---|---|
| `BASE_URL` | `http://localhost:$PORT` | The public origin, exactly. OAuth redirects, cookie scoping and the same-origin write check all depend on it. |
| `GOOGLE_CLIENT_ID` | — | Required for Google sign-in. |
| `GOOGLE_CLIENT_SECRET` | — | |
| `PORT` | `8080` | |
| `HOST` | `0.0.0.0` | |
| `DATA_DIR` | `./data` | Where the database, backups and attachments live. |
| `DATABASE_PATH` | `$DATA_DIR/pathayam.sqlite` | |
| `BACKUP_DIR` | `$DATA_DIR/backups` | |
| `ATTACHMENT_DIR` | `$DATA_DIR/attachments` | |
| `SESSION_DAYS` | `30` | Session idle timeout. |
| `LOG_LEVEL` | `info` in production | No financial value is ever logged. |
| `TRUST_PROXY` | `false` | Read the client IP and forwarded host from proxy headers. Set it behind a tunnel. The IP is the right-most `X-Forwarded-For` entry, so exactly one proxy hop is assumed (see security.md). |
| `HEARTBEAT_URL` | — | **Set this.** Pinged on a *successful* verified restore. |
| `BACKUP_WEBHOOK_URL` | — | Alerted when a backup or its verification fails. |
| `ALPHA_VANTAGE_KEY` | — | Only for direct equities; mutual funds use a keyless provider. |
| `FEATURE_LOANS` | `true` | |
| `FEATURE_ASSETS` | `true` | |
| `FEATURE_MULTI_CURRENCY` | `false` | |
| `ADMIN_DEBUG` | `false` | Enables view-as-another-member, read-only by default, bannered. |
| `DEMO_MODE` | `false` | Bypasses authentication. Refuses to start alongside `DEV_LOGIN`, and checks the deployment does not look like production. |
| `DEV_LOGIN` | `false` | Local auth bypass. Absent from the production image; the app refuses to start with it in a production-shaped environment. |

A disabled feature module **keeps its data**. Re-enabling restores it intact.

## Backups, and being able to restore

The whole dataset is one SQLite file in an open format the `sqlite3` CLI reads
without this application. Copy it out whenever you like.

The scheduled job performs a restore **verification**: it restores the most
recent backup into a scratch database, opened read-only so the live database
cannot be affected, and compares record counts and magnitude totals across every
durable table. `src/ops/coverage.test.ts` asserts that every durable table is
included in that comparison.

- The result appears on the **health page**.
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
reads the restored copy back, and prints the control totals.

> **Do not copy a backup over the database file directly.** SQLite maintains
> `-wal` and `-shm` sidecar files, which persist after a crash. Replacing the
> database while they remain produces `database disk image is malformed` on the
> next query. `restore.ts` removes them in the correct order.

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
the state of any Gmail grant. `/healthz` is the machine-readable version and the
container's health check.
