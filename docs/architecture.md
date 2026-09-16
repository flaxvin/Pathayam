# Architecture

A single Node process, a single SQLite file, server-rendered HTML, and no
runtime dependencies. About 49,000 lines of TypeScript, 92 test files, 1,119
tests.

```
  browser ──HTML──▶  src/web      pages, layout, styles, a small client script
                         │
                         ▼
                     src/app.ts   193 routes · middleware · auth · CSRF
                         │
                         ▼
                     src/domain   accounts, transactions, loans, assets, goals…
                         │
                         ▼
                     src/engine   the envelope arithmetic — pure, no I/O
                         │
                         ▼
                     src/db       SQLite, 37 migrations, the rollup cache
```

## The layers, and what each is not allowed to do

**`src/engine`** is pure arithmetic. It takes an `EngineInput` — months,
categories, assignments, transactions, targets, opening balances — and returns a
`MonthState` per month. It reads no database and writes nothing. Every figure
the app shows about a budget comes from here, which is why it can be tested
exhaustively without a fixture database and why the accounting identity can be
asserted after every month of a three-year simulation.

**`src/domain`** owns the rules that need storage: what an account is, what
happens when a loan is prepaid, when a transaction may be deleted. Domain
functions take `(db, actor, input)`, write inside a transaction, and append to
the event log. **Business logic belongs here and not in a route** — a step that
lives only in a route handler cannot be reached by a simulation, and the app has
shipped exactly that bug: confirming a learned rule was a bare `UPDATE` inside a
route, so three years of simulated use proposed forty-three rules and confirmed
none of them.

**`src/web`** renders. The template tag escapes by default; an unescaped value
has to be typed on purpose (`raw`). Pages receive view models, not the database.

**`src/app.ts`** is the route table and the middleware stack: static assets,
same-origin enforcement on writes, authentication, then routing. It resolves
ids to objects the viewer is allowed to see — `requireVisibleAccount`,
`requireVisibleTransaction`, `requireVisibleCategory`, `requireVisibleGroup`,
`requireVisibleAttachment` — and hands those to the domain.

## Zero dependencies

Not a boast; a maintenance decision. There is no supply chain to audit, no
lockfile drift, and no upgrade treadmill for an app one household runs for
years. Everything that would normally be a package is either in the platform or
written here:

| | |
|---|---|
| HTTP server | `node:http` |
| Database | `node:sqlite` |
| Templating | a tagged template literal that escapes by default (`src/http/html.ts`) |
| Charts | SVG generated server-side (`src/web/charts.ts`) |
| PDF reading | `src/pdf/` — object parser, RC4/AES decryption, text extraction with layout |
| CSV | `src/import/csv.ts` |
| Crypto | `node:crypto` |
| Tests | `node:test` |

TypeScript is a development dependency. Node runs the sources directly with
type stripping in development, and `dist/` is compiled for production.

## The engine identity

Everything the engine computes is held together by one equation, derived in
[`dev/01-engine-derivation.md`](dev/01-engine-derivation.md) §1:

```
Σ budget-account balances  +  due from other budgets
    =  Σ category balances  +  Ready to Assign  +  held for next month
       +  Σ future assignments  −  unfunded credit absorbed
```

`identityResidual(state)` returns the difference. It must be exactly zero — not
close, zero, in integer paise. Every arithmetic change is judged by it, and a
thirty-six-month simulation asserts it after **every month in every budget**
rather than once at the end, so a break names the month it started in.

## Money is integers

Paise, as a branded `Paise` type. No floats anywhere near a balance. `rupees()`
converts in, `formatPaise` renders out.

## Storage

One SQLite file. 37 migrations, applied in order at startup; the app refuses to
start against a database written by a newer build rather than guessing.

**The rollup cache** stores per-month aggregates so opening the budget screen
does not walk the whole ledger. It is invalidated by SQLite triggers on write.
Because a stale cache is silent — every screen reads the cache, so a wrong one
is simply believed — the test suite computes every month **twice**, once from
the rollup and once from the ledger, and requires them to agree.

**Events.** Every mutation appends an event with an actor, a summary in plain
words, and enough before/after state to undo it. The activity log is that table
rendered, and undo is that table replayed.

## Rendering

Server-rendered HTML, first paint complete. There is no client framework. The
client script (`src/web/client.ts`) adds keyboard shortcuts, inline form
submission, and a command palette — the app works with it disabled, which is a
constraint that has caught real defects: a scope control that submitted itself
with `onchange` did nothing without scripting, and was replaced with links.

Installable as a PWA: a manifest, icons at every size a platform asks for, and a
theme colour in the first response so the wrong theme never paints.

## What runs where

| | |
|---|---|
| `src/core` | money, dates, events, refusals — the vocabulary everything shares |
| `src/auth` | sessions, Google OAuth, API tokens, dev login |
| `src/import` | CSV, statement PDFs, dedupe, rules, learning, the review pipeline |
| `src/pdf` | a PDF reader: objects, decryption, text with layout |
| `src/portfolio` | holdings, lots, prices, providers |
| `src/loans` | amortisation |
| `src/gmail` | the opt-in statement fetcher |
| `src/ops` | backup, restore, health |
| `src/sim` | the thirty-six-month household simulation |
