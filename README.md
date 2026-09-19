# Pathayam

Envelope (zero-based) budgeting for one Indian household. Self-hosted,
server-rendered, installable as a PWA. TypeScript on Node 24+, SQLite, no
runtime dependencies.

*Pathayam* (പത്തായം) is the wooden granary of a Kerala house: filled once at
harvest, drawn from deliberately through the year.

```
1,119 tests · 0 runtime dependencies · 37 migrations · 162 routes
```

![The budget screen: the month grid, Ready to Assign, credit-card payment envelopes, and the in-app digest](docs/screenshots/budget.png)

## What it does

- **Envelope budgeting.** Income is assigned to envelopes until nothing is
  unassigned. Envelope balances roll over. Overspending is resolved explicitly,
  under one of two models.
- **Credit cards.** Spending on a card moves cash into that card's payment
  envelope. The interface reports how much of a card balance no envelope is
  funding, and what clears it.
- **Indian banking.** Statement PDFs from eleven banks, with passwords derived
  from name, date of birth, PAN and mobile. UPI narration parsing. Reducing-
  balance and flat loans, rate changes, prepayment comparison, EMI conversion.
  CAS portfolio import. Realised gains by financial year.
- **Per-member privacy.** A shared household budget plus an optional personal
  budget per member, excluded from the other members' lists, reports, exports,
  activity log and totals.
- **Financial independence.** A target drawn from what the household actually
  spent, against the assets that could actually fund it — a home is on the net
  worth statement, not here. Assumes no further earnings, and reports the years
  a locked provident fund leaves uncovered.
- **Ownership.** One SQLite file in an open format, complete export, no
  telemetry, no third-party service holding the data — and no third-party
  service needed to sign in, either. Password sign-in is built in; Google is
  optional.

## Quick start

```bash
npm install
npm run dev                  # http://localhost:8080
```

With 36 months of generated data:

```bash
DATA_DIR=./demo-data npm run demo
DATA_DIR=./demo-data DEMO_MODE=1 npm run dev
```

With Docker:

```bash
docker compose up -d                  # production; requires BASE_URL in .env
docker compose --profile dev up       # development, with the login bypass
```

Configuration, Google sign-in, backups and restore: [docs/operations.md](docs/operations.md).

## Documentation

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Process model, modules, request lifecycle, storage. |
| [docs/data-model.md](docs/data-model.md) | Every table and its columns. |
| [docs/budgeting.md](docs/budgeting.md) | Engine definitions, formulas, overspend models, targets. |
| [docs/accounts.md](docs/accounts.md) | Account kinds, transactions, transfers, splits, reconciliation. |
| [docs/money-in.md](docs/money-in.md) | CSV, PDF statements, Gmail, duplicates, rules. |
| [docs/loans-and-assets.md](docs/loans-and-assets.md) | Loans, lending, portfolio, net worth. |
| [docs/privacy.md](docs/privacy.md) | Visibility model and enforcement. |
| [docs/security.md](docs/security.md) | Authentication, authorisation, headers, input handling. |
| [docs/screens.md](docs/screens.md) | Every route. |
| [docs/operations.md](docs/operations.md) | Deployment, configuration, backup, restore. |
| [docs/testing.md](docs/testing.md) | Running and reading the suite. |
| [docs/limitations.md](docs/limitations.md) | Known constraints. |
| [docs/API.md](docs/API.md) | HTTP API and access tokens. |

[`docs/archive/`](docs/archive/) holds the original design specification, cited
from source comments by requirement identifier.

## Verification

Three invariants are checked mechanically rather than against expected values:

1. **The accounting identity** — zero residual, in integer paise, for every
   month in every budget:

   ```
   Σ budget-account balances  +  due from other budgets
       =  Σ category balances  +  Ready to Assign  +  held for next month
          +  Σ future assignments  −  unfunded credit absorbed
   ```

2. **Cache against ledger** — every month computed from the rollup cache and
   from the raw ledger, and required to agree.

3. **Statement reconciliation** — a parsed statement's amounts must satisfy the
   bank's own printed opening and closing balances.

A 36-month simulation of a household of four exercises every mutating domain
function and asserts (1) and (2) after each month. Details:
[docs/testing.md](docs/testing.md).

## Screens

