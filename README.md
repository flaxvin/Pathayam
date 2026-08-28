# Budget

A strict envelope (zero-based) budgeting app for one Indian household.
Self-hosted, server-rendered, installable as a PWA.

The design is in [`docs/`](docs/00-README.md). This file covers running it.

---

## Status

**P0 complete, P1 complete, P2 substantially complete.** A full month can be
budgeted, spent, imported, reconciled and rolled over without a spreadsheet,
and a restore has been verified with matching control totals — the two-part bar
`05` §2 sets. Loans, the cashflow calendar, goals, and the assets / net worth /
multi-currency module are all built.

The corrections and additions in
[`docs/10-errata-and-addenda.md`](docs/10-errata-and-addenda.md) are adopted,
including R7.g's forward recompute and R40.8's dead-man's switch. `E12` in that
document was found by `verify_docs.py`, which is in this repo.

---

## Running it

Everything runs through Docker Compose. Node is not needed on the host.

```bash
cp .env.example .env
```

Fill in `BASE_URL` and the two Google OAuth values — Compose refuses to start
without them rather than booting something half-configured.

### Production

```bash
docker compose up -d
```

Serves on `127.0.0.1:8080` by default, so a tunnel or reverse proxy reaches it
and the LAN does not. `docker compose logs -f budget` for structured logs,
`docker compose ps` for health.

### Development

```bash
docker compose --profile seed up seed
docker compose --profile dev up
```

The seed creates a household with two members, four accounts (including an
add-on card), the Indian starting template, and a month of transactions that
deliberately includes a cash overspend, a credit overspend and a card payment
— so the screens show real behaviour rather than an empty grid.

Then open <http://localhost:8080> and sign in as Ravi or Priya. The source is
mounted, so an edit restarts the server without a rebuild.

The dev profile sets `DEV_LOGIN`, which **bypasses authentication completely**.
The app refuses to start if it is set alongside anything production-shaped —
`NODE_ENV=production`, a public hostname, real Google OAuth credentials, or a
database holding more than a seed dataset (R38.3). A LAN address counts as
development, so a homelab machine can still use it.

The two profiles build from different Docker stages. The bypass exists only in
the `dev` stage; the production image is built without it and a build-time
assertion fails if it survives (R38.5).

### Tests

```bash
docker compose --profile test up test
```

Runs the suite and the typecheck. The engine tests encode the worked ₹ examples
from `02` §4 and assert the accounting identity from
[`docs/dev/01-engine-derivation.md`](docs/dev/01-engine-derivation.md) after
every scenario. If a change breaks that identity, the change is wrong.

Also checks the docs for stale normative lines (`10` §3.4):

```bash
python3 docs/verify_docs.py
```

### Without Docker

`npm install && npm test` works if you have Node 24+, and `npm run dev` will
start a server — but Compose is the supported path and the only one the
production image is built from.

