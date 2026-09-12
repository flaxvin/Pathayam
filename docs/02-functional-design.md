# 02 · Functional Design

**Draft v0.1 · 26-08-2026 · Functional scope only.**
Behaviour is specified here. Storage, schema, APIs and stack are not.

---

## 1. Product statement

A strict envelope budgeting app for one household, where every rupee currently held is assigned to a named purpose before it is spent, transactions arrive with as little manual typing as Indian banking allows, and both partners see the same numbers on their phones within seconds of either one spending.

**It succeeds if:** at any moment, the household can answer *"can I spend ₹4,000 on this right now, and what does it cost me?"* in under five seconds, and the answer is trustworthy.

**Non-goals:** investment tracking, tax filing, net worth reporting, bill payment, lending, advice.

---

## 2. Principles

| # | Principle | What it forbids |
|---|---|---|
| P1 | **Only money you have.** The budget is backed by cleared and pending cash in real accounts. | Budgeting projected salary. Negative Ready to Assign hidden from view. |
| P2 | **Never block, always warn.** The app has no authority to prevent spending. | Hard stops, refused entries, guilt modals. |
| P3 | **Every automated decision is reversible and attributable.** Any value the app set, it can show you why, and you can undo it. | Silent ML recategorisation. Unexplained auto-assign. Destructive import merges. |
| P4 | **The original record is never overwritten.** Imported payee, imported amount, imported date and source are preserved alongside the cleaned values. | Cleanup that loses the raw string. |
| P5 | **Household-symmetric.** No owner/viewer hierarchy. Both members can do everything; every change is attributed. | Per-seat pricing artefacts, read-only spouses, approval workflows. |
| P6 | **The server is the only place data lives.** Nothing about the household is persisted on any device. *(Revised 26-08-2026 — this replaced an offline-first principle; see `08` §3.)* | Any client-side storage of user data. A read cache. A sync queue. Papering over a failed request with a stale value. |
| P7 | **Your data leaves whenever you want it.** Complete export in an open format, on demand, including all history. | Lossy export, export behind a paywall or a support ticket. |
| P8 | **Read-only against the outside world.** The app never initiates a payment or writes to a bank. | Any payment rail integration. |
| P9 | **Every change is an event.** Nothing mutates without an append-only, attributed log entry — which is what makes undo, "explain this number" and as-of-date views possible (`08` R37). | Silent mutation. Edits that erase what was there before. |

---

## 3. Concept glossary

Definitions are behavioural. They are not table specifications.

| Concept | Definition |
|---|---|
| **Budget** | The single shared plan for the household. Exactly one exists. |
| **Household member** | A Google-authenticated person on the allow-list. All members are peers (P5). |
| **Account** | A real place money sits or is owed. Three kinds: **Budget accounts** (savings, current, cash-in-hand, prepaid wallets — their balances fund the budget), **Credit accounts** (credit cards — spending here creates a liability and consumes envelope money, see R6), **Tracking accounts** (loans, EMIs, deposits, anything you want a balance for but which does not fund envelopes). |
| **Category / Envelope** | A named purpose money is assigned to. Used interchangeably in this doc; UI says "category". |
| **Category group** | An ordered collection of categories. Groups are for layout and subtotals only; money lives in categories. |
| **Assignment** | Moving an amount into a category for a specific month. The atomic budgeting act. |
| **Ready to Assign (RTA)** | Money held in Budget accounts that has not yet been assigned to any category, for the current month. See R2. |
| **Category balance** | Money currently sitting in that envelope: opening balance + assigned this month − activity this month. |
| **Activity** | Sum of transactions hitting that category in that month. |
| **Target** | A stated intention for a category — how much should be in it, by when. Drives the *underfunded* figure. |
| **Auto-assign rule** | A machine-executable version of a target, used to fill the month in one action. See R9. |
| **Transaction** | A dated movement of money against exactly one account, with a payee, a category (or splits), an amount, an optional memo, tags, and an owner. |
| **Split** | A transaction divided across two or more categories. Splits must sum to the transaction total. |
| **Transfer** | A paired movement between two accounts. Uncategorised by default, except transfers to Credit accounts, which are payments (R6). |
| **Payee** | The counterparty. Has a cleaned display name and retains every raw imported string ever mapped to it (P4). |
| **Tag** | A free label orthogonal to categories. A transaction may carry many. Used for trips, reimbursables, per-person analysis. |
| **Schedule** | A declared future/recurring transaction with a due date, amount (fixed or estimated), account and category. Feeds the cashflow calendar and can feed auto-assign. |
| **Rule** | A condition→action automation applied to incoming transactions. See F6. |
| **Goal (piggy bank)** | A long-horizon savings intention tracked against one or more categories, shown outside the monthly view. |
| **Reconciliation** | An assertion that an account's cleared balance in the app equals the bank's stated balance on a date, creating a locked checkpoint. |
| **Review queue** | The staging area where imported/parsed transactions wait for human confirmation before entering the ledger. |
| **Buffer** | How many days of typical spending the household could cover from money already assigned. Replaces YNAB's Age of Money. See R12. |
| **Loan** | A liability with a sanction, disbursement history, rate model and repayment schedule. A specialisation of the Tracking account kind. Defined fully in `06-loans.md` §3. |
| **Loan payment category** | An auto-created envelope, one per loan, holding money reserved for that loan's instalments. Symmetric with the credit-card payment category (R6). |
| **Asset account** | A Tracking account holding something of value — investments, retirement balances, deposits, property. Never funds the budget. Defined fully in `07-assets-networth-currency.md` §3. |
| **Holding** | A position in one instrument, recorded as units with dated purchase lots, not as a rupee balance. |
| **Base currency** | The household's reporting currency (₹). Every envelope, target and Ready to Assign figure is in it, always. |
| **Net worth** | Total assets − total liabilities at a point in time. Lives on its own screen and never appears on the budget screen (`07` R30). |

