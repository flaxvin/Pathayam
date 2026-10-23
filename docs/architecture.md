# Architecture

## Process model

A single Node process serving HTTP, with one SQLite database file. No
background workers, no message queue, no cache server, no external service
except Google (sign-in and Gmail), an OpenID Connect provider when one is
configured, and two price feeds.

- **Runtime:** Node 24 or later.
- **Language:** TypeScript. Development runs the sources directly with type
  stripping; production runs `dist/`, compiled by `tsc`.
- **Runtime dependencies:** none. `package.json` declares `typescript` and
  `@types/node` as development dependencies only.
- **Size:** ~74,000 lines of TypeScript, plus ~51,000 lines of tests in 328
  test files; 2,626 tests.

## Module layout

```
src/
  main.ts          entry point: config, database, server
  app.ts           route table (186 paths, 222 handlers) and middleware
  config.ts        environment parsing and startup safety checks
  restore.ts       backup restore CLI

  core/            money, dates, events, refusals, ids
  db/              connection, migrations, schema, query helpers
  engine/          envelope arithmetic — pure, no I/O
  domain/          entity rules that need storage
  web/             pages, layout, stylesheet, client script, charts, the
                   offline outbox for the Add form
  http/            server, router, HTML templating, multipart parsing
  import/          CSV, PDF statements, dedupe, rules, learning, pipeline
  pdf/             PDF object parser, decryption, text extraction
  portfolio/       holdings, lots, price providers
  loans/           amortisation
  deposits/        a deposit's value from its terms — pure, no I/O
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
2. **Host check.** Any method other than `GET`, `HEAD` or `OPTIONS` must be
   addressed to `BASE_URL`'s host and port, or to an IP literal or
   `localhost`, which no DNS answer is involved in and so cannot be rebound.
   Behind a proxy with `TRUST_PROXY` set, the right-most `X-Forwarded-Host`
   is taken as the host; otherwise the `Host` header. Failure: `403`.
3. **Same-origin check.** The same requests must carry an `Origin` header
   matching the deployment, or a `Referer` from it. Requests bearing
   `Authorization: Bearer` and no session cookie are exempt from both checks.
   Failure: `403`.
4. **Authentication.** Session cookie or bearer token resolved to a member.
   Unauthenticated requests to protected paths redirect to `/signin`.
5. **Routing.** Exact paths first, then parameterised patterns.
6. **Handler.** Resolves ids through visibility guards, calls the domain,
   renders or redirects.
7. **Response.** Security headers applied to every response.

### Error handling

| Thrown | Status | Body |
|---|---|---|
| `Refusal` | 422 | The refusal's message, rendered in the page |
| `Missing` (extends `Refusal`) | 404 | Its message — an id, in the URL or a form field, that names nothing this member can see |
| `NotFound` | 404 | Not-found page |
| `HttpError(status, message)` | as given | Message |
| anything else | 500 | Generic message; the error is logged and recorded in `request_failures` |

## Storage

One SQLite file, default `$DATA_DIR/pathayam.sqlite`, opened via `node:sqlite`.

- **Migrations** are an ordered array in `src/db/schema.ts`, applied at startup
  inside transactions, each recorded as applied. 66 exist.
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
- The client script adds keyboard shortcuts, a command palette, inline form
  submission, and the Add form's offline queue (`src/web/outbox.ts`: an entry
  kept in the browser's storage and sent when the connection is back; no
  service worker). Every feature but that queue works without it.
- A web app manifest, icons, and a theme colour in the first response make the
  app installable.

## Concurrency

Single process, single database connection. SQLite serialises writes. Domain
writes run inside `transact()`. Idempotency keys (`idempotency_keys`) make a
replayed write return the original response rather than acting twice.