| Screen | Route | What you see |
|---|---|---|
| **Budget** | `/` | The month grid: groups, categories, assigned/activity/available, Ready to Assign, the in-app digest. |
| **Accounts** | `/accounts` | Every account with cleared/uncleared/working balances; each opens a register. |
| **Cards** | `/cards` | Every credit card in the order it falls due: what is owed, what is set aside, what has nothing behind it, and the statement and due date when one has been recorded. |
| **Register** | `/accounts/:id` | A running-balance transaction list for one account, with reconcile. |
| **Transaction** | `/transaction/:id` | Edit, splits, tags, owner; raw imported values; full event history; **receipts**. |
| **Add** | `/add` | One form for money in, money out and transfers. An expense must name its envelope. |
| **Move money** | `/move` | Move between envelopes, with a note explaining that this never changes Ready to Assign. |
| **Hold** | `/hold` | Keep part of this month’s Ready to Assign for next month — how you get to spending last month’s income. |
| **Review** | `/review` | Everything awaiting a decision: imports, suspected duplicates, uncategorised (filed inline), overspent, unfunded cards, proposed rules, and money you're owed. |
| **Import** | `/import` | CSV paste / statement-PDF upload with password hints; saved mappings. |
| **Reports** | `/reports` | Income vs. spend, category trends, loan interest by FY, realised gains by FY split by holding period. |
| **Overview** | `/overview` | Runway, due-soon bills, the month at a glance. |
| **Query** | `/query` | The filterable, groupable table; CSV export. Totals are summed over every matching row, not the page you can see. |
| **Search** | `/search` | Everything, from one box — reachable with `/` from any screen. |
| **Schedules** | `/schedules` | Recurring items and the forward cashflow calendar. |
| **Goals** | `/goals` | Long-horizon savings with progress rings. |
| **Loans** | `/loans`, `/loans/:id` | Each loan's real cost, schedule, drift, prepayment calculator, disbursements. |
| **Family lending** | `/family` | Lent / borrowed, derived balances, write-off. |
| **Portfolio** | `/portfolio` | Holdings as units, XIRR, allocation, CAS import, CSV export. |
| **Valuations** | `/portfolio/valuations` | Every hand-valued pot — gold, retirement, anything outside CAS — updated in one sitting, each showing what it was last worth and when. |
| **Net worth** | `/net-worth` | The four-way decomposition and dated history. |
| **Month close** | `/months` | The monthly ritual and closed-month history. |
| **Payees** | `/payees` | Every payee, what it is usually filed as, and merge. |
| **Rules** | `/rules` | Automatic categorisation: what fires, what the app has proposed from your own filing, and a tester. |
| **Categories** | `/categories` | Rename, set targets, reorder with ↑/↓, hide, delete. Payment and goal envelopes are marked *managed by the app*. |
| **Activity** | `/activity` | Every change ever made, and the undo for it. Where later edits touched the same record, the undo shows what it would discard first. |
| **Settings** | `/settings` | Household, theme, devices, Gmail connection, statement identity, notification prefs, API tokens. |
| **Health** | `/health` | Backup status, restore verification, price feeds, feature flags, error counts. |
| **Terms / Privacy** | `/terms`, `/privacy` | Public, signed out — Google's consent screen requires both before it grants `gmail.readonly`. |

### Screenshots

Captured from a running instance with the 36-month demo household, dark theme.

| Portfolio | Net worth |
|---|---|
| [![Portfolio — holdings as units, XIRR, other assets](docs/screenshots/portfolio.png)](docs/screenshots/portfolio.png) | [![Net worth — the four-way decomposition and dated history](docs/screenshots/net-worth.png)](docs/screenshots/net-worth.png) |
| **Allocation** | **Loans** |
| [![Allocation — by class, region and currency](docs/screenshots/allocation.png)](docs/screenshots/allocation.png) | [![Loans — real cost, schedule, drift, prepayment](docs/screenshots/loans.png)](docs/screenshots/loans.png) |

