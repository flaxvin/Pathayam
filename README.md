# Budget

A strict envelope (zero-based) budgeting app for one Indian household.
Self-hosted, server-rendered, installable as a PWA.

The design is in [`docs/`](docs/00-README.md). This file covers running it.

---

## Status

**P0 in progress.** The engine, the platform floor and the budget screen work
end to end; import, review and reconciliation are not built yet. See
[What is and isn't built](#what-is-and-isnt-built).

---

## Running it

Needs **Node 24 or newer** — the app uses the built-in `node:sqlite`, so there
is no native module to compile and no runtime dependency to install.

```bash
npm install
```

### Development

```bash
npm run seed
```

That creates a household with two members, four accounts (including an add-on
card), the Indian starting template, and a month of transactions that
deliberately includes a cash overspend, a credit overspend and a card payment —
so the screens show real behaviour rather than an empty grid.

```bash
DEV_LOGIN=true npm run dev
```

Then open <http://localhost:8080> and sign in as Ravi or Priya.

`DEV_LOGIN` bypasses authentication completely. The app **refuses to start**
if it is set alongside anything production-shaped — `NODE_ENV=production`, a
public hostname, real Google OAuth credentials, or a database holding more
than a seed dataset (R38.3). A LAN address counts as development, so a homelab
machine can still use it.

### Tests

```bash
npm test
```

The engine suite encodes the worked ₹ examples from `02` §4 and asserts the
accounting identity from
[`docs/dev/01-engine-derivation.md`](docs/dev/01-engine-derivation.md) after
every scenario. If a change breaks that identity, the change is wrong.

```bash
npm run typecheck
```

---

## Deploying

```bash
docker compose up -d
```

Set these first:

| Variable | Required | Notes |
|---|---|---|
| `BASE_URL` | yes | The public origin, exactly. OAuth redirects and cookie scoping depend on it. |
| `GOOGLE_CLIENT_ID` | yes | From the Google Cloud console. |
| `GOOGLE_CLIENT_SECRET` | yes | |
| `TRUST_PROXY` | behind a proxy | So the client IP is read from `X-Forwarded-For`. |
| `SESSION_DAYS` | no | Default 30 (Q22). |
| `BACKUP_WEBHOOK_URL` | recommended | Where a failed backup or restore verification reports (R40.4). |
| `FEATURE_LOANS`, `FEATURE_ASSETS`, `FEATURE_MULTI_CURRENCY` | no | Per-deployment module flags (F28). Multi-currency is off by default (Q18). |

`DEV_LOGIN` is not listed because the bypass is **deleted from the production
image** rather than merely disabled in it (R38.5).

### Google OAuth setup

1. Create an OAuth 2.0 Client ID of type *Web application*.
2. Add `${BASE_URL}/auth/google/callback` as an authorised redirect URI.
3. The first person to sign in on a fresh instance becomes a member (F1.3) and
   can add the rest from Settings. Everyone else must be on the allow-list
   first — there is no self-service signup.

All members are peers. There is no owner, no viewer, and no approval step
(P5).

### Backup

The whole dataset is one SQLite file in the data volume, in an open format
readable by the `sqlite3` CLI without this application (R40.7):

```bash
docker compose exec budget sh -c 'sqlite3 /data/budget.sqlite ".backup /data/backup.sqlite"'
```

**Taking a backup is not the same as being able to recover.** R40.2 wants a
scheduled restore *verification* — a restore into a scratch database with
record counts and control totals compared. That job is not built yet, and until
it is, run a restore by hand before this holds a month of real data.

---

## How it is put together

Zero runtime dependencies. Node's standard library covers everything the app
needs, which keeps the CSP in R35.4 honest and the attack surface small.

```
src/
  core/       money (integer paise), dates (IST civil dates),
              the event log (R37), idempotency (R36)
  db/         schema, migrations, typed query helpers
  engine/     R1–R13 as pure functions, plus the SQL that feeds them
  domain/     mutations — accounts, categories, transactions, payees
  auth/       Google SSO, sessions, impersonation, the dev bypass
  http/       server, router, escaping-by-default HTML
  web/        page shell, tokens, client script, screens
```

Three constraints shaped most of it:

**The server is the only place data lives** (R35). No `localStorage`, no
`IndexedDB`, no service worker, no read cache. The client is a manifest, static
assets, a session cookie and in-memory view state. This is also why rendering
is server-side: R39.3 needs the resolved theme in the first response so the
wrong theme never paints.

**Every mutation is an event, and every write carries an idempotency key**
(R36, R37). Both were built before any feature used them, because `05` §3 is
right that retrofitting either means rewriting every mutation path. The log
pays for undo, "explain this number", and as-of-date views with one mechanism
instead of three.

**The engine is pure and tested against worked examples.** `05` §7 names the
worst risk in the project as engine semantics going subtly wrong and surfacing
in month four, costing a rewrite of every stored figure. The mitigation is the
test suite in `src/engine/engine.test.ts`, written before any UI.

Both overspend models ship, neither is a stub (Q1). A test asserts the
household ends up equally well off under each — only the term absorbing the
negative differs, which is what makes shipping both cheap.

---

## What is and isn't built

### Working

- The budgeting engine, R1–R13, including both overspend models, credit-card
  payment envelopes, add-on cards, targets, auto-assign with preview, move
  money with ranked suggestions, hold-for-next-month, and the Buffer metric
- The event log with universal undo, and "explain this number" on category
  balances and Ready to Assign
- Idempotent writes with bounded client retry and three unambiguous outcomes
- Google SSO, the allow-list enforced on every request, sessions with
  per-device revocation, read-only impersonation, the gated dev bypass
- Accounts across all three kinds, cards and add-on cards, the register
- Transactions with splits, transfers, tags, owners, soft delete; payees with
  raw-string retention and merge
- The budget screen, theme, PWA manifest, command palette, Docker packaging
- The India-appropriate starting template

### Not built yet

| Gap | Where it is specified |
|---|---|
| CSV/XLSX import, mapping profiles, dedupe tiers, the review queue | `04` §3.2, §4; F13 |
| The rules engine — three stages, retroactive apply, test-before-save | `04` §6; F6 |
| Reconciliation, and the Q5 checkpoint-breakage rule | F9; `09` §5 |
| Backup job and **verified restore** with control totals | `08` R40 |
| The health page | `08` F27 |
| Complete export and re-import | F15 |
| Reports, query screen, schedules, goals, search | F7, F10, F11, F16 |
| Loans, assets, net worth, multi-currency | `06`, `07` — all P2 |

`05` §2 is explicit that **P0 is not done until all of it is done**: a full
month budgeted, spent, imported, reconciled and rolled over without a
spreadsheet, *and* a verified restore with matching control totals. Import and
reconciliation are the two that remain on that critical path.

A known wart is recorded rather than hidden: viewing a *past* month subtracts
assignments made in months since, so a July view in December can read lower
than July ever did. That follows `02` R2 literally; the reasoning and its
containment are in
[`docs/dev/01-engine-derivation.md`](docs/dev/01-engine-derivation.md) §4.
