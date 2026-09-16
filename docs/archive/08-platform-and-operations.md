# 08 · Platform, Identity & Operations

**Draft v0.1 · 26-08-2026 · Functional scope only.**
Extends `02-functional-design.md`. Engine rules continue at **R35**; modules are **F21–F30**.
**This document reverses the offline-first design in `02` §9.** See §3.

---

## 1. The call

**The server is the only place data exists, the event log is the only record of how it got that way, and every write carries a key that makes retrying it safe.** Everything else here — theme, debug login, health page, command palette, feature flags, API token — is small, and only reaches P0 because it is cheap now and awkward later.

Three supports:

1. **Server-only data deletes an entire subsystem.** No service worker, no IndexedDB, no cache eviction, no sync queue, no conflict resolution, no cold-start rehydration. [verified] a service worker is **no longer required for installability** — so the strict policy costs nothing structurally on that front, and removes roughly the most defect-prone third of the client. What it costs instead is stated plainly in §3.3, because it is not nothing.
2. **Idempotency and the event log are the two things that cannot be retrofitted.** A key on every write is a five-line change on day one and an archaeology project in month six. The event log is the same, and it pays for four separate features (§6.4) that would each cost more than the log itself.
3. **Debug login is a production security decision disguised as a developer convenience.** Two mechanisms, separately gated: an SSO bypass that **refuses to start** if it detects production, and an in-app "view as" that never bypasses authentication and always leaves a trail.

---

## 2. Decisions confirmed 26-08-2026

| Decision | Choice |
|---|---|
| Client data | **Strict server-only.** No user data persisted on the device, in any storage API. |
| Debug login | **Both, separately gated.** Dev-mode SSO bypass *and* in-app impersonation. |
| Theme | Switchable light/dark, server-stored per member, plus system-follow. |
| Write safety | Idempotency keys on every mutating request. |
| Auditability | Immutable append-only event log. |
| Backup | Scheduled restore verification, not just scheduled backup. |
| Ops | Health/status page, module feature flags, command palette, personal API token. |
| Not doing | Database encryption at rest — declined; see §9 for what to do instead. |

---

## 3. R35 — The client data policy

### 3.1 The rule

**No user data may be persisted on the client device, in any form, by any mechanism.** The server is the sole source of truth and the sole place data rests.

**Explicitly permitted:**

| Permitted | Why it is not user data |
|---|---|
| Static application assets — JS, CSS, fonts, icons — cached by ordinary HTTP caching | Code, not data. Contains nothing about the household. |
| The session cookie: `HttpOnly`, `Secure`, `SameSite=Lax` | Set and controlled by the server; unreadable by scripts; an identifier, not content. |
| In-memory application state for the current view | Discarded on unload. Never written to disk. |
| Text the user has typed and not yet submitted, living in the DOM | The form itself. Lost on close, as it would be anywhere. |
| *(withdrawn 26-08-2026)* | Push is dropped; there is no push subscription and no service worker. |

**Explicitly forbidden, for any user data:**

- `localStorage`, `sessionStorage`, `IndexedDB`, the Cache API, WebSQL, the File System Access API, cookies other than the session cookie.
- **A service worker `fetch` handler.** No request interception, no offline shell, no cached responses.
- Any client-side persistence of transactions, balances, categories, holdings, prices, rates, or member details.
- API keys or provider credentials of any kind (already forbidden by `07` P7).
- Third-party scripts, analytics, error reporters carrying payload data.

**Rules:**

- R35.1 The app MUST NOT register a service worker. **No exception** — push was dropped on 26-08-2026 (Q21), withdrawing the only one that existed.
- R35.2 Every read MUST come from the server. There is no client cache to be stale.
- R35.3 A failed request MUST NOT be papered over with a previously rendered value. If the server cannot be reached, the app says so.
- R35.4 A Content-Security-Policy MUST forbid third-party script, connect, frame and font origins. The app talks only to its own server.
- R35.5 Logging out, and session expiry, MUST leave nothing recoverable on the device.
- R35.6 **Withdrawn 26-08-2026 (Q21).** This rule permitted a service worker registered solely for content-free push. Push is dropped entirely, so no service worker is registered at all and R35.1 stands without exception. Notifications reach the user through the in-app digest (`02` F14.3) and the health page (F27); backup failures additionally fire an outbound webhook (R40.4).