---

## 4. The budgeting engine

The rules below are normative. Where a competitor does it differently, that is noted. Worked examples use ₹.

---

### R1 — You may only assign money you hold

Assignable money = sum of balances of all **Budget accounts**, including pending transactions, excluding Credit and Tracking accounts.

If the household holds ₹80,000 across savings and cash, at most ₹80,000 can be assigned across all categories for all months combined.

**Behaviour:** assigning more is *allowed* but drives RTA negative and raises a persistent, unmissable warning until resolved. Never blocked (P2).

---

### R2 — Ready to Assign

For the month being viewed:

```
RTA(month) = funds available to budget
           − total assigned across all categories in this month
           − total assigned in all future months
```

where *funds available to budget* = Budget-account balances − amounts explicitly **held for next month** (R11) − overspend carried in from the previous month (R4).

**Worked example.** Budget accounts hold ₹1,20,000. ₹10,000 was held for next month. Last month over-spent cash by ₹2,500. Assigned so far this month: ₹85,000. Assigned to next month already: ₹5,000.

```
RTA = 1,20,000 − 10,000 − 2,500 − 85,000 − 5,000 = ₹17,500
```

**Display states:** positive (amber — work to do), zero (green — done), negative (red — over-assigned, must fix).

---

### R3 — Positive balances roll forward

A category ending a month with a positive balance opens the next month with that balance. No expiry, no sweep. (The original design allowed an auto-assign rule with a ceiling to say otherwise; that rule engine was removed — see the note under R9.)

---

### R4 — Cash overspending

When a category's balance goes negative because of spending from a **Budget account**:

1. The negative is displayed in red on the category for the remainder of the month.
2. At month rollover, the category opens at **zero**, and the overspent amount is **deducted from next month's Ready to Assign**.

**Worked example.** Groceries assigned ₹12,000, spent ₹13,400. Groceries shows −₹1,400 for the rest of the month. Next month, Groceries opens at ₹0 and next month's RTA is reduced by ₹1,400.

**Decision 26-08-2026 (Q1): both models ship.** Actual's model is the default; the YNAB-style carry-the-negative alternative is a household setting. **The setting is not a stub** — both paths are implemented and tested in P0, because retrofitting the second one means reworking every stored monthly figure.

**Why Actual's is the default:** it keeps the pain in the one place the user actually looks (RTA) and prevents a category accumulating invisible multi-month debt.

**Strongest alternative:** carry the negative balance forward on the category itself, so Groceries opens at −₹1,400. This is more locally honest — the overspend stays attached to the thing that caused it — and some YNAB users prefer it. It is rejected because a category that has been −₹800 for six months becomes background noise, whereas an RTA that will not reach zero cannot be ignored. **Make this a household setting**, defaulting to the Actual model, and record the choice per budget rather than per month.

---

### R5 — Covering overspending

The user may at any time move money from any category to any other category, in any month. This is the "roll with the punches" primitive and must be no more than two taps from a red category.

The app offers **suggested cover sources**, ranked by: categories with the largest positive balance, categories whose target is already met, and categories the user has historically raided for this category. Suggestions are advisory only.

---

### R6 — Credit cards

This is the mechanic most competitors get wrong, and the one that matters most in India.

**On adding a Credit account,** the app creates a matching **payment category** for that card, in a dedicated "Credit Card Payments" group. It cannot be deleted while the account exists.

**On a purchase using the card,** charged to a funded category:

- The transaction reduces the spending category's balance (activity).
- An equal amount moves automatically from the spending category to that card's payment category.
- The card account balance becomes more negative (the debt grows).

**Worked example.** Groceries holds ₹12,000. You spend ₹1,800 on the card at a supermarket.
Groceries → ₹10,200. Credit Card Payments (HDFC) → +₹1,800. HDFC card balance → −₹1,800.
The cash to clear that ₹1,800 is now reserved and cannot be spent elsewhere without a deliberate move.

**On paying the card** (a transfer from a Budget account to the Credit account): the payment category is reduced by the payment amount, the Budget account balance falls, the card balance rises toward zero. No spending category is touched.

**Credit overspending** — spending on the card from a category with insufficient funds — does **not** create cash and must not reduce RTA. It surfaces as: the spending category goes negative (handled by R4), *and* the payment category holds less than the card balance, which is flagged with a distinct warning ("₹3,200 of your HDFC balance is not funded").

**Starting debt.** An existing card balance on account creation is recorded as the opening negative balance. The payment category starts at ₹0 and is expected to be funded via a payoff target (R8). The unfunded portion is shown as a debt figure, never as a budgeting error.

**Add-on cards.** An add-on card is a **sub-card of an existing Credit account, never a Credit account of its own** — it shares the limit, appears on one statement and is settled by one payment. Full rules in `09-decisions-log.md` §4 (R6.a–R6.g). The essential requirement: every transaction records **which card** it was made on and **which member** owns it, otherwise half the household's card spending arrives attributed to the primary holder and the ownership model quietly fails.

**India specifics.**

