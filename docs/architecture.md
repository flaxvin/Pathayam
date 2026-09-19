# Architecture

## Process model

A single Node process serving HTTP, with one SQLite database file. No
background workers, no message queue, no cache server, no external service
except Google OAuth and two price feeds.

- **Runtime:** Node 24 or later.
- **Language:** TypeScript. Development runs the sources directly with type
  stripping; production runs `dist/`, compiled by `tsc`.
- **Runtime dependencies:** none. `package.json` declares `typescript` and
  `@types/node` as development dependencies only.
- **Size:** ~49,000 lines of TypeScript, 92 test files, 1,119 tests.

## Module layout

```
src/
  main.ts          entry point: config, database, server
  app.ts           route table (162 paths, 193 handlers) and middleware
  config.ts        environment parsing and startup safety checks
  restore.ts       backup restore CLI

  core/            money, dates, events, refusals, ids
  db/              connection, migrations, schema, query helpers
  engine/          envelope arithmetic — pure, no I/O
  domain/          entity rules that need storage
  web/             pages, layout, stylesheet, client script, charts
  http/            server, router, HTML templating, multipart parsing
  import/          CSV, PDF statements, dedupe, rules, learning, pipeline
  pdf/             PDF object parser, decryption, text extraction
  portfolio/       holdings, lots, price providers
  loans/           amortisation
  gmail/           OAuth grant and message fetching
  auth/            sessions, passwords, OpenID Connect, Google sign-in, API tokens, dev login
  ops/             backup, restore, error recording
  sim/             36-month household simulation
```

### Layer responsibilities

| Layer | Takes | Returns | Constraints |
|---|---|---|---|
| `engine` | `EngineInput` | `Map<MonthKey, MonthState>` | No database access. No clock access except a passed-in `today`. |
| `domain` | `(db, actor, input)` | entity or void | Writes inside a transaction; appends an event. Throws `Refusal` for rule violations, `NotFound` for absent or invisible entities. |
| `web` | view models | `SafeHtml` | No database access. All interpolation escaped unless explicitly marked `raw`. |
| `app.ts` | `RequestContext` | `Response` | Resolves ids to visible entities before calling domain functions. |

Business logic lives in `domain`, not in route handlers. A route handler
resolves parameters, calls one or more domain functions, and renders.

## Request lifecycle

1. **Static assets.** `/assets/*`, `/manifest.webmanifest` are served from
   memory before routing.
2. **Same-origin check.** Any method other than `GET`, `HEAD` or `OPTIONS` must
   carry an `Origin` header matching the deployment, or a `Referer` from it.
   Requests bearing `Authorization: Bearer` are exempt. Failure: `403`.
3. **Authentication.** Session cookie or bearer token resolved to a member.
   Unauthenticated requests to protected paths redirect to `/signin`.
4. **Routing.** Exact paths first, then parameterised patterns.
5. **Handler.** Resolves ids through visibility guards, calls the domain,
   renders or redirects.
6. **Response.** Security headers applied to every response.

### Error handling

| Thrown | Status | Body |
|---|---|---|
| `Refusal` | 422 | The refusal's message, rendered in the page |
| `NotFound` | 404 | Not-found page |
| `HttpError(status, message)` | as given | Message |
| anything else | 500 | Generic message; the error is logged and recorded in `request_failures` |

## Storage

One SQLite file, default `$DATA_DIR/pathayam.sqlite`, opened via `node:sqlite`.

- **Migrations** are an ordered array in `src/db/schema.ts`, applied at startup
  inside transactions, each recorded as applied. 37 exist.
- The application **refuses to start** if the database reports a schema version
  higher than the build knows.
- Migrations flagged `rebuildsTable` run with `PRAGMA foreign_keys = OFF`
  outside a transaction.
- **Attachments** are stored as blobs in the `attachments` table, not on disk.

### Rollup cache

`month_rollups` holds per-month aggregates keyed by `(month, fact, category_id,
account_id, kind)`. `month_rollup_state` records when each month was built.
SQLite triggers on the underlying tables clear the state row when the month's
inputs change.

`loadEngineInput(db, { through, useRollup, budgetId })` reads from the cache
when it is current and from the ledger otherwise. Both paths must produce the
same result; the test suite computes every month both ways and compares.

### Events

Every mutation appends a row to `events` with actor, entity, action, a plain
language summary, and `before_json` / `after_json`. The activity log renders
this table. Undo replays it: an undo is itself an event, linked by
`undo_of_event_id` and `undone_by_event_id`. Nothing is edited or deleted to
undo something.

## The accounting identity

```
Σ budget-account balances  +  due from other budgets
    =  Σ category balances  +  Ready to Assign  +  held for next month
       +  Σ future assignments  −  unfunded credit absorbed
```

`identityResidual(state)` returns the difference in paise and must be `0`.
Derived in [dev/01-engine-derivation.md](dev/01-engine-derivation.md) §1.

## Rendering

Server-rendered HTML. No client-side framework, no build step for the frontend.

- `src/http/html.ts` provides a tagged template that escapes `& < > " '` on
  every interpolation. `raw()` opts out explicitly. `when(cond, fn)` accepts
  only `SafeHtml`.
- Charts are inline SVG generated server-side (`src/web/charts.ts`).
- The stylesheet and client script are single modules served from memory with a
  content hash in the URL.
- The client script adds keyboard shortcuts, a command palette, and inline form
  submission. Every feature works without it.
- A web app manifest, icons, and a theme colour in the first response make the
  app installable.

## Concurrency

Single process, single database connection. SQLite serialises writes. Domain
writes run inside `transact()`. Idempotency keys (`idempotency_keys`) make a
replayed write return the original response rather than acting twice.