### 3.2 What this deletes

Every one of these is now out of scope and MUST NOT be built:

- Offline transaction entry and the write queue.
- The bounded local cache (`02` PWA3) and its priority rules.
- Sync triggers, sync intervals, and the unsynced-items indicator (`02` PWA5, PWA7).
- Client-side conflict resolution (`02` H4, H5, PWA6).
- Cold-cache rehydration after iOS's 7-day eviction (`02` §9) — there is nothing to evict.
- Background Sync fallbacks — irrelevant, and [verified] unavailable on iOS regardless.

### 3.3 What this costs — stated once, plainly

This is a real trade, not a free win. Four consequences:

1. **No entry without connectivity.** The five-second spend at the shop counter (`03` J2) now requires signal. Basements, crowded markets and patchy 4G will produce moments where the app simply cannot be used. This is the single largest behavioural risk to adoption, because entry friction is what kills budgeting apps in month three (`05` §7).
2. **A server outage is a total outage.** With a self-hosted deployment behind a tunnel, if the box is down or the tunnel drops, the app is not degraded — it is unusable. Backup and uptime stop being hygiene and become load-bearing.
3. **Perceived speed is now network latency.** Every navigation is a round-trip. The performance targets in §8 tighten accordingly.
4. **There are no push notifications at all** (Q21). Every alert is something you see when you open the app, or — for backup failures only — a webhook into your own stack.

**Mitigations that make it workable** — all compliant with R35:

- **Idempotency keys plus bounded in-memory retry** (R36). A thirty-second network blip does not lose the entry: the form holds it in memory and retries with the same key, so a duplicate cannot be created. The tab must stay open — this is resilience, not persistence.
- **A tight server round-trip budget** (§8), so entry feels immediate on a home network.
- **Specific, honest failure states** (§7) — never a spinner that never resolves.

**The documented escape hatch.** If, after a month of use, entry-without-signal proves painful, the minimal change that fixes it is a **write-only queue**: outbound entries only, encrypted, purged on successful sync, with no read cache whatsoever. That restores J2 while keeping every other benefit of this section. It is a bounded change precisely because R36's idempotency keys are already in place. Do not reach for it pre-emptively.

---

## 4. R36 — Idempotent writes

- R36.1 Every mutating request MUST carry a client-generated **idempotency key**, unique to the logical operation, stable across retries.
- R36.2 The server MUST record processed keys and, on a repeat, MUST return the **original result** rather than performing the operation again.
- R36.3 Keys MUST be retained for at least 7 days. A repeat after expiry MUST be treated as a new operation.
- R36.4 A key MUST be scoped to the member, so two members cannot collide.
- R36.5 The client MUST retry on network failure and on 5xx, with exponential backoff and a bounded attempt count, reusing the same key.
- R36.6 The client MUST NOT retry on 4xx other than 408 and 429.
- R36.7 The user MUST see one of three outcomes and never ambiguity: **saved**, **still trying**, or **failed, here is what you typed**.
- R36.8 Bulk operations MUST carry one key for the batch, applied atomically.

This is what makes "the server is the only truth" survivable on a phone with two bars.

---

## 5. R37 — The event log

Every mutation is an **event**: append-only, immutable, ordered, attributed.

