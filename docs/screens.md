# Screens and routes

162 distinct paths: 79 answer `GET`, 114 answer `POST` (31 answer both). Every screen is a plain URL.

Parameterised routes resolve their identifier through a visibility guard and
answer 404 when the viewer may not see the entity
([privacy.md](privacy.md)).

## Budget

| Route | Purpose |
|---|---|
| `GET /` | The month grid: groups, envelopes, assigned / activity / available, Ready to Assign, underfunded summary, card warnings, digest. Accepts `?month=` and `?budget=`. |
| `GET /categories` | Manage groups and envelopes: rename, reorder, set targets, hide, delete. |
| `GET /move` | Move money between envelopes. |
| `GET /hold` | Withhold part of this month's Ready to Assign for next month. |
| `GET /auto-assign` | Plan filling targets from Ready to Assign. |
| `POST /assign` | Set one envelope's assignment for a month. |
| `POST /copy-last-month` | Copy the previous month's assignments. |
| `POST /move` | Move money between envelopes, including to cover an overspend. |
| `GET /explain/ready-to-assign`, `GET /explain/category/:id` | Derivation of a displayed figure. |
| `GET /months`, `GET /months/:month/close`, `POST /months/:month/close`, `POST /months/:month/reopen` | Month close ritual and history. |

## Accounts and transactions

| Route | Purpose |
|---|---|
| `GET /accounts`, `GET /accounts/new` | List with cleared / uncleared / working balances. |
| `GET /accounts/:id` | Register with running balance. |
| `POST /accounts/:id/edit`, `/close`, `/reopen` | |
| `GET /accounts/:id/reconcile`, `POST` | Reconcile against a bank balance. |
| `GET /accounts/:id/cards`, `POST`, `POST /accounts/:id/cards/:cardId/close` | Physical cards on a credit account. |
| `GET /accounts/:id/statement`, `POST` | Record a card statement. |
| `GET /add`, `POST /add` | Money in, money out. |
| `GET /transfer`, `POST /transfer` | Between accounts. |
| `GET /transaction/:id`, `POST` | Edit, splits, tags, owner, raw values, history. |
| `POST /transaction/:id/categorise`, `/settled`, `/delete`, `/attach` | |
| `GET /attachment/:id`, `POST /attachment/:id/delete` | Receipts. |
| `GET /cards` | Every credit card in due order, with funded and unfunded amounts. |
| `POST /transaction/:id/convert-to-emi` | Convert a card charge into an instalment plan. |

## Import and review

| Route | Purpose |
|---|---|
| `GET /review` | Everything awaiting a decision: staged rows, duplicates, uncategorised, overspent, unfunded cards, proposed rules. |
| `POST /review/approve`, `/review/merge`, `/review/reject` | Act on one staged row. |
| `GET /import` | CSV paste, PDF upload, saved profiles, batch history. |
| `POST /import`, `POST /import/pdf`, `POST /import/map` | |
| `POST /import/undo` | Undo an entire batch. |
| `POST /import/profiles/:id/delete` | |
| `GET /rules` | Rules, proposals and a tester. |
| `POST /rules/new`, `/rules/test`, `/rules/confirm`, `/rules/dismiss`, `/rules/:id/apply`, `/rules/:id/delete` | |
| `GET /payees`, `POST /payees/merge` | |
| `GET /gmail/connect`, `GET /gmail/callback`, `POST /gmail/fetch`, `POST /gmail/disconnect` | |

## Analysis

| Route | Purpose |
|---|---|
| `GET /overview` | Runway, due-soon bills, month at a glance, insights. |
| `GET /reports` | Income vs spend, category trends, tag spend, spending calendar, Sankey, loan interest by financial year, realised gains by financial year. |
| `GET /query`, `GET /query.csv` | Filterable, groupable transaction table. Totals cover every matching row. |
| `GET /search` | Everything from one box. |
| `GET /net-worth`, `GET /net-worth.csv` | Decomposition and dated history. |
| `GET /household` | Per-member standing, commitments, squaring up. |
| `POST /household/pick-up`, `/call-it-even` | Settle a lopsided month. |
| `GET /activity` | Every change, with undo. |
| `POST /activity/:id/undo` | |

## Schedules and goals

| Route | Purpose |
|---|---|
| `GET /schedules`, `GET /schedules/new` | Recurring items and a 60-day cashflow calendar. |
| `POST /schedules/new`, `/schedules/:id/edit`, `/schedules/:id/delete`, `/schedules/:id/paid`, `/schedules/:id/skip`, `/schedules/confirm`, `/schedules/dismiss` | |
| `GET /goals`, `POST /goals/new`, `/goals/:id/edit`, `/goals/:id/complete`, `/goals/:id/delete` | |