---

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `BASE_URL` | yes | The public origin, exactly. OAuth redirects and cookie scoping depend on it. |
| `GOOGLE_CLIENT_ID` | yes | From the Google Cloud console. |
| `GOOGLE_CLIENT_SECRET` | yes | |
| `PORT` | no | Host port for the production service. Default 8080. |
| `SESSION_DAYS` | no | Default 30 (Q22). |
| `BACKUP_WEBHOOK_URL` | recommended | Where a failed backup or restore verification reports (R40.4). |
| `HEARTBEAT_URL` | **recommended** | Pinged on a *successful* verified restore. See [Backup](#backup) — this is the only thing that can tell you the box is down (R40.8). |
| `FEATURE_LOANS`, `FEATURE_ASSETS`, `FEATURE_MULTI_CURRENCY` | no | Per-deployment module flags (F28). Multi-currency is off by default (Q18). |

`DEV_LOGIN` is not listed because the bypass is **not in the production image
at all** (R38.5).

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
readable by the `sqlite3` CLI without this application (R40.7). Backups are
written by the scheduled job, and can be taken by hand from the health page or
copied out with:

```bash
docker compose cp budget:/data/budget.sqlite ./budget-backup.sqlite
```

**Taking a backup is not the same as being able to recover**, so the scheduled
job is a restore *verification* (R40.2): it restores the most recent backup
into a scratch database and compares record counts and control totals. The
result appears on the health page — *"14 entities, all control totals
matched"* — and a failure fires the webhook rather than only a log line
(R40.4), because that is the one failure class where silence loses data.

The scratch handle is opened read-only, so verification cannot touch the live
database even by mistake (R40.5). Both can also be run by hand from the health
page.

**Set `HEARTBEAT_URL`.** R40.4's webhook fires *from this deployment*, so in
the worst failure — box down, tunnel down, job never ran — there is no process
left to send it, and the one failure that must never be silent is silent
exactly when it matters. `HEARTBEAT_URL` is pinged only on a **successful**
verified restore, at a monitor that alerts on the ping's *absence* (R40.8).
Point it at any dead-man's-switch service and set the expected interval to the
verification schedule plus slack, so one slow run does not page anyone.

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
test suite in `src/engine/engine.test.ts`, written before any UI. The same
pattern is repeated for loans and for the portfolio: the maths is pure, has no
database, and is pinned against the worked figures in `06` §12 and `07` §10
before any screen exists.

Both overspend models ship, neither is a stub (Q1). A test asserts the
household ends up equally well off under each — only the term absorbing the
negative differs, which is what makes shipping both cheap.

---

## What is and isn't built

### Working

**The engine** — R1–R13, both overspend models, credit-card payment envelopes,
add-on cards, targets, auto-assign with preview, move money with ranked
suggestions, hold-for-next-month, Buffer, and R7.g's forward recompute.

**The platform floor** — the append-only event log with universal undo and
"explain this number"; idempotent writes with bounded client retry; Google SSO
with the allow-list enforced on every request; sessions with per-device
revocation; read-only impersonation; the gated dev bypass.

**Money in** — accounts across all three kinds, cards and add-on cards, the
register, transactions with splits/transfers/tags/owners and soft delete,
payees with raw-string retention and merge; receipt attachments stored in the database (Q10), served server-only with no-store so no device caches one. CSV import with header detection,
Indian amount formats, UPI narration extraction, all five dedupe tiers, the
review queue, the three-stage rules engine with test-before-save, the
auto-approve gate, and batch undo. **Statement PDFs**, read in-process, for
HDFC, ICICI, Axis, SBI, Union Bank, Canara, YES Bank, IndusInd, Kotak, RBL,
HSBC and broker contract notes — refined against 81 real statements from 13
institutions, of which 58 open and 1,856 transactions parse. The sign of every transaction comes from the **running
balance**, not from which column a figure appears under — real statements
right-align to a ragged edge, so debit and credit columns overlap and position
inverts roughly half the rows while looking healthy. The parse is then checked
against the statement's own closing balance: on a real 848-row Axis statement it
reconciles to the paisa, and every one of the twelve files that prints both an
opening and a closing balance reconciles exactly. Optionally, the app can work out statement passwords
from your saved name, date of birth and PAN, so nobody has to type one —
opt-in, never exported, never logged, and the settings screen says plainly what
it costs. A file the app
cannot read is a mapping
task, not an error: the columns are named against the raw rows, the mapping is
saved per bank, and the next file with that header signature imports without
asking. Rules are proposed from what you actually do — the second time you
categorise a payee, or when you clean up an imported name — and every proposal
states the inference it came from and waits in Review. A confirmed rule can be
applied to history, with the count and a preview first. **Gmail ingestion** is a
separate opt-in grant — read-only, offline, the refresh token stored like the
statement identity — that reads only the banks' own addresses: a transaction
alert becomes a review-queue row within seconds of a spend, and a statement PDF
is fetched, decrypted and parsed on arrival. An add-on card's alert, which lands
in the primary holder's inbox, is routed to the right account and defaults its
owner to the add-on holder.

**The monthly moment** — `08` S5's close ritual: what the month did, R29.4's
four-way net worth decomposition rather than one flattering number, a dated
snapshot, and the only question that matters next — whether the new month is
funded. It locks nothing; every past month stays editable. The F14 digest is
in-app only, per member, and says nothing that exists to bring you back.

**Scripting it** — personal API tokens, scoped read or read-write, shown once
and stored only as a hash, rate-limited separately from your session, and
structurally unable to sign in, impersonate, mint more tokens, or change who is
allowed in.

**Making sure it's right** — reconciliation with locked checkpoints and the Q5
breakage rule; backup, verified restore, the heartbeat and the health page;
complete JSON export and transaction CSV.

**Understanding it** — reports, the one query screen everything drills into,
search across raw imported strings, schedules with detection, the cashflow
calendar, and goals.

**Lending in the family** — money lent to or borrowed from people rather than
institutions, with no interest engine and no schedule, because those
arrangements do not have them. The balance is derived from what actually moved,
lending is not spending, repayment is not income, and a write-off is available
because an app that cannot express one forces you to lie or delete history.

**Debt** — loans with the full amortisation engine, all four interest models,
per-tranche disbursement destinations, instalment recording with the lender's
split, drift against a lender statement, and the prepayment comparison that
`06` §1 says the module exists for.

**Assets and net worth** — the CDSL CAS import, which is the primary way
holdings get in: a password-protected PDF is read in the process (no external
tool, no library), the password is used once and never stored, and every row is
matched against what is already held so a statement that restates four months
adds only what is new. Holdings as units with FIFO lots, cost basis, XIRR
as the headline return, corporate actions, the net worth statement with R29.4's
four-way decomposition and a dated history, MFAPI and Frankfurter adapters
behind one provider interface — and CSV export of holdings, lots, price history and the net-worth series (F19.13); plus AMFI as the fallback the errata asks for,
reading the registrar's own published file and matching on ISIN, so losing
MFAPI costs nothing. Prices refresh on P4's per-class cadence, because a NAV
published at 23:00 IST does not exist at noon. And asset allocation by class — with foreign holdings split by geography and currency, and a fund left unclassified rather than guessed into a bucket (N9) — and the asset-gain versus FX-gain split that
sums exactly. **R30's ten firewall invariants are a test suite** — including
one that drops the price tables outright and renders the budget screen.

**The shell** — budget screen, theme, PWA manifest, command palette, first-run
wizard, the India-appropriate starting template, Docker Compose.

### Not built yet

| Gap | Where it is specified |
|---|---|
| SMS forwarding | `04` §3.5 — P2, needs an Android companion; iOS cannot read SMS (a platform limit, not a gap) |
| Module feature-flag UI (flags work; they are environment variables) | F28 |
| Tranche drawdown, pre-EMI, moratorium models | `06` R15, R16 M4 — modelled, seeded with no data (Q11) |

Nothing in that list requires reworking stored data. The three things `05` §3
says can never be retrofitted — the engine's semantics, idempotency keys and
the event log — are all in place, and every source of transactions terminates
in the same review queue, which is what `04` §1 says makes the remaining
ingestion work additive rather than a rewrite.

A known wart is recorded rather than hidden: viewing a *past* month subtracts
assignments made in months since, so a July view in December can read lower
than July ever did. That follows `02` R2 literally; the reasoning and its
containment are in
[`docs/dev/01-engine-derivation.md`](docs/dev/01-engine-derivation.md) §4.