- R37.1 An event MUST record: what changed, the before and after values, the actor, the timestamp, the request's idempotency key, the source (UI, import, rule, schedule, API token, price refresh), and — where the actor was impersonating — the real member behind the impersonation (R39).
- R37.2 Events MUST NEVER be edited or deleted. A correction is a new event.
- R37.3 The current state of every record MUST be reproducible by replaying its events. Where the app keeps a materialised current state for speed, that state MUST be reconstructible from the log, and a periodic consistency check SHOULD confirm it is.
- R37.4 The log MUST be queryable by record, by actor, by time range, and by source.
- R37.5 The log MUST be included in backup and export (`02` F15).
- R37.6 Automated writes — rule applications, auto-assign, price refreshes, schedule postings — MUST be logged with the same rigour as human ones, naming the rule or job responsible.
- R37.7 Reads are NOT logged. This is an audit trail, not surveillance of a spouse.

### 5.1 What the log pays for

Four features that would each cost more to build separately:

| Feature | How the log provides it |
|---|---|
| **Universal undo** | Any event, or any batch, reverses by applying its inverse as a new event. Replaces per-feature undo in `02` R9, `04` IL2, `06` R19 and `07` F19.5 with one mechanism. |
| **"Explain this number"** | Tap any computed figure — a category balance, Ready to Assign, lifetime interest, net worth — and see the events that produced it, in order, each attributed. This is the answer to *"why do I have ₹4,000 less than I thought"*, and it is nearly free once the log exists. **Strongly recommended.** |
| **As-of-date views** | *"Show me the budget as it looked on 31-07-2026"* — replay to a point in time. Turns "why did I think I had money" from a memory test into a query. |
| **Deterministic test fixtures** | Replay a real month's events into a scratch database to reproduce a bug with real data, or to seed demo mode (`02` F17.3). |

- R37.8 Undo MUST be available for any event within a configurable window (default 30 days) and MUST itself be logged.
- R37.9 Undoing an event whose effects have been superseded MUST warn and MUST show what would change, rather than silently conflicting.

---

## 6. R38 — Identity, debug login and impersonation

Two mechanisms. They are not the same thing and MUST NOT share a code path.

### 6.1 Dev-mode SSO bypass

- R38.1 A **development-only** login MUST allow signing in as any seeded member without Google, selecting from a list.
- R38.2 It MUST be gated behind an explicit environment flag that is **off by default**.
- R38.3 The application MUST **refuse to start** if that flag is set while any production indicator is present — a non-development environment name, a public hostname, a real OAuth client, or a database containing more than the seed dataset. Refuse to start, not warn: a warning in a log is a bypass nobody reads.
- R38.4 When active, every page MUST carry an unmissable persistent banner naming the mode and the impersonated member.
- R38.5 The bypass MUST NOT exist in the production build artefact at all, not merely be disabled in it.

### 6.2 In-app "view as"

- R38.6 Any authenticated member MAY view the app as another member. There is no privilege hierarchy to escalate (`02` P5) — the purpose is reproducing what the other person is seeing, not gaining access.
- R38.7 Impersonation MUST show a **persistent, high-contrast banner** on every screen: *"Viewing as Priya — exit"*. Never a subtle chip.
- R38.8 Entering and leaving impersonation MUST be logged as events (R37).
- R38.9 Every write performed while impersonating MUST record **both** identities: the acting member and the real one (R37.1). The audit trail must never lose who actually did it.
- R38.10 Impersonation MUST default to **read-only**, with writes requiring an explicit, separately-confirmed toggle within the session.
- R38.11 Impersonation MUST expire automatically (default 30 minutes) and on tab close.
- R38.6a **View-as is off unless `ADMIN_DEBUG` is set**, and is an operator tool rather than a household feature. It was designed for a household where one member sets things up for another; with separate budgets (`15`) that premise fails, because a personal budget a partner can step into is not a separate budget. It remains for supporting a hosted customer and for reproducing a fault locally. The control and the routes are both absent when the flag is off.
- R38.6b While view-as is active it MUST expose the **household budget only**. A personal budget is never readable through it, for the same reason H2.4 resolves account privacy against the authenticated member: a feature that reads what somebody kept separate is worse than no feature.
- R38.12 Impersonation MUST NOT be available to a personal API token (R40).

### 6.3 Session handling