- **Statement cycles are not calendar months.** The payment category must display both the *current outstanding* and the *last statement amount with its due date*, sourced from a schedule or manual entry. Funding advice keys off the statement, not the month boundary.
- **EMI conversion.** Converting a card purchase to EMI reduces the outstanding and creates a recurring obligation. Functionally: the user marks a card transaction as "converted to EMI", supplies tenure and monthly amount; the app creates a schedule for the EMI, and reduces the payment-category expectation by the converted amount. The EMI's monthly instalment is then budgeted as an ordinary category with a schedule-linked target. **[This flow needs your confirmation — see `05` §6 Q4.]**
- **Auto-debit / standing instruction** on a card must be representable as a schedule so the cashflow calendar is accurate.

---

### R7 — Moving money between months

Assignments belong to a month. The user may assign into any future month, subject to R1 (all months' assignments draw on one pool of held cash).

**Decision 26-08-2026 (Q5): assignments into any past month are permitted, always.** History is never frozen.

This collides with reconciliation checkpoints (F9.3), and the collision is resolved by making the breakage loud rather than by refusing the edit. Editing anything on or before a checkpoint requires explicit confirmation naming that checkpoint, marks it **broken** until the account is reconciled again, raises a Review item, and is recorded in the event log with both values. The app never silently repairs a broken checkpoint. Full rules: `09-decisions-log.md` §5 (R7.a–R7.f).

---

### R8 — Targets

A category may carry at most one target. Target types:

| Type | Parameters | "Underfunded" means |
|---|---|---|
| **Monthly amount** | ₹X per month | X − assigned this month |
| **Refill to balance** | ₹X | X − current balance |
| **Refill to balance, holding overages** | ₹X | X − current balance, but never negative and never clawing back a surplus (e.g. a refund) |
| **Spending target by period** | ₹X per week / per day | pro-rated shortfall for the elapsed period |
| **Savings by date** | ₹X by DD-MM-YYYY | (X − balance) ÷ months remaining |
| **Savings by date, repeating** | ₹X by DD-MM, every year | as above, cycle resets after the date |
| **Debt payoff** | ₹X per month toward a Credit account | X − assigned this month |
| **Schedule-linked** | fund the next occurrence of schedule S | amount due − balance, spread over months until due |

**Displayed per category:** target, assigned this month, balance, and an underfunded figure with a visual state (unfunded / partially funded / funded / over-funded).

**Displayed globally:** *"₹14,200 underfunded across 6 categories"* with one-tap navigation and one-tap auto-assign (R9).

---

### R9 — Auto-assign

One action fills the month according to each category's target, spending only money actually available (R1) and stopping cleanly when it runs out. Ready to Assign is spent down the budget in order, so what the household budgeted for is funded before anything else.

> **Superseded, 11-09-2026 (B58, B67).** The rule table below was the original design and is kept for the record, not as a specification of the app. It was built, tested, and shipped with no screen that could write a rule — so in practice it never ran, and auto-assign did nothing. Targets, set on the Categories screen, turned out to be the configuration a household actually maintains, and having two places to express "what this category should hold" was the problem rather than the solution. `planAutoAssign` and the `autoassign_rules` table have been removed; the behaviour that survives is *fund each category to its target, in budget order*. If a richer rule type is ever wanted, it should extend the target, not sit beside it.

**Auto-assign rule types** *(historical — see the note above)* (superset of targets, taken from Actual's template language but delivered as a form):

| Type | Configured as | Behaviour |
|---|---|---|
| Fixed | amount | Assign ₹X |
| Fixed with ceiling | amount, ceiling | Assign ₹X, stop once balance reaches ₹Y |
| Refill | target balance | Top up to ₹X |
| Refill, hold overage | target balance | Top up to ₹X; never remove a surplus |
| Rate-limited | amount, per day/week, start date | Ceiling scaled by elapsed periods |
| Periodic | amount, every N weeks/months/years, start date | Assign on cycle only |
| By date | amount, target date, optional repeat, optional spend-from date | Divide remainder across months left |
| Percentage of income | %, source (all income / a specific income payee / previous month's income / currently available funds) | Compute from actual income received |
| Average of history | N months, optional ±% or ±₹ adjustment | Assign the historical average |
| Copy | from N months ago | Mirror an earlier month |
| Remainder sweep | weight, optional ceiling | Distribute whatever RTA is left, by weight |

**Priority** *(historical).* Each rule carries a priority band (1 = highest). Auto-assign runs band by band. Within a band, order is the category's display order. Non-highest bands never over-allocate beyond what remains. Remainder-sweep rules always run last regardless of band.

**Non-negotiable UX requirement.** This is configured through a form with plain-language preview — *"Assign ₹4,000 on the 1st of every month, stopping when this category holds ₹20,000"* — not through text syntax. An **advanced mode** may expose an equivalent text expression for power users and for copy-paste between categories, but no household member should ever be required to learn it. This is the single biggest usability failure to avoid inheriting from Actual.

**Preview before commit.** Auto-assign always shows what it will do — a per-category list of proposed changes and the resulting RTA — with a single undo afterwards (P3).

---

### R10 — Future months

Future months are fully viewable and budgetable. A future month shows: projected opening balances per category (current balance + assignments already made), scheduled transactions due, and the RTA implied by money on hand.

Future months never assume income that has not arrived (P1). A future month may therefore show a large positive RTA that will not survive contact with reality — the UI must label this *"based on money you have today"*.

---

### R11 — Hold income for next month

Any amount of RTA may be explicitly set aside for the following month. Held money:

- is removed from this month's RTA,
- appears at the top of next month's RTA,
- is shown as a distinct line ("₹40,000 held for September"), reversible at any time.

This is the mechanism by which the household reaches "spending last month's income", and it must be a visible, celebrated action — not a hidden category trick.

---

### R12 — Buffer (in place of Age of Money)

```
Buffer (days) = total assigned across all categories, excluding credit card payment categories
                ÷ average daily spend over the trailing 90 days
```

Reported as a whole number of days with a plain-language reading: *"You have 47 days of typical spending already assigned."*

**Why not Age of Money:** YNAB's metric is computed from the age of the specific rupees being spent, is hard to explain, moves for non-obvious reasons and is routinely misread [unverified as to its exact formula]. Buffer is arithmetic the user can verify by hand, which matters more than sophistication.

**Secondary metric — Fully-funded month.** A boolean: has every category with a target met that target for this month, with RTA at zero? This is the real goal state and deserves an explicit celebration.

---

### R13 — Month rollover

At the start of a new month, without user action:

1. Positive category balances carry forward (R3).
2. Cash-overspent categories reset to zero and reduce the new month's RTA (R4).
3. Credit-overspent categories reset to zero; the unfunded card portion continues to be flagged (R6).
4. Held income is released into RTA (R11).
5. Auto-assign does **not** run automatically by default. It may be enabled per household with a preview-and-confirm notification. **[Decision to confirm — `05` §6 Q6.]**
6. Nothing is deleted. Every prior month remains viewable in full.

---

> **Rules R14–R22 — loans and liabilities — continue in `06-loans.md`:** loan accounts, drawdown, interest models, amortisation, actual-versus-projected drift, prepayment, rate resets, closure and lifetime metrics.
>
> **Rules R35–R40 — platform, identity and operations — continue in `08-platform-and-operations.md`:** the strict server-only client data policy, idempotent writes, the immutable event log with undo and "explain this number", debug login and impersonation, theme, and verified backup recovery.
>
> **Rules R23–R34 — assets, net worth and multi-currency — continue in `07-assets-networth-currency.md`:** asset accounts, unit-based holdings, cost basis and FIFO lots, valuation and price refresh, gains and returns, corporate actions, the net worth statement, **R30 the firewall**, base and account currencies, rate sourcing, conversion rules, and the asset-versus-FX gain decomposition.

---

## 5. Functional modules

Requirements are numbered for traceability. **MUST** / **SHOULD** / **MAY** carry their usual weight.

Modules F1–F17 are below. **F18 (Loans & liabilities)** is specified in `06-loans.md`, which continues the engine rules at R14. **F19 (Assets & net worth)** and **F20 (Multi-currency)** are specified in `07-assets-networth-currency.md`, which continues them at R23. **F21–F30 (platform, identity and operations)** are specified in `08-platform-and-operations.md`, which continues them at R35 and **supersedes §9 of this document**.

---

### F1 · Authentication & household

- F1.1 The app MUST authenticate via Google SSO only. No local password store.
- F1.2 Access MUST be restricted to an explicit allow-list of Google accounts, editable by any existing member.
- F1.3 First member to sign in on a fresh instance becomes a member and MUST be prompted to add others.
- F1.4 All members MUST have identical permissions (P5).
- F1.5 Every created or modified record MUST record which member did it and when; this MUST be visible in a per-record history.
- F1.6 A member MAY be removed; their historical attributions MUST be retained.
- F1.7 Sessions MUST persist across PWA restarts for at least 30 days without re-authentication, and MUST be revocable per device from settings.
- F1.8 The app MUST function fully offline for an already-authenticated member (P6).

---

### F2 · Accounts

- F2.1 The app MUST support three account kinds: Budget, Credit, Tracking (§3).
- F2.2 Budget account kinds MUST include: savings, current, cash-in-hand, prepaid/UPI wallet.
- F2.3 Credit account kinds MUST include: credit card, charge card. Each MUST carry an optional statement day and due day.
- F2.4 Tracking account kinds MUST include: loan, EMI, fixed deposit, recurring deposit, other asset, other liability.
- F2.5 Creating a Budget account MUST capture an opening balance and date; that balance MUST arrive in RTA as income.
- F2.6 Creating a Credit account MUST capture the current outstanding as a negative opening balance and MUST create its payment category (R6).
- F2.7 Accounts MUST be closeable without deletion; closed accounts MUST be hidden by default and retain history.
- F2.8 Each account MUST display: cleared balance, uncleared balance, working balance, and date of last reconciliation.
- F2.9 The app SHOULD support an account nickname distinct from the bank's name, and a last-four-digits field for matching against SMS alerts (F13).

---

### F3 · Categories & the budget screen

- F3.1 Categories MUST be organised into ordered groups; both MUST be renameable, reorderable by drag, and hideable without deletion.
- F3.2 A hidden category MUST retain its balance and history, and MUST be excluded from auto-assign and from underfunded totals.
- F3.3 Deleting a category MUST require reassigning its balance and MUST offer to remap its historical transactions to another category.
- F3.4 The budget screen MUST show, per category: name, target summary, assigned this month, activity this month, current balance, funded state.
- F3.5 The budget screen MUST show, per group: subtotals of assigned, activity and balance.
- F3.6 RTA MUST be visible at all times on the budget screen, on every viewport, without scrolling.
- F3.7 The month MUST be navigable backward to the first month with data and forward at least 24 months.
- F3.8 Assigning MUST be possible by typing an amount, and MUST also accept quick actions: *assign underfunded*, *assign to reach target*, *assign last month's amount*, *assign average of last 3 months*, *clear assignment*.
- F3.9 Moving money between categories MUST be reachable in at most two interactions from a category row, and MUST offer suggested sources (R5).
- F3.10 A first-run **starting budget** MUST be offered, pre-populated with an India-appropriate structure grouped as Fixed / Flexible / Non-monthly / Savings goals (see §8).
- F3.11 The app MUST provide an "auto-assign" action with preview and single-action undo (R9).

---

### F4 · Transactions

- F4.1 Creating a transaction MUST require: account, date, amount, direction. Payee and category MAY be filled later; a transaction lacking a category MUST be flagged as needing attention.
- F4.2 Entry MUST default to today's date and to the last-used account, and MUST support entry in under 5 seconds on a phone for a repeat payee.
- F4.3 The app MUST support splits across unlimited categories, with a running remainder shown and an "assign remainder here" action.
- F4.4 The app MUST support transfers between any two accounts; a transfer to a Credit account MUST be treated as a card payment (R6).
- F4.5 Transactions MUST support: memo, unlimited tags, an owner (defaulting to the entering member), a cleared flag, and attachments (photo of a receipt).
- F4.6 The app MUST support recurring transaction creation from a schedule, and MUST allow a scheduled instance to be edited or skipped without altering the schedule.
- F4.7 The app MUST support bulk edit over a filtered selection: set category, add/remove tags, set payee, mark cleared, delete.
- F4.8 Deleting MUST be soft for 30 days with restore, then hard.
- F4.9 Every transaction MUST retain its raw imported values and source where applicable (P4), viewable in a details pane.
- F4.10 Amounts MUST be enterable as an expression (`450+120*2`) with the computed result shown before commit.
- F4.11 The app SHOULD support marking a transaction *reimbursable*, and SHOULD track outstanding reimbursables as a running total per counterparty.

---

### F5 · Payees

- F5.1 Payees MUST have a single clean display name and MUST retain every raw string ever mapped to them.
- F5.2 Payees MUST be mergeable, with all history and mappings preserved.
- F5.3 Selecting a payee during manual entry MUST suggest that payee's most-used category, and MUST show its last transaction amount and date.
- F5.4 The app MUST maintain per-payee statistics: transaction count, total, average, first and last seen, categories used.
- F5.5 A payee MAY carry a default category and a default account.

---

### F6 · Rules engine

Modelled on Actual's design (`01` §3), with an India-oriented addition.

- F6.1 Rules MUST support conditions on: imported payee, cleaned payee, account, category, date, memo/notes, amount, amount range, direction, transaction source, and existing tags.
- F6.2 Operators MUST include: is, is not, contains, does not contain, starts with, matches regex, one of, not one of, greater than, less than, between.
- F6.3 Actions MUST include: set category, set payee, set/append/prepend memo, add tag, remove tag, set cleared, set account, set date, set owner, split into fixed or percentage parts, mark for review, ignore (never import).
- F6.4 Rules MUST execute in three ordered stages — `pre`, `default`, `post`. Within a stage, rules MUST be auto-ordered least-specific to most-specific.
- F6.5 The app MUST learn rules from user behaviour: renaming an imported payee, or categorising a transaction from a payee for the second time, SHOULD propose a rule. Proposals MUST be confirmable, dismissible, and disableable per payee and globally (P3).
- F6.6 The rule editor MUST double as a batch editor: "apply this rule to matching existing transactions" with a count and preview before commit.
- F6.7 Every rule MUST be testable against a sample of historical transactions before saving, showing before/after.
- F6.8 A transaction MUST record which rules touched it; the details pane MUST show this.
- F6.9 **India addition:** rules MUST be able to match on structured fragments extracted from UPI/IMPS/NEFT narration — VPA, merchant token, reference number, channel — not just the whole string. See `04` §3.

---

### F7 · Schedules, bills & cashflow calendar

- F7.1 A schedule MUST capture: account, payee, category, amount (fixed or estimated), recurrence, next due date, and an optional auto-post flag.
- F7.2 Recurrence MUST support: daily, weekly, fortnightly, monthly on date, monthly on nth weekday, quarterly, half-yearly, yearly, and custom every-N-periods.
- F7.3 Monthly-on-date schedules MUST handle the 29th–31st on short months by a configured policy (last day of month / skip / next day).
- F7.4 Upcoming schedules MUST appear on the budget screen against their category, so their funding need is visible while budgeting.
- F7.5 A schedule instance MUST be markable as paid, skipped, or edited-this-occurrence.
- F7.6 The app MUST detect probable recurring transactions from history and propose schedules, with confidence shown and one-tap accept/dismiss.
- F7.7 The app MUST provide a **cashflow calendar**: a forward view (default 60 days, extensible to 365) showing scheduled inflows and outflows against projected Budget-account balances, flagging any date where a projected balance goes below zero or below a configured floor.
- F7.8 The calendar MUST distinguish confirmed schedules from detected-but-unconfirmed ones.
- F7.9 Subscriptions (schedules tagged as such) MUST have a dedicated list with annualised cost, and MUST support a pre-renewal notification (F14).

---

### F8 · Credit cards & debt

- F8.1 The app MUST implement R6 in full.
- F8.2 Each Credit account MUST show: current outstanding, last statement amount and date, due date, minimum due (if entered), amount currently funded in its payment category, and unfunded shortfall.
- F8.3 The app MUST warn when a card's due date is within N days (configurable, default 5) and the payment category holds less than the statement amount.
- F8.4 The app MUST support a debt payoff target per Credit and Tracking-liability account, showing months to payoff at the current rate.
- F8.5 The app MUST support marking a card transaction as converted to EMI (R6), creating the corresponding schedule.
- F8.6 The app SHOULD show a simple debt overview across all liabilities: balance, rate (if entered), monthly obligation, payoff horizon.

---

### F9 · Reconciliation

- F9.1 Reconciling an account MUST ask for the bank's balance as of a date and MUST compute the difference against the app's cleared balance.
- F9.2 On a mismatch, the app MUST offer: mark transactions cleared, add a balancing adjustment transaction (to a dedicated Reconciliation category), or cancel.
- F9.3 A completed reconciliation MUST create a locked checkpoint; editing or deleting a transaction dated on or before a checkpoint MUST require explicit confirmation and MUST mark the checkpoint broken.
- F9.4 The app MUST display days-since-last-reconciliation per account and SHOULD nudge monthly.

---

### F10 · Reports & query

- F10.1 The app MUST provide: spending by category (period selectable), spending by payee, spending by tag, income vs expense over time, category trend over time, and net cash position over time.
- F10.2 Every report MUST be filterable by date range, accounts, categories, tags, owner, and amount range, and MUST be drillable down to the transaction list behind any figure.
- F10.3 The app MUST provide a **query screen** — a single filterable, sortable, groupable transaction table, saveable as a named view. This replaces a proliferation of report presets.
- F10.4 Reports MUST support Indian fiscal year (April–March) as a period preset alongside calendar year, month, quarter.
- F10.5 Every report MUST export to CSV.
- F10.6 The app SHOULD offer a per-owner spending view for household transparency, using the transaction owner field.

---

### F11 · Goals (piggy banks)

- F11.1 A goal MUST have a name, target amount, optional target date, and MUST be linked to one or more categories whose combined balance measures progress.
- F11.2 Goals MUST be displayed outside the monthly budget grid, on their own screen, with progress bars and required-monthly-contribution figures.
- F11.3 A goal MAY set a *by date* target on its linked category. (Originally specified as an auto-assign rule; see the note under R9.)
- F11.4 Completing a goal MUST offer to spend the balance, roll it to a new goal, or return it to RTA.

---

### F12 · Tags

- F12.1 Tags MUST be free-form, autocompleted, and creatable inline during transaction entry.
- F12.2 A tag MUST support a spending total and a date range, so a trip tag functions as an ad-hoc budget without a category.
- F12.3 Tags MUST be renameable and mergeable across all history.
- F12.4 The app SHOULD support "tag budgets": an optional amount on a tag, with progress shown, independent of the envelope system.

---

### F13 · Import & ingestion

Specified in full in `04-ingestion-and-automation.md`. Functional summary:

- F13.1 The app MUST support CSV/XLSX import with saveable per-bank column-mapping profiles.
- F13.2 The app MUST support PDF statement import for the household's actual banks, with the extracted rows presented for confirmation.
- F13.3 All imported transactions MUST land in a **review queue**, never directly in the ledger, unless a rule explicitly marks them auto-approvable.
- F13.4 Duplicate detection MUST run on every import (rules in `04` §4) and MUST present suspected duplicates for a decision rather than silently dropping them.
- F13.5 The app MUST support email and SMS alert parsing as a later phase, producing review-queue entries.
- F13.6 The app MUST keep an import log: source, timestamp, rows read, imported, duplicates, errors — with the ability to undo an entire import batch.

---

### F14 · Notifications & nudges

- F14.1 The app MUST support notifications for: card payment due with unfunded shortfall (F8.3), subscription renewing within N days, category overspent, month rolled over, review queue non-empty for more than N days, projected balance shortfall from the cashflow calendar (F7.7).
- F14.2 Every notification type MUST be individually toggleable per member.
- F14.3 Notifications MUST degrade gracefully where the platform cannot deliver push (§9): in-app badge and a digest on next open MUST always work.
- F14.4 The app SHOULD support outbound webhooks on events (transaction created, month rolled over, overspend, schedule due) so a self-hosting household can route alerts to their own channel.
- F14.5 The app MUST NOT send more than one push per event, and MUST NOT send engagement or streak notifications.

---

### F15 · Data portability

- F15.1 The app MUST export the complete budget — accounts, categories, assignments per month, transactions, splits, payees, rules, schedules, goals, tags, attachments, member attributions — in an open, documented format, in one action.
- F15.2 Export MUST be available offline-of-support, without a paywall, and MUST be re-importable into this app.
- F15.3 The app MUST support CSV export of transactions with all fields including raw imported values.
- F15.4 The app SHOULD support import from YNAB and Actual Budget export formats, at minimum for accounts, categories, transactions and monthly assignments.
- F15.5 The app MUST provide a one-action backup of the entire dataset suitable for a homelab backup routine, and a documented restore.

---

### F16 · Search

- F16.1 Global search MUST cover payees, memos, categories, tags, amounts and raw imported strings.
- F16.2 Search MUST support amount ranges and date ranges in the query, and MUST be usable offline against locally cached data.

---

### F17 · Settings & preferences

- F17.1 Household settings: members, currency, first day of week, month start day, fiscal year start, **overspend model (R4 — both implemented, Actual's as default)**, auto-assign on rollover (R13.5 — **off by default**), notification defaults.
- F17.2 Member settings: theme (light/dark/follow-system, stored server-side and rendered into the first response — `08` R39), number format, notification toggles, default account, active sessions with revocation, personal API tokens.
- F17.3 The app MUST support a **demo/sandbox mode** with generated data, for trying features without touching the real budget.

---

### F18 · Loans & liabilities

Specified in full in `06-loans.md`, which also carries engine rules **R14–R22**. Functional summary:

- F18.a The app MUST support loan accounts with a sanction, multiple disbursements, versioned rates and a repayment schedule, for home (incl. under-construction), car, personal, gold, education, credit-card EMI and BNPL.
- F18.b Disbursements MUST carry a destination per tranche — a Budget account (arrives as income) or a third party (liability only, Ready to Assign untouched).
- F18.c The app MUST compute a full amortisation schedule and MUST reconcile it against the lender's actual principal/interest splits, surfacing drift rather than silently correcting it.
- F18.d Each loan MUST have its own payment category, symmetric with the credit-card payment category (R6).
- F18.e The app MUST support extra monthly payments and part-prepayments, defaulting to tenure reduction and always showing the EMI-reduction alternative side by side.
- F18.f The app MUST report lifetime interest paid, interest saved, EMIs saved and effective rate, each labelled actual or projected.
- F18.g A loan balance MUST never contribute to Ready to Assign, in any state.

---

### F19 · Assets, holdings and net worth · F20 · Multi-currency

Specified in full in `07-assets-networth-currency.md`, which also carries engine rules **R23–R34** and the hardcoded price and FX provider selection. Functional summary:

- F19.a Asset accounts (investment, retirement, deposit, physical, commodity, receivable) are Tracking accounts and MUST never fund the budget.
- F19.b Holdings MUST be recorded as **units of an instrument with FIFO lots**, never as a rupee balance — this is what makes cost basis, realised gains and XIRR computable.
- F19.c Prices MUST refresh automatically from the providers in `07` §6, be cached with their publication date, and be visibly marked when stale. Manual price entry is always available.
- F19.d The app MUST produce a net worth statement with a dated history, decomposing period change into money saved, market movement, FX movement and debt repaid.
- F19.e **R30 — the firewall — is binding:** unrealised gains are never income, market value never enters Ready to Assign, and net worth never appears on the budget screen.
- F20.a The household has one base currency (₹). **Every envelope, target and Ready to Assign figure is in base currency, always.**
- F20.b Foreign-currency accounts default to Tracking, so Ready to Assign does not move with the exchange rate.
- F20.c FX rates MUST be fetched automatically and retained with publication dates; a transaction's base amount is frozen at trade date and never revalued.
- F20.d A foreign holding's gain MUST be decomposed into asset gain and FX gain, summing to exactly the total.

---

## 6. Indian localisation requirements

| # | Requirement |
|---|---|
| L1 | Currency ₹ throughout. Grouping MUST follow the Indian system: ₹12,34,567.89. |
| L2 | Large figures MUST be readable in lakh/crore where space is tight (₹12.35L), with the exact figure on hover/tap. |
| L3 | Dates MUST display as DD-MM-YYYY. Date entry MUST accept DD/MM and DD-MM shorthand. |
| L4 | Fiscal year MUST default to 1 April – 31 March for reports, with calendar year available. |
| L5 | The default category template MUST reflect Indian household spending: rent, maintenance/society charges, domestic help, groceries, vegetables, milk, gas cylinder, electricity, water, broadband, mobile recharge, DTH/OTT, fuel, cab/auto, EMI, insurance premiums (term/health/motor), school fees, medical, festivals & gifts, travel home, parental support. |
| L6 | Festival and annual-expense sinking funds MUST be first-class in the starting template (Diwali, Onam, weddings) with by-date targets. |
| L7 | Payee cleanup MUST handle UPI narration structure natively (see `04` §3), not as a generic regex exercise. |
| L8 | Cash MUST be a first-class Budget account, not an afterthought — a meaningful share of household spending is still cash. **Confirmed 26-08-2026 (Q7): ATM withdrawals are transfers into the Cash account; cash spends are categorised from it.** |
| L9 | Credit card statement cycles and due dates MUST be modelled separately from calendar months (R6). |
| L10 | The app MUST handle the multiple-card, multiple-bank reality: **this household has 7 bank accounts, 14 cards and 3 loans** (`09` §2). Five to eight accounts is not the ceiling. |
| L13 | Loans MUST follow Indian product reality: tranche disbursement and pre-EMI on under-construction property, flat-rate quoting on car and personal loans, education-loan moratoria, and floating rates linked to an external benchmark with resets. See `06-loans.md` §11. |
| L14 | Interest and principal paid MUST be reportable per financial year (Apr–Mar) for the household's own use. The app MUST NOT compute tax liability or give tax advice. |
| L15 | Mutual funds MUST be identifiable by AMFI scheme code and ISIN, and the scheme picker MUST show the full scheme name so Direct and Regular plans are never confused (`07` §6.2). |
| L16 | Realised gains MUST expose the holding period per lot so long-term versus short-term classification is visible. The app classifies nothing and computes no tax (`07` R25.5). |
| L11 | Amounts MUST support paise but MUST default to displaying whole rupees where the paise are zero. |
| L12 | Time zone MUST be IST; "today" MUST be evaluated in IST regardless of device setting. |

---

## 7. Household collaboration requirements

- H1 Both members see identical data; there is no owner (P5).
- H2 Every transaction carries an **owner** — who spent it — defaulting to the entering member, editable.
- H2.1 An **account** may name a holder — whose account it is — or stay joint. It is a label and nothing in the engine reads it: every account funds the one shared budget either way (§3), and an account with a holder behaves identically to one without. Cards already carry a holder of their own (`09` §4), which is a different thing: a card's holder defaults the owner of its transactions, an account's holder defaults nothing.
- H3 The budget screen MUST show, on any assignment or move, who made the change and when, on demand.
- H4 Concurrent edits to the same assignment are serialised by the server; last write wins, and the superseded value is retrievable from the event log (`08` R37). The user MUST NEVER see a merge conflict dialog. *(Simplified 26-08-2026: with no client cache there is no divergence to reconcile.)*
- H5 Concurrent transaction entry MUST never merge or dedupe across members automatically within a 60-second window without flagging it — two people paying for two things at the same restaurant is normal.
- H6 The app SHOULD support a lightweight "flag for partner" action on a transaction, producing a notification and an in-app queue.

---

## 8. First-run experience

The empty state is where budgeting apps lose people. The first run MUST:

1. Authenticate via Google and confirm the household name.
2. Ask a small number of questions: monthly take-home (approximate), pay date, whether income is regular, number of credit cards, whether there are EMIs.
3. Generate a **starting budget** from the answers, grouped as:
   - **Fixed** — rent, EMIs, insurance, school fees, subscriptions, utilities on standing instruction
   - **Flexible** — groceries, eating out, transport, fuel, household, personal
   - **Non-monthly** — festivals, travel, medical, vehicle service, annual premiums, gifts
   - **Savings goals** — emergency fund, named goals
   with plausible target amounts the user immediately edits.
4. Walk through adding one account with its current balance, and show RTA becoming a real number.
5. Walk through assigning that money until RTA is zero — the single most important moment in the product.
6. Offer, not require: adding the partner, importing a statement, setting up schedules.

Total time to a working budget: **under 10 minutes**. The user MUST be able to skip to a blank budget at any point.

---

## 9. PWA and platform requirements

> **Superseded 26-08-2026.** This section originally specified an offline-first PWA with a bounded local cache, offline transaction entry, a sync queue and conflict resolution. The client data policy was changed to **strict server-only**: no user data is persisted on the device by any mechanism. The full specification, including what that deletes and what it costs, is **`08-platform-and-operations.md` §3 (R35) and F21**.

**The short form:**

- No user data on the client — no `localStorage`, `sessionStorage`, `IndexedDB`, Cache API, or service worker `fetch` handler.
- Permitted on the device: static assets, an `HttpOnly` session cookie, in-memory view state, and unsubmitted form input.
- [verified 26-08-2026] A **service worker is not required for installability**. A manifest with `name`/`short_name`, 192px and 512px icons, `start_url` and `display`, over HTTPS, is sufficient. `beforeinstallprompt` still needs a fetch handler, so there is no programmatic install prompt on Android either — and iOS never had one. Explicit install instructions are required on both.
- Push, if kept, is **content-free**: a count and a generic label, never an amount or a payee. Detail is fetched when the app opens.
- Every mutating request carries an **idempotency key** with bounded in-memory retry, so a weak connection does not lose an entry or create a duplicate (`08` R36).
- **The cost, stated once:** no entry without connectivity, a server outage is a total outage, and perceived speed becomes network latency. `08` §3.3 covers this and the documented escape hatch if it proves painful.

**Performance targets** are revised in `08` F21 for a network round-trip.

---

## 10. Accessibility & interaction requirements

- A1 All interactive targets MUST be at least 44×44 CSS px.
- A2 Colour MUST NOT be the only signal for funded/overspent state — an icon or text label MUST accompany it (red/green is the most common colour-vision failure).
- A3 Contrast MUST meet WCAG 2.1 AA in both light and dark themes.
- A4 The budget grid MUST be fully keyboard-navigable with arrow keys and MUST support type-to-assign.
- A5 Currency amounts MUST be announced correctly by screen readers (₹ as "rupees", not "R").
- A6 The app MUST respect `prefers-reduced-motion` and `prefers-color-scheme`.
- A7 Numeric input on mobile MUST invoke the numeric keypad with a decimal.

---

## 11. Behaviour the app must never exhibit

| # | Never |
|---|---|
| N1 | Block or refuse a transaction because a category is empty |
| N2 | Silently change a category the user set |
| N3 | Silently drop an import row as a duplicate without surfacing it |
| N4 | Overwrite or discard the raw imported payee/amount/date |
| N5 | Lose a transaction the user typed, on any network failure — the input stays on screen and retries with its idempotency key (`08` R36.7) |
| N6 | Assume income that has not arrived when computing RTA |
| N7 | Send engagement, streak or guilt notifications |
| N8 | Require the server to be reachable in order to record a spend |
| N9 | Present an ML/heuristic categorisation as a fact rather than a suggestion |
| N10 | Make export, backup or account deletion harder than a single action |
| N11 | Let an unrealised market gain become income, a category balance, or assignable money (`07` R30) |
| N12 | Show net worth or portfolio value on the budget screen |
| N13 | Retrospectively revalue a recorded transaction because an exchange rate moved |
| N14 | Present a price or converted figure without the date it is as of |
| N15 | Compute a tax liability or deduction, on loan interest or capital gains or anything else |
| N16 | Persist any user data on the client device, by any mechanism (`08` R35) |
| N17 | Show a stale value in place of a failed request |
| N18 | Put a financial amount, payee or balance into a push notification payload |
| N19 | Ship the development login bypass in a production build |
| N20 | Write to the ledger without an idempotency key, or mutate anything without an event log entry |
