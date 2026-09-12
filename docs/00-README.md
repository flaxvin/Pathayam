# Pathayam — Functional Design Document Set

**Status:** Built · **Design frozen:** 26-08-2026 · **Owner:** Ravi
**Scope of `01`–`10`:** functional design only — no data model, no API surface, no
tech stack, no code. That boundary was useful while the design was being settled
and is preserved as written. What the build then decided lives in
`11-build-decisions.md`, the HTTP surface in `API.md`, and the engine's
arithmetic in `dev/01-engine-derivation.md`.

---

## The call

Build a **strict envelope (zero-based) budgeting app** with YNAB's engine semantics, Actual Budget's automation depth, and an ingestion layer designed for Indian banking reality (UPI, credit card cycles, SMS/email alerts). Web-first, installable as a PWA, Google SSO, shipped as a Docker container for a single household.

Three supports:

1. **The engine is the product.** Envelope semantics — rollover, overspend handling, credit-card payment envelopes — are what a budgeting app either models exactly or approximates. Get the engine exactly right and the rest is UI.
2. **Automation decides whether it survives month three.** Manual entry is where budgeting apps die. Rules, schedules, auto-assign templates and a review queue are not v2 niceties.
3. **India is a data-ingestion problem, not a currency problem.** ₹ formatting is trivial. Reconstructing a transaction ledger from UPI noise, split credit-card cycles and merchant strings like `UPI/P2M/4213/SWIGGY*ORDER` is the actual work.

---

## Scope decisions (confirmed 26-08-2026)

| Decision | Choice | Consequence in these docs |
|---|---|---|
| Audience | Me + household (a few users, one shared budget) | No billing, no tenant isolation, no support tooling. Sharing is modelled as household members on one budget, not as multi-tenancy. |
| Ingestion | All three paths, phased | Manual + CSV/statement in P0; email/SMS parsing in P1; RBI Account Aggregator as an optional adapter in P3. See `04-ingestion-and-automation.md`. |
| Deployment | Docker container | Runs anywhere — homelab, VPS, managed host. No cloud-vendor primitives assumed. Offline behaviour must survive a self-hosted box being unreachable. |
| Auth | Google SSO | Closed allow-list of household members. No password store. |
| Client | Web-first, installable PWA | iOS PWA constraints are a hard design input, not a footnote. See `02-functional-design.md` §9. |
| Doc depth | Functional only | Concepts are defined as *behaviour*, not as tables or endpoints. |
| Loan types | Home (incl. under-construction), car / personal / gold, education, credit-card EMI & BNPL | All four are first-class. See `06-loans.md`. |
| Loan disbursement | Destination set per disbursement | A builder-paid tranche raises the liability only; a personal loan into savings arrives as income. |
| Loan source of truth | App projects, lender reconciles | Full amortisation schedule for what-ifs; actual instalments carry the lender's split; drift is surfaced. |
| Prepayment default | Reduce tenure, always show both | On the worked ₹50L example, tenure reduction saves ₹9,79,407 more than EMI reduction. |
| Net worth & investments | **In scope** — reverses the original exclusion | Contained by the R30 firewall: unrealised gains are never income, net worth never appears on the budget screen. See `05` §5. |
| Holdings | Units, not rupee balances, with FIFO lots | Enables cost basis, realised/unrealised split and XIRR. |
| Price feeds | Hardcoded per asset class | MFAPI for mutual funds and Frankfurter for FX — both free, keyless, live-verified. Alpha Vantage for equities (free key, 25 calls/day). See `07` §6. |
| Multi-currency | Base ₹, per-account currency, automatic rate fetch | Transaction rates frozen at trade date; FX gain reported separately from asset gain. |
| Client data | **Strict server-only** — reverses the original offline-first design | No client storage of user data, no service worker fetch handler, no sync queue. Entry requires connectivity. Cost documented in `08` §3.3. |
| Theme | Switchable light / dark / follow-system | Stored server-side, rendered into the first response so there is no flash of the wrong theme. |
| Debug login | Dev-mode SSO bypass **and** in-app "view as", separately gated | The bypass refuses to start near production and is absent from the production build; impersonation is read-only by default and always logged. |
| Write safety | Idempotency key on every mutation | A retry on a weak connection can never create a duplicate. |
| Auditability | Immutable append-only event log | Pays for universal undo, "explain this number", as-of-date views and deterministic test fixtures. |
| Overspend model | **Both shipped** — Actual's as default, YNAB-style as a setting | Not a stub: both paths implemented in P0, because retrofitting the second reworks every stored monthly figure. |
| Statement parsers (P0) | HDFC · ICICI · Axis · SBI | Everything else falls back to generic CSV or manual. |
| Loans held | Axis personal · Union Bank education (past moratorium) · Canara | All single-disbursement. **No home loan**, so tranche drawdown and pre-EMI move to P3. |
| Notifications | **No push, no service worker** | In-app digest and health page. Backup failures alone fire an outbound webhook. |

---

## The documents