- R38.13 Sessions MUST be server-side, referenced by an `HttpOnly; Secure; SameSite=Lax` cookie.
- R38.14 A member MUST be able to list and revoke their active sessions, each showing device, approximate location and last-seen time.
- R38.15 An idle timeout MUST apply (default 30 days for a household deployment, configurable down). With no data on the device, the session **is** the key; treat it as one.
- R38.16 Failed authentication MUST be rate-limited per source, and the member allow-list MUST be enforced server-side on every request, not only at login.

---

## 7. R39 — Theme

- R39.1 The app MUST support three theme settings per member: **light**, **dark**, **follow system**. Default is follow system.
- R39.2 The setting is stored **server-side** on the member (`02` F17.2). No client storage is involved (R35).
- R39.3 The server MUST render the resolved theme into the initial HTML response — as an attribute on the root element — so the correct theme paints on first frame. **There must be no flash of the wrong theme**, which is the entire reason this is a server-rendered value rather than a script that runs after load.
- R39.4 "Follow system" MUST be implemented with `prefers-color-scheme` in CSS, requiring no storage and no JavaScript.
- R39.5 The toggle MUST be reachable from the app header on every screen, not buried in settings, and MUST take effect immediately without a reload.
- R39.6 Both themes MUST meet WCAG 2.1 AA contrast (`02` A3) and MUST NOT rely on colour alone for funded/overspent state (`02` A2). Dark mode is where red-on-dark contrast quietly fails.
- R39.7 Charts, the budget grid's state colours, and the gain/loss palette MUST be defined as tokens with both light and dark values. No hard-coded colours anywhere.
- R39.8 The app MUST respect `prefers-reduced-motion` in both themes (`02` A6).

---

## 8. R40 — Backup, restore and verified recovery

`02` F15.5 required a backup. That is not the same as being able to recover.

- R40.1 A scheduled backup MUST capture the complete dataset including the event log, and MUST be restorable by a documented procedure.
- R40.2 **A scheduled restore verification MUST run**: restore the most recent backup into a scratch database, and compare — record counts per entity, control totals (sum of all transactions, sum of all assignments, net worth as of the backup date), and event log integrity.
- R40.3 The verification result MUST be reported on the health page (F27) with its timestamp: *"Last verified restore: 25-08-2026, 14 entities, all control totals matched."*
- R40.4 A failed or skipped verification MUST raise an alert through the configured channel, not merely a log line.
- R40.5 The verification MUST run against a **scratch database**, never the live one, and the procedure MUST make that impossible to get wrong.
- R40.6 The restore procedure MUST be documented as a runbook, with the rollback step written before the destructive one, and MUST have been executed by a human at least once before the app holds real data.
- R40.7 Backups MUST be verifiably restorable **without the application** — an open, documented format, so a broken deployment never becomes lost data.

---

## 9. Modules

### F21 · Client data policy & PWA *(supersedes `02` §9 PWA1–PWA10)*

Constraints [verified] 26-08-2026:

- A **service worker is no longer required for installability** in Chromium browsers; a manifest with `name`/`short_name`, 192px and 512px icons, `start_url`, and `display`, served over HTTPS, is sufficient. The `beforeinstallprompt` custom-button path *does* still require a fetch handler — which R35 forbids — so there is no custom install button on Android either.
- iOS has never supported `beforeinstallprompt`, and installs via the Share menu.

Therefore:

- F21.1 The app MUST be installable via a web app manifest with the required fields, served over HTTPS.
- F21.2 The app MUST NOT register a service worker. There is no permitted exception (R35.1).
- F21.3 The app MUST show explicit, illustrated install instructions on first visit, on **both** iOS and Android, since neither offers a programmatic prompt under this policy.
- F21.4 The app MUST enforce R35 in full, and this MUST be verified by an automated test asserting that no storage API holds user data after a representative session.
- F21.5 The app MUST present a clear, specific state when the server is unreachable (§10), never a stale value and never an indefinite spinner.
- F21.6 The app MUST implement R36 retry so a transient failure recovers without user action.
- F21.7 *(withdrawn — Q21.)* There is no push. The in-app digest (`02` F14.3) and the health page (F27) are the notification channels; backup failures also fire a webhook (R40.4).
- F21.8 The Badging API MAY be used for the review-queue count where available.