## Loans and lending

| Route | Purpose |
|---|---|
| `GET /loans`, `GET /loans/new`, `GET /loans/what-if` | |
| `GET /loans/:id` | Cost, schedule, drift, payments, disbursements. |
| `GET /loans/:id/pay`, `POST` | Record an instalment. |
| `GET /loans/:id/prepay`, `POST` | Compare and apply reduce-tenure against reduce-instalment. |
| `GET /loans/:id/rate`, `POST` | Record a rate change. |
| `GET /loans/:id/statement`, `POST` | Record the lender's figure and resolve drift. |
| `GET /loans/:id/schedule.csv` | |
| `POST /loans/:id/disburse`, `/loans/:id/close`, `/loans/:id/settle`, `/loans/:id/holder` | |
| `GET /family`, `GET /family/:id` | Lending to and from people. |
| `POST /family/new`, `/family/:id/advance`, `/family/:id/repayment`, `/family/:id/write-off`, `/family/:id/close` | |

## Portfolio

| Route | Purpose |
|---|---|
| `GET /portfolio`, `GET /portfolio/add` | Holdings as units, XIRR, cost and market value. |
| `GET /portfolio/:id` | One holding: lots, events, returns. |
| `GET` and `POST /portfolio/:id/sell`, `/portfolio/:id/split`, `/portfolio/:id/merge`, `/portfolio/:id/price` | Sell, split, merge, record a manual price. |
| `POST /portfolio/add` | Buy: opens or adds to a holding. |
| `POST /portfolio/instrument/:id/classify` | Set asset class and region. |
| `GET /portfolio/allocation` | By class, region and currency. |
| `GET /portfolio/valuations`, `POST` | Update every hand-valued account in one pass. |
| `GET /portfolio/asset/new`, `GET /portfolio/asset/:id/revalue` and their `POST`s | |
| `GET` and `POST /portfolio/cas`, `POST /portfolio/cas/confirm` | CAS import: plan, then confirm. |
| `GET /portfolio/holdings.csv`, `/lots.csv`, `/prices.csv` | |
| `POST /portfolio/refresh` | Refresh prices from the providers. |

## Financial independence

| Route | Purpose |
|---|---|
| `GET /fire` | Target from trailing spending, drawable corpus, years at the assumed real return, and the bridge to a locked retirement balance. Assumptions are query parameters: `swr`, `ret`, `age`, `locked`. |

## Household and settings

| Route | Purpose |
|---|---|
| `GET /settings` | Household, theme, members, devices, Gmail, statement identity, notifications, API tokens. |
| `POST /settings/theme`, `GET /settings/theme-toggle` | |
| `POST /settings/overspend-model`, `/settings/identity`, `/settings/digest`, `/settings/learning` | |
| `POST /members/invite`, `GET` and `POST /members/:id/remove` | |
| `POST /budgets/personal` | Start a personal budget. |
| `GET` and `POST /tokens`, `POST /tokens/:id/revoke` | |
| `POST /sessions/revoke` | |
| `POST /impersonate/start`, `/writes`, `/exit` | Only when `ADMIN_DEBUG` is set. |
| `GET` and `POST /setup`, `POST /setup/blank` | First-run household setup. |

## Operations and public

| Route | Purpose |
|---|---|
| `GET /health` | Backups, restore verification, schema version, feature flags, stale inputs, error counts. |
| `GET /healthz` | Machine-readable; the container health check. |
| `POST /health/backup`, `POST /health/verify` | Run either by hand. |
| `POST /net-worth/snapshot` | Take a net-worth snapshot. |
| `GET /export.json`, `GET /export.csv` | Complete export, excluding secrets. |
| `GET /signin`, `POST /signout` | |
| `GET /auth/google`, `GET /auth/google/callback` | |
| `POST /demo/enter` | Only when `DEMO_MODE` is set. |
| `GET /terms`, `GET /privacy` | Public; required by Google's consent screen. |
| `GET /more` | Navigation index for narrow viewports. |

## Navigation

Primary: Budget, Accounts, Add, Review, More. Secondary, grouped under
*Analyse*: Household, Overview, Cards, Reports, Query, Schedules, Goals, Loans,
Portfolio, Net worth, Independence. Under *Manage*: Payees, Rules, Import, Activity, Health,
Settings.

On viewports below 900px the sidebar is replaced by a bottom bar and `/more`;
the budget switcher moves into the header.

## Interface conventions

- Every figure that is derived carries an explanation link.
- Colour is never the only signal; every state carries a word.
- Tap targets are at least 44px; text meets WCAG AA against its actual
  background.
- Wide tables scroll within their own container.
- Three themes: light, dark, system. The theme is applied in the first response.