| File | What it covers | Read it when |
|---|---|---|
| `01-competitive-analysis.md` | Teardown of 10 apps, feature matrix, explicit take/drop calls with rationale | You want to know *why* a feature is in the spec |
| `02-functional-design.md` | Principles, concept glossary, the budgeting engine rules with worked ₹ examples, functional modules F1–F20, India localisation | This is the core document |
| `03-screens-and-flows.md` | Screen inventory, layout intent, user journeys J1–J9, empty and error states, mobile adaptations | You are building or reviewing UI |
| `04-ingestion-and-automation.md` | The three ingestion paths, dedupe rules, review queue, rules engine, SMS/email parsing, AA reality check | You are building import or automation |
| `05-roadmap-and-open-questions.md` | P0–P3 phasing, the MVP cut line, success criteria, open questions needing your decision | You are planning what to build first |
| `06-loans.md` | Loans and liabilities: drawdown, interest models, amortisation, prepayment, lifetime interest and interest saved. Engine rules R14–R22, module F18 | You are building loan tracking |
| `07-assets-networth-currency.md` | Assets, unit-based holdings, net worth, and multi-currency. The hardcoded price and FX APIs with verified responses. Engine rules R23–R34, modules F19–F20 | You are building the portfolio, net worth or currency layer |
| `09-decisions-log.md` | **Every open question closed.** The composite institution profile the parser matrix is built against, all Q1–Q26 answers, the add-on card mechanic, the editable-history resolution, and the revised build order | **Start here for what was actually decided** |
| `08-platform-and-operations.md` | The server-only client data policy, idempotent writes, the event log with undo and "explain this number", debug login and impersonation, theme, verified backup restore, health page, feature flags, command palette, API token. Engine rules R35–R40, modules F21–F30. **Supersedes `02` §9** | You are building the client, auth, or anything operational |
| `10-errata-and-addenda.md` | Corrections and additions to `01`–`09` found after they were frozen, kept separate rather than edited in, so the original reasoning stays readable | You are reading `01`–`09` and want to know what has since changed |
| `11-build-decisions.md` | **What the build decided, and why.** The choices `02`–`08` could not predict, the places where implementing a rule taught us something it did not say, and the one deliberate departure. Written retroactively to B24 on 28-08-2026 | You are changing the code and want to know why it is shaped this way |
| `12-saas-conversion.md` | What converting this from self-hosted to a hosted product would actually cost, measured against the code rather than guessed, and two cheaper options | You are wondering whether this could be a business |
| `13-hosted-service-plan.md` | The two plans that follow from `12` — managed single-tenant hosting and a hosted tier without Gmail — with running costs, price tiers and the number of customers that makes it viable | You are deciding whether to actually do it |
| `14-per-member-privacy.md` | Feasibility of per-member accounts and budgets, and why a private *budget* account cannot be honest | You are wondering whether money can be kept separate |
| `15-separate-budgets-design.md` | The design for personal and household budgets, with worked ₹ examples for contributions, paying on somebody's behalf, and splitting | You are building separate budgets |
| `API.md` | The HTTP surface: tokens and scopes, every route with its method and permission, the exports. Checked against the router by a test, in both directions | You are scripting against it, or adding a route |
| `dev/01-engine-derivation.md` | The accounting identity the engine must satisfy, derived, plus the known wart in viewing past months | You are changing the engine and need to know what must stay true |
| `verify_amortisation.py` | Runnable amortisation engine that re-verifies every rupee figure in `06`, plus an EMI and prepayment-comparison CLI | You want to check the loan maths, or model your own loan |
| `verify_portfolio.py` | Runnable cost-basis, FIFO, XIRR and FX-decomposition engine that re-verifies every figure in `07` | You want to check the portfolio maths |

**Reversals recorded, not deleted.** Two decisions changed during design: net worth moved from out-of-scope to in-scope (`05` §5), and the client moved from offline-first to server-only (`02` §9 → `08` §3). Both are documented as reversals with their costs and containment, so the original reasoning is still readable.

**All open questions are closed** as of 26-08-2026 — see `09-decisions-log.md`. Five answers changed the design: push dropped (no service worker at all), CAS import promoted to the primary holdings source, no home loan (drawdown leaves the critical path), add-on cards as a new mechanic, and editable history resolved against reconciliation checkpoints.

---

## Accuracy conventions used throughout

Claims about competitor products are tagged:

- **[verified]** — read from the vendor's own page or a source fetched on 26-08-2026; source linked in `01-competitive-analysis.md` §14.
- **[inferred]** — a reasonable conclusion from verified facts, not stated directly by the source.
- **[unverified]** — recalled or widely reported but not confirmed against a primary source this session. Do not quote these externally without checking.

Design decisions in `02`–`05` are proposals, not facts, and are not tagged.

---

## What is deliberately out of scope

- Tax computation of any kind. The app reports interest paid per financial year, capital gains and holding periods; it computes no liability, no deduction, and gives no advice.
- Insurance policy tracking, and any form of financial advice or recommendation.
- Bank-side or broker-side write operations. This app reads and records; it never places a trade or initiates a payment.
- Multi-tenant SaaS concerns: billing, plan limits, per-tenant encryption, DPDP-Act data-fiduciary obligations. Out of scope for a household deployment, but `04` notes where they would re-enter if you ever open it up.

*(Investment and net worth tracking were originally out of scope. That was reversed on 26-08-2026 — see `05` §5 for the reversal and the R30 containment rule that makes it safe.)*