**Performance targets, revised for a network round-trip:**

| Interaction | Target |
|---|---|
| Budget screen interactive, home network | under 1.2s |
| Budget screen interactive, mobile network | under 2.5s |
| Transaction entry acknowledged as saved | under 400ms on a home network |
| Server response, budget month with 500 transactions | under 200ms at the server |
| A month with 500 transactions and 60 categories | scrolls at 60fps |

### F22 · Theme

- F22.1–F22.8 implement R39 in full.
- F22.9 Settings MUST offer a live preview of both themes side by side.

### F23 · Debug login & impersonation

- F23.1–F23.5 implement R38.1–R38.5 (dev-mode bypass).
- F23.6–F23.12 implement R38.6–R38.12 (in-app "view as").
- F23.13 The health page MUST display whether the dev bypass is compiled in — which in production MUST always read *"not present"*.

### F24 · Idempotency & write safety

- F24.1–F24.8 implement R36 in full.
- F24.9 The health page MUST show recent idempotency collisions, which are the fingerprint of a flaky network or a client retry bug.

### F25 · Event log, undo & explain

- F25.1–F25.9 implement R37 and R38 in full.
- F25.10 The app MUST provide **"explain this number"** on: a category balance, Ready to Assign, a loan's outstanding and lifetime interest, a holding's cost basis and gain, and net worth.
- F25.11 The app MUST provide an **as-of-date view** of the budget and of net worth.
- F25.12 The app MUST provide a per-record history pane showing every event that touched it (`02` F1.5, F4.9).

### F26 · Backup, restore & verification

- F26.1–F26.7 implement R40 in full.
- F26.8 A manual "back up now" and "verify restore now" MUST be available from the health page.

### F27 · Health & status page

A single page answering *"is everything fine?"* without a terminal.

- F27.1 It MUST show: application version and build; database size and connection status; last successful and last failed **price fetch per provider**, with remaining daily quota (`07` §6.4); last **FX fetch**; last **import**; last **backup** and last **verified restore** (R40.3); review-queue depth; scheduled-job status with next run times; error count in the last 24 hours; and whether the dev login bypass is present (F23.13).
- F27.2 It MUST be reachable by authenticated members only.
- F27.3 It MUST offer a machine-readable endpoint for external monitoring, returning a single overall status plus per-check detail.
- F27.4 Every check MUST have an explicit healthy/degraded/failed state with a plain-language reason — never a bare boolean.

### F28 · Module feature flags

- F28.1 Loans (`06`), assets and net worth (`07`), and multi-currency (`07` §5) MUST each be independently disableable per deployment.
- F28.2 A disabled module MUST disappear from navigation, search, the command palette, reports and settings — not appear greyed out.
- F28.3 Disabling MUST NOT delete data. Re-enabling MUST restore the module intact.
- F28.4 Flags MUST be visible on the health page.
- F28.5 Flags are deployment-level, not per-member. A household sees one app.

### F29 · Command palette

- F29.1 A palette MUST open on `Cmd/Ctrl-K` from anywhere.
- F29.2 It MUST cover: navigation to any screen, account, category or holding; actions (add transaction, move money, auto-assign, reconcile, refresh prices, toggle theme, switch month); and search across payees, memos and amounts (`02` F16).
- F29.3 Results MUST be keyboard-navigable and MUST show the shortcut for actions that have one.
- F29.4 It MUST be fully usable without a mouse, from open to execution.
- F29.5 It MUST NOT be the only route to any action — every action needs a discoverable path too.

### F30 · Personal API token

