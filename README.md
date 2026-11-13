# Pathayam

Envelope (zero-based) budgeting for one Indian household. Self-hosted,
server-rendered, installable as a PWA. TypeScript on Node 24+, SQLite, no
runtime dependencies. Source-available: free to self-host for any
noncommercial use, every feature, no limits ([licence](#licence)).
Try it with no signup at <https://demo.pathayam.app>.

A product of [Flaxvin Technologies](https://flaxvin.tech).

*Pathayam* (പത്തായം) is the wooden granary of a Kerala house: filled once at
harvest, then drawn from carefully through the year.

```
v1.0.0 · 3200 tests · 0 runtime dependencies · 75 migrations · 252 routes
```

**Status: production-ready.** 1.0.0 is the first stable release; see
[CHANGELOG.md](CHANGELOG.md).

![The budget screen: the month grid, Ready to Assign, credit-card payment envelopes, and the in-app digest](docs/screenshots/budget.png)

## What it does

- **Envelope budgeting.** Income is assigned to envelopes until nothing is
  unassigned. Envelope balances roll over. Overspending is resolved explicitly,
  under one of two models.
- **Credit cards.** Spending on a card moves cash into that card's payment
  envelope. The interface reports how much of a card balance no envelope is
  funding, and what clears it.
- **Ask an AI about your money.** A built-in MCP server at `/mcp` lets Claude
  (claude.ai, the Claude apps, Claude Code, Claude Desktop), ChatGPT, Gemini
  CLI and other MCP clients answer questions from your household's own
  figures: where the grocery money went, whether to prepay the home loan, or
  the tax under each regime. It is read-only by default. Where the operator
  sets `AI_WRITE` and a member ticks "allow changes", it can also file, split
  and annotate transactions, and suggest new transactions, assignments and
  transfers for the member to approve in Review. It never deletes anything.
  Each connection sees only what its member sees, and masks account numbers,
  UPI IDs, phone numbers and PAN by default. Every question and change is
  logged, and every change can be undone.
- **Indian banking.** Statement PDFs from twelve banks, with passwords derived
  from name, date of birth, PAN, mobile and customer ID. UPI narration
  parsing. Reducing-balance and flat loans, rate changes, prepayment
  comparison, EMI conversion (with the 18% GST on each instalment's interest charged as its own card
  line). CAS portfolio import. Realised gains by financial year.
- **Deposits that value themselves.** An FD, RD, PPF or EPF account given its
  terms (principal or instalment, rate, compounding, start and maturity) is
  valued from them through to maturity, and the maturity shows on the account,
  the cashflow calendar and the overview. A newer value entered by hand still
  takes precedence.
- **Coming from another app.** YNAB and Actual Budget CSV exports are
  recognised on the import screen and land in Review with their transfers and
  splits intact.
- **Per-member privacy.** A shared household budget plus an optional personal
  budget per member, excluded from the other members' lists, reports, exports,
  activity log and totals.
- **Schedules that split.** A salary into provident fund, tax and what landed;
  rent into rent and maintenance. The first envelope takes whatever the later
  lines do not claim, so a recurring split cannot be quietly wrong every month,
  and marking the schedule paid records a split transaction.
- **Tax estimate.** Income tax under both regimes, side by side, with 80C, 80D
  and the HRA exemption, and capital gains at their own rates rather than at
  slab rates. It is an estimate based on the figures you enter, and is neither
  a tax return nor advice.
  Home-loan interest under 24(b) comes from the loan ledger; TDS, advance tax
  and self-assessment payments are netted to a balance due or a refund; each
  advance-tax instalment is checked against what was paid by its date. FY
  2024-25 gains are split at 23-07-2024, and listed bonds held over a year
  are taxed at 12.5%. Slabs are data keyed by financial year, so a year the
  app does not have rates for is refused rather than computed with last year's.
- **Financial independence.** A target based on what the household actually
  spent, measured against the assets that could fund it (your home belongs on
  the net worth statement, not here). It assumes no further earnings, and
  reports the years a locked provident fund leaves uncovered.
- **Insurance and paper.** A policy register with premiums due, renewals and
  the 80C / 80D they suggest for the tax estimate. The tax estimate, reports,
  month close, net worth and a loan's schedule print as documents.
- **Ownership.** One SQLite file in an open format, a complete export and no
  telemetry. No third-party service holds your data unless you connect an AI
  yourself, and none is needed to sign in. Password sign-in is built in, any
  OpenID Connect provider works, and Google is optional.

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

Configuration, sign-in (password, OpenID Connect or Google), backups and restore: [docs/operations.md](docs/operations.md). A box with no tunnel or proxy in front can serve HTTPS itself, with a Let's Encrypt certificate it renews on its own ([HTTPS without a proxy](docs/operations.md#https-without-a-proxy)).

### Connect an AI

Claude, ChatGPT, Gemini and other MCP clients connect to `<your Pathayam address>/mcp`:

- **claude.ai, the Claude apps, ChatGPT, the Gemini app:** add a custom
  connector with that address. The app sends you to Pathayam to sign in and
  approve it (OAuth 2.1 with PKCE; access lasts an hour and renews). The
  Gemini app offers custom apps only where Google has rolled them out.
- **Claude Code, Gemini CLI, Claude Desktop:** make a token on **Settings →
  API tokens → Connect an AI** (`/tokens/ai`), which shows the command or
  config to paste. These tokens expire after 30, 90 or 365 days.

```bash
claude mcp add --transport http pathayam https://budget.example.in/mcp \
  --header "Authorization: Bearer <token>"
```

Seventeen read-only tools cover the overview, accounts, transactions, the
month's budget, spending, loans and their schedules, portfolio, realised gains,
net worth, the tax estimate, cashflow, insurance, goals, financial
independence, *explain this number*, and a snapshot. With `AI_WRITE=standard`
or `full` and "allow changes" ticked for a connection, seven more tools file,
split and annotate transactions and propose a payee's envelope directly. They
also add transactions, assign money and record transfers: as suggestions
waiting in Review under `standard`, or directly under `full`. Each connection
can make at most 100 changes a day, all shown in Activity, and one button undoes
an AI's whole day
([docs/ai.md](docs/ai.md#changes-an-ai-can-make)). A connection reads as the
member who approved it: the household budget and their own, never another
member's private accounts. Masking of account numbers, UPI IDs, phone numbers
and PAN is on by default per connection, and is best effort. The Connect an AI
page lists every question each app asked (not the answers) and disconnects any
of them.

What an AI reads is sent to that AI's provider. On a self-hosted instance,
nothing leaves unless you connect something. Without connecting anything,
`/export/analysis.json` downloads a summary (a year of budget, spending by
envelope, accounts, loans, portfolio and tax, without the transaction list)
that you can paste into any chat or spreadsheet.

`FEATURE_AI=false` switches AI connections off entirely: `/mcp`, the sign-in
from an AI app, the Connect an AI page and `/export/analysis.json` all answer
404. The hosted Solo plan
runs that way; self-hosted and the Household and Power plans have it on.

## Plans and modules

One variable sets what an instance offers. `PLAN=solo`, `household` or
`power` applies the hosted tier's limits, and leaving it unset is
self-hosted, with everything on. Each module can also be switched on its own
with `FEATURE_*` (loans, family lending, investments and net worth, deposits,
insurance, goals, tax, reports, schedules, rules, receipts, the three import
paths, Gmail with the deployment's Google client, Gmail with your own Google
keys, API tokens, AI connections and multi-currency). `MAX_MEMBERS`
and `BACKUP_RETENTION_DAYS` set the limits. A module that is off disappears
from every page and keeps its data. The full table, with each plan's values,
is in [docs/operations.md](docs/operations.md#plans-and-modules).

| | Self-host | Solo | Household | Power |
|---|---|---|---|---|
| Members | unlimited | 1 | 5 | unlimited |
| Backup retention | 14 newest | 30 days | 90 days | 1 year |
| Loans, investments, net worth | ✓ | — | ✓ | ✓ |
| API tokens, AI connections | ✓ | — | ✓ | ✓ |
| Gmail, with your own Google keys | ✓ | ✓ | ✓ | ✓ |
| Gmail, with the deployment's Google client | ✓ | — | — | — |

Gmail works on every plan once a member, or the household, adds a Google
Cloud OAuth client of their own in Settings → Gmail. The secret is sealed with
`SECRETS_KEY` before it is stored. Making the client takes about ten minutes:
[Create your Google OAuth client](https://pathayam.app/guides.html#gmail-keys).

**Deploying: set `SECRETS_KEY` once per instance.** At least 32 characters
(`openssl rand -base64 32`); it seals the Google client secrets and Gmail
refresh tokens the instance stores. Docker: put it in `.env` beside
`compose.yaml` (see [`.env.example`](.env.example)). Fly.io:
`fly secrets set SECRETS_KEY="$(openssl rand -base64 32)" -a <app>`, then
`fly secrets list -a <app>` to confirm. Keep it outside the data volume; losing
it means re-entering Google keys and reconnecting Gmail, nothing more. Details
in [docs/operations.md](docs/operations.md#on-flyio).

## Documentation

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Process model, modules, request lifecycle, storage. |
| [docs/data-model.md](docs/data-model.md) | Every table and its columns. |
| [docs/budgeting.md](docs/budgeting.md) | Engine definitions, formulas, overspend models, targets. |
| [docs/accounts.md](docs/accounts.md) | Account kinds, transactions, transfers, splits, reconciliation. |
| [docs/money-in.md](docs/money-in.md) | CSV, YNAB and Actual Budget, PDF statements, Gmail, duplicates, rules. |
| [docs/loans-and-assets.md](docs/loans-and-assets.md) | Loans, lending, deposits, insurance, portfolio, net worth, tax, financial independence. |
| [docs/privacy.md](docs/privacy.md) | Visibility model and enforcement. |
| [docs/security.md](docs/security.md) | Authentication, authorisation, headers, input handling. |
| [docs/screens.md](docs/screens.md) | Every route, and what prints. |
| [docs/operations.md](docs/operations.md) | Deployment, configuration, backup, restore. |
| [docs/testing.md](docs/testing.md) | Running and reading the suite. |
| [docs/limitations.md](docs/limitations.md) | Known constraints. |
| [docs/API.md](docs/API.md) | HTTP API and access tokens. |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release. |

[`docs/archive/`](docs/archive/) holds the original design specification, cited
from source comments by requirement identifier.

## Verification

Three invariants are checked mechanically rather than against expected values:

1. **The accounting identity:** zero residual, in integer paise, for every
   month in every budget:

   ```
   Σ budget-account balances  +  due from other budgets
       =  Σ category balances  +  Ready to Assign  +  held for next month
          +  Σ future assignments  −  unfunded credit absorbed
   ```

2. **Cache against ledger:** every month computed from the rollup cache and
   from the raw ledger, and required to agree.

3. **Statement reconciliation:** a parsed statement's amounts must satisfy the
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
| **Add** | `/add` | One form for money in, money out and transfers. Envelopes are a list of lines, the first taking the remainder; an expense must name one, income may leave it blank and land in Ready to Assign. |
| **Move money** | `/move` | Move between envelopes, with a note explaining that this never changes Ready to Assign. |
| **Hold** | `/hold` | Keep part of this month’s Ready to Assign for next month. This is how you move to spending last month’s income. |
| **Review** | `/review` | Everything awaiting a decision: imports, suspected duplicates, uncategorised (filed inline), overspent, unfunded cards, proposed rules, and money you're owed. |
| **Import** | `/import` | CSV paste / statement-PDF upload with password hints; saved mappings; YNAB and Actual Budget exports. |
| **Reports** | `/reports` | Income vs. spend, category trends, loan interest by FY, realised gains by FY split by holding period. |
| **Overview** | `/overview` | Runway, due-soon bills, the month at a glance. |
| **Query** | `/query` | The filterable, groupable table; CSV export. Totals are summed over every matching row, not the page you can see. |
| **Search** | `/search` | Everything, from one box, reachable with `/` from any screen. |
| **Schedules** | `/schedules` | Recurring items and the forward cashflow calendar. |
| **Goals** | `/goals` | Long-horizon savings with progress rings. |
| **Loans** | `/loans`, `/loans/:id` | Each loan's real cost, schedule, drift, prepayment calculator, disbursements. |
| **Family lending** | `/family` | Lent / borrowed, derived balances, write-off. |
| **Tax** | `/tax` | Both regimes side by side, capital gains at their own rates, 24(b) from the loan ledger, tax paid netted, and the advance-tax instalment check. |
| **Financial independence** | `/fire` | A target from what the household spent, against the assets that could fund it, and the years a locked provident fund leaves uncovered. |
| **Insurance** | Policies, premiums and renewals due, 80C / 80D from your policies. |
| **Portfolio** | `/portfolio` | Holdings as units, XIRR, allocation, CAS import, CSV export. |
| **Valuations** | `/portfolio/valuations` | Every hand-valued pot (gold, retirement, anything outside CAS), updated in one sitting, each showing what it was last worth and when. |
| **Net worth** | `/net-worth` | Statement groups, what changed since the last snapshot (in seven parts that add up to the total), and dated history. |
| **Month close** | `/months` | The monthly ritual and closed-month history. |
| **Payees** | `/payees` | Every payee, what it is usually filed as, and merge. |
| **Rules** | `/rules` | Automatic categorisation: what fires, what the app has proposed from your own filing, and a tester. |
| **Categories** | `/categories` | Rename, set targets, reorder with ↑/↓, hide, delete. Payment and goal envelopes are marked *managed by the app*. |
| **Activity** | `/activity` | Every change ever made, and the undo for it. Where later edits touched the same record, the undo shows what it would discard first. |
| **Connect an AI** | `/tokens/ai` | Connect Claude, ChatGPT or Gemini: the MCP address, a token with copy-paste commands, masking per connection, every question each app asked, and disconnect. |
| **Settings** | `/settings` | Household, theme, devices, Gmail connection, statement identity, notification prefs, API tokens. |
| **Health** | `/health` | Backup status, restore verification, price feeds, feature flags, error counts. |
| **Terms / Privacy** | `/terms`, `/privacy` | Public and signed out. Google's consent screen requires both before it grants `gmail.readonly`. |

### Screenshots

Captured from a running instance with the 36-month demo household, dark theme.

| Portfolio | Net worth |
|---|---|
| [![Portfolio: holdings as units, XIRR, other assets](docs/screenshots/portfolio.png)](docs/screenshots/portfolio.png) | [![Net worth: statement groups, the change breakdown, and dated history](docs/screenshots/net-worth.png)](docs/screenshots/net-worth.png) |
| **Allocation** | **Loans** |
| [![Allocation: by class, region and currency](docs/screenshots/allocation.png)](docs/screenshots/allocation.png) | [![Loans: real cost, schedule, drift, prepayment](docs/screenshots/loans.png)](docs/screenshots/loans.png) |

| One loan | A rate reset |
|---|---|
| [![One loan: where it stands, how it pays down, and every instalment recorded against the lender's own split](docs/screenshots/loan.png)](docs/screenshots/loan.png) | [![A rate change with both options the lender must offer, priced side by side and selectable](docs/screenshots/loan-rate.png)](docs/screenshots/loan-rate.png) |

| What a prepayment buys | A charge becoming an EMI |
|---|---|
| [![The prepayment comparison: reduce the tenure against reduce the EMI, with the saving on each](docs/screenshots/loan-prepay.png)](docs/screenshots/loan-prepay.png) | [![A card charge with the form that converts it into an instalment plan](docs/screenshots/convert-to-emi.png)](docs/screenshots/convert-to-emi.png) |
| **Accounts** | **Review queue** |
| [![Accounts: cleared / uncleared / working balances](docs/screenshots/accounts.png)](docs/screenshots/accounts.png) | [![Review: imports, duplicates, uncategorised, proposed rules](docs/screenshots/review.png)](docs/screenshots/review.png) |
| **Import** | **Schedules** |
| [![Import: CSV paste and statement-PDF upload with password hints](docs/screenshots/import.png)](docs/screenshots/import.png) | [![Schedules: recurring items and the forward cashflow calendar](docs/screenshots/schedules.png)](docs/screenshots/schedules.png) |
| **Goals** | **Reports** |
| [![Goals: long-horizon savings with progress rings](docs/screenshots/goals.png)](docs/screenshots/goals.png) | [![Reports: income vs spend, category trends, loan interest by FY](docs/screenshots/reports.png)](docs/screenshots/reports.png) |
| **Health** | **Settings** |
| [![Health: backups, restore verification, price feeds, feature flags](docs/screenshots/health.png)](docs/screenshots/health.png) | [![Settings: household, Gmail, statement identity, API tokens](docs/screenshots/settings.png)](docs/screenshots/settings.png) |
| **Categories** | **Overview** |
| [![Categories: targets, reorder arrows, and app-managed envelopes](docs/screenshots/categories.png)](docs/screenshots/categories.png) | [![Overview: runway, due-soon bills, and the month at a glance](docs/screenshots/overview.png)](docs/screenshots/overview.png) |
| **Activity** | **Cards** |
| [![Activity: every change, with its undo and the reason when it has none](docs/screenshots/activity.png)](docs/screenshots/activity.png) | [![Cards: every card in the order it falls due, with what is unfunded](docs/screenshots/cards.png)](docs/screenshots/cards.png) |
| **Query** | **Valuations** |
| [![Query: the filterable, groupable table, with totals over every matching row](docs/screenshots/query.png)](docs/screenshots/query.png) | [![Valuations: every hand-valued pot updated in one sitting](docs/screenshots/valuations.png)](docs/screenshots/valuations.png) |
| **Tax** | **Insurance** |
| [![Tax: both regimes side by side, capital gains, tax paid and the advance-tax instalments](docs/screenshots/tax.png)](docs/screenshots/tax.png) | [![Insurance: policies, premiums due and the 80C / 80D they suggest](docs/screenshots/insurance.png)](docs/screenshots/insurance.png) |

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

| Allocation: donuts by class, geography and currency |
|---|
| [![Portfolio allocation as donut charts by asset class, geography and currency](docs/screenshots/charts_allocation.png)](docs/screenshots/charts_allocation.png) |

| Loans: the amortisation curve and tranche drawdown | Reports: income vs spend, net saved |
|---|---|
| [![A loan's projected balance falling to zero over its remaining schedule](docs/screenshots/charts_loan.png)](docs/screenshots/charts_loan.png) | [![Grouped income-versus-spending bars and a net-saved line by month](docs/screenshots/charts_reports.png)](docs/screenshots/charts_reports.png) |

| Schedules: the next 60 days of cashflow | Goals: progress rings |
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
- No offline mode beyond the Add form, which keeps an entry on the device until
  the signal returns; everything else requires the server.
- Payee names extracted from some statement PDFs contain spaces inside words.
- The app does not encrypt the database file itself; encryption at rest comes from the disk (an encrypted volume on the hosted service).

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

You may use, change and share it **for any noncommercial purpose**: your own
household, study, research, a hobby project, a charity, a school or a
government body. All of this is permitted, with no limits.

**Commercial use is not permitted** under this licence. That includes running it
inside a business, using it to keep the books of a company or a freelance
practice, and offering it to anyone else as a product or service. If you want
to use it commercially, ask: <hello@flaxvin.tech>.

Pathayam is source-available, and the noncommercial limit does not expire.
