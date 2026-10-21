# Full rescan — state (resume from here)

Started 21-10-2026 on `main` @ cebdd0b. Branch: `claude/beautiful-gates-1nevt6`.
This directory is the durable record: the branch is pushed after every update, so a
container restart or usage limit loses at most the work since the last push.

## How to resume
1. `git fetch origin && git checkout claude/beautiful-gates-1nevt6` (state lives here).
2. Read each `.scan/<area>.md` — its RESUME block says what is done and what is next.
3. Fixes already integrated are commits on this branch (see "Integrated" below).
   Fixes not yet integrated are patches in `.scan/patches/<area>/` — `git am` them.
4. Re-launch only the areas whose status is not `done`, telling each to read its own
   `.scan/<area>.md` first and continue from its RESUME block.

## Areas (one sub-agent each, own worktree, own port)
| # | Area file | Scope | Port | Status |
|---|---|---|---|---|
| 1 | transactions.md | transactions, transfers, splits, tags, attachments, undo/activity | 8201 | launched |
| 2 | accounts.md | accounts, cards, reconciliation, loans, family loans, assets/portfolio, net worth, tax/FI | 8202 | launched |
| 3 | imports.md | CSV/PDF/CAS/Gmail imports, dedupe, review queue, rules, payees | 8203 | launched |
| 4 | security.md | authn/authz, sessions, tokens, OIDC, impersonation (ADMIN_DEBUG), CSRF, XSS, injection, DoS, headers | 8204 | launched |
| 5 | budget.md | engine, envelopes, RTA, schedules, goals, commitments, departure, month close, reports; randomized fuzzer | 8205 | launched |
| 6 | routes.md | every route x method with fuzzed input; 500s, broken rendering | 8206 | launched |
| 7 | ui-flows.md | real Chromium, signed in as each member: every user journey by clicking; in-app impersonation | 8207 | launched |
| 8 | ui-quality.md | real Chromium: mobile viewport, PWA/service worker/offline, console errors, a11y, visual breakage | 8208 | launched |

## Integrated (commits on this branch)
(none yet)

## Decisions pending for the owner
(none yet)