| One loan | A rate reset |
|---|---|
| [![One loan — where it stands, how it pays down, and every instalment recorded against the lender's own split](docs/screenshots/loan.png)](docs/screenshots/loan.png) | [![A rate change with both options the lender must offer, priced side by side and selectable](docs/screenshots/loan-rate.png)](docs/screenshots/loan-rate.png) |

| What a prepayment buys | A charge becoming an EMI |
|---|---|
| [![The prepayment comparison: reduce the tenure against reduce the EMI, with the saving on each](docs/screenshots/loan-prepay.png)](docs/screenshots/loan-prepay.png) | [![A card charge with the form that converts it into an instalment plan](docs/screenshots/convert-to-emi.png)](docs/screenshots/convert-to-emi.png) |
| **Accounts** | **Review queue** |
| [![Accounts — cleared / uncleared / working balances](docs/screenshots/accounts.png)](docs/screenshots/accounts.png) | [![Review — imports, duplicates, uncategorised, proposed rules](docs/screenshots/review.png)](docs/screenshots/review.png) |
| **Import** | **Schedules** |
| [![Import — CSV paste and statement-PDF upload with password hints](docs/screenshots/import.png)](docs/screenshots/import.png) | [![Schedules — recurring items and the forward cashflow calendar](docs/screenshots/schedules.png)](docs/screenshots/schedules.png) |
| **Goals** | **Reports** |
| [![Goals — long-horizon savings with progress rings](docs/screenshots/goals.png)](docs/screenshots/goals.png) | [![Reports — income vs spend, category trends, loan interest by FY](docs/screenshots/reports.png)](docs/screenshots/reports.png) |
| **Health** | **Settings** |
| [![Health — backups, restore verification, price feeds, feature flags](docs/screenshots/health.png)](docs/screenshots/health.png) | [![Settings — household, Gmail, statement identity, API tokens](docs/screenshots/settings.png)](docs/screenshots/settings.png) |
| **Categories** | **Overview** |
| [![Categories — targets, reorder arrows, and app-managed envelopes](docs/screenshots/categories.png)](docs/screenshots/categories.png) | [![Overview — runway, due-soon bills, and the month at a glance](docs/screenshots/overview.png)](docs/screenshots/overview.png) |
| **Activity** | **Cards** |
| [![Activity — every change, with its undo and the reason when it has none](docs/screenshots/activity.png)](docs/screenshots/activity.png) | [![Cards — every card in the order it falls due, with what is unfunded](docs/screenshots/cards.png)](docs/screenshots/cards.png) |
| **Query** | **Valuations** |
| [![Query — the filterable, groupable table, with totals over every matching row](docs/screenshots/query.png)](docs/screenshots/query.png) | [![Valuations — every hand-valued pot updated in one sitting](docs/screenshots/valuations.png)](docs/screenshots/valuations.png) |

Every figure, name and account number is generated. No real financial data
appears in this repository.

To regenerate after a UI change:

```bash
DATA_DIR=./demo-data npm run demo
DATA_DIR=./demo-data DEMO_MODE=1 PORT=8080 npm run dev
node docs/dev/capture-screenshots.mjs --port 8080
```

It drives headless Chromium over the DevTools protocol with no driver library,
signs in through the demo or development door, and removes the deployment
banner so the images document the application rather than the instance.

### Charts

Every chart is server-rendered inline SVG. There is no client-side charting
library; the CSP forbids third-party script. Charts follow the theme and each
sits beside the same figures as text.

| Allocation — donuts by class, geography and currency |
|---|
| [![Portfolio allocation as donut charts by asset class, geography and currency](docs/screenshots/charts_allocation.png)](docs/screenshots/charts_allocation.png) |

| Loans — the amortisation curve and tranche drawdown | Reports — income vs spend, net saved |
|---|---|
| [![A loan's projected balance falling to zero over its remaining schedule](docs/screenshots/charts_loan.png)](docs/screenshots/charts_loan.png) | [![Grouped income-versus-spending bars and a net-saved line by month](docs/screenshots/charts_reports.png)](docs/screenshots/charts_reports.png) |

| Schedules — the next 60 days of cashflow | Goals — progress rings |
|---|---|
| [![A forward cashflow calendar over the next sixty days](docs/screenshots/charts_cashflow.png)](docs/screenshots/charts_cashflow.png) | [![A savings goal drawn as a progress ring against its target date](docs/screenshots/charts_goals.png)](docs/screenshots/charts_goals.png) |

Reports carries four more that are easier to read in place than cropped out: a
spending **treemap**, a GitHub-style **spending calendar** heatmap, a **Sankey**
of where the month's money went, and a **sparkline** per category. Net worth adds
an asset-composition donut and a net-worth-over-time line. All of them are in the
full-page [Reports](docs/screenshots/reports.png) and
[Net worth](docs/screenshots/net-worth.png) captures.


---

## Limitations

Fully listed in [docs/limitations.md](docs/limitations.md). The principal ones:

- Past months are recomputed from current data rather than frozen; closed months
  record their figures.
- No bank API connections and no SMS parsing.
- No offline mode; the application requires its server.
- Payee names extracted from some statement PDFs contain spaces inside words.
- The database is not encrypted at rest.

## Contributing

```bash
npm run typecheck
npm test
```

Both must pass. New behaviour requires a test that fails without it. Changes
affecting money must leave the accounting identity closing.

Contributions are licensed to Flaxvin Technologies so the licence can be
granted on other terms where needed. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Supporting the project

Pathayam is free to run yourself and always will be. If it saves you money or
time and you would like to put something back:

<img src="docs/img/upi-qr.png" alt="UPI QR code for febinnizar-1@okaxis" width="180" height="180">

**UPI:** `febinnizar-1@okaxis` — or
[tap to pay](upi://pay?pa=febinnizar-1@okaxis&pn=Febin%20Nizar&cu=INR) on a
phone with a UPI app installed.

Entirely optional. Nothing in the software is gated behind it, no feature
depends on it, and nothing asks you for it again. Contributions are a thank-you
to the author rather than a purchase — you get no goods, service or support in
return, and they are not tax-deductible.

## Licence

[PolyForm Noncommercial License 1.0.0](LICENSE.md).

Use it, change it and share it **for any noncommercial purpose** — your own
household, study, research, a hobby project, a charity, a school, a government
body. All of that is permitted, with no limits and nothing withheld.

**Commercial use is not permitted** under this licence. That includes running it
inside a business, using it to keep the books of a company or a freelance
practice, and offering it to anyone else as a product or service. If you want
to use it commercially, ask: <hello@flaxvin.tech>.

Source available, not open source. The noncommercial limit is the difference,
and it does not expire.