- F30.1 A member MUST be able to mint named tokens for their own scripts.
- F30.2 Each token MUST carry an explicit scope — at minimum read-only versus read-write — and SHOULD support module-level scoping.
- F30.3 Tokens MUST be listable with created date, last-used date and scope, and MUST be individually revocable.
- F30.4 The secret MUST be shown once, at creation, and never retrievable again.
- F30.5 Token actions MUST be attributed in the event log to the member, naming the token (R37.1).
- F30.6 Tokens MUST NOT be able to impersonate (R38.12), mint other tokens, change the member allow-list, or read the dev-bypass state.
- F30.7 Token requests MUST be rate-limited independently of session requests.
- F30.8 A token MUST support an optional expiry, defaulting to none for a household deployment.

---

## 10. Screens

### S15 · Health & status

Grouped cards — Application · Data · Jobs · Providers · Backup — each check showing state, last-run time and a plain-language reason. A "run now" control on the checks that support it. This is the page you open at 2am; it must be legible then.

### S16 · Command palette

An overlay, not a screen. Opens on `Cmd/Ctrl-K`. Fuzzy input, grouped results (Go to · Do · Find), keyboard-only operation, escape to dismiss.

### Additions to existing screens

- **Every screen:** the theme toggle in the header (R39.5); the impersonation banner when active (R38.7); the dev-mode banner when active (R38.4).
- **Every computed figure:** an "explain" affordance (F25.10).
- **Settings (S11):** theme with live preview; sessions and revocation; API tokens; feature flags (read-only display of deployment config); backup and restore controls.
- **Record detail panes:** the event history for that record (F25.12).
- **Budget (S1):** an as-of-date control, off by default, which puts the whole screen into a clearly-marked historical mode.

---

## 11. Journeys

**J21 · Entering a transaction on a weak connection.** Type amount, payee, category, Save. The button shows *"Saving…"*. The network drops. The app retries three times over twenty seconds with the same idempotency key. It succeeds: *"Saved."* Had it failed, the message would be *"Couldn't reach the server. Your entry is still here — try again?"* with the form intact. Nothing was written to the device; nothing was lost while the tab stayed open.

**J22 · "Why do I have ₹4,000 less than I thought?"** Tap the Groceries balance → **Explain** → a chronological list: assigned ₹12,000 on 01-08 by Ravi; ₹1,850 moved out to Eating Out on 14-08 by Priya; ₹2,150 spent on 18-08, categorised by rule *"Contains DMART → Groceries"*. Three events, three actors, one answer.

**J23 · Reproducing Priya's bug.** Ravi opens the command palette, types "view as", selects Priya. A red banner appears: *"Viewing as Priya — read only — exit"*. He sees the screen she described, finds the misconfigured filter, exits, and fixes it as himself. Both the entry and the exit are in the event log.

**J24 · The Sunday check.** Health page: last NAV fetch 23:04 last night, all 12 funds; FX fetch 18:31, rate dated 25-08; Alpha Vantage 18 of 25 calls remaining; last backup 03:00, **last verified restore 25-08 with all control totals matched**; two scheduled jobs due tonight; zero errors in 24 hours. Thirty seconds, no terminal.

---

## 12. Failure states

| State | Required behaviour |
|---|---|
| **Server unreachable** | A specific, calm message naming what failed and offering retry. Never a stale value (R35.3), never an indefinite spinner. Distinguish "you appear to be offline" from "the server didn't answer" — they need different actions from the user. |
| **Save failed after retries** | The typed input stays on screen with a clear retry. The user must never re-type. |
| **Session expired mid-action** | Re-authenticate in place and complete the pending action using its original idempotency key, so the user does not lose the entry or create a duplicate. |
| **Server in maintenance or read-only mode** | An explicit banner stating the mode and the expected duration. Writes disabled with a reason, reads still working. |
| **Impersonation active** | Banner on every screen, in every theme, at AA contrast. Never dismissible. |
| **Dev bypass active** | Distinct from the impersonation banner, and impossible to confuse with production. |
| **A background job failed repeatedly** | Health page degraded, a Review item, and an alert through the configured channel. |
| **Restore verification failed** | Loud. This is the one failure where a quiet log line is negligence. |

---

## 13. Further suggestions

You asked for suggestions as well as answers. These are the ones worth a decision; each carries a recommendation and a default.

| # | Suggestion | Why | Recommendation |
|---|---|---|---|
| S1 | **"Explain this number" on every computed figure** | Nearly free once the event log exists, and it is the single highest-trust feature in the app. A budget you cannot interrogate is a budget you eventually stop believing. | **Build it in P0**, alongside the log. Specified as F25.10. |
| S2 | **As-of-date views** | Answers "why did I think I had money in July". Falls out of the log; costs a query, not a subsystem. | Build in P1. F25.11. |
| S3 | **Server-rendered first paint** | Solves the theme flash without client storage (R39.3), and with server-only data it is the natural architecture rather than an optimisation. | Adopt as the default rendering approach. |
| S4 | **Deterministic replay into a scratch database** | Reproduce any bug with the real month that caused it; seed demo mode from real shapes without real data. | Build in P1, as a maintenance script rather than a UI. |
| S5 | **A month-close ritual** | An explicit "close the month" step that snapshots net worth, reports the month's outcome, and confirms the new month is funded. Budgeting works when it is a ritual; the app currently has no moment that feels like one. | **Adopted 26-08-2026 (Q26) — committed to P1.** |
| S6 | **Edge rate-limiting and allow-list enforcement** | A self-hosted app on a public hostname gets scanned within hours. Enforce the member allow-list server-side on every request, not just at login (R38.16), and rate-limit auth attempts. | P0. This is hygiene, not a feature. |
| S7 | **Structured logs with a single level control** | One environment variable, structured output, no financial values in log lines. Makes the health page's error counts meaningful. | P0, trivial. |
| S8 | **A maintenance / read-only mode** | Lets you take backups, run migrations and restore verifications without lying to whoever has the app open. | P1. §12 covers the behaviour. |
| S9 | **Declined by the owner: database encryption at rest** | You declined it, and I agree for this deployment: on a self-hosted box the database key must live where the app can read it at start, so it protects against a stolen disk and little else — while adding a key-management step that, if fumbled, loses everything. | **Instead:** encrypt the *backups*, which travel and are the real exposure, and rely on full-disk encryption on the host. |
| S10 | **Do not add a read cache "just for speed"** | The moment a read cache appears, R35 is dead and every deleted subsystem in §3.2 comes back. If speed is the problem, fix the server response time. | A standing rule, not a feature. |

---

## 14. Open questions — closed 26-08-2026

Full answers in `09-decisions-log.md` §3.

| # | Decision | Effect on this document |
|---|---|---|
| Q21 | **Push dropped entirely** | **R35.6 is withdrawn.** F21.2 becomes absolute: the app MUST NOT register a service worker, with no exception. F21.7 is withdrawn. The in-app digest (`02` F14.3) is the only notification channel. The client is now a manifest, static assets, an HttpOnly session cookie and in-memory view state — nothing else. |
| Q22 | Session idle timeout **30 days**, revocable per device | R38.15 confirmed as written. |
| Q23 | Impersonation **read-only by default**, writes behind an explicit in-session toggle | R38.10 confirmed as written. |
| Q24 | **Health page only — except backup failures** | R40.4 stands: failed backup and failed restore-verification fire an outbound webhook (`02` F14.4). Price-feed failures, job failures and import errors stay on the health page (F27) and in Review. Narrowed from the original suggestion after pushback; the residual risk is accepted in `09` §7. |
| Q25 | Undo window **30 days** | R37.8 confirmed as written. |
| Q26 | Month-close ritual **adopted, P1** | S5 in §13 moves from suggestion to committed scope. |

**Also decided elsewhere, affecting this document:** attachments are in scope (Q10) — stored server-side only, never cached on the device, and counted in the restore-verification control totals (R40.2). Deployment is the homelab behind Cloudflare Tunnel (Q8), which with server-only data makes uptime load-bearing — see `09` §7.
