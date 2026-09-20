# Seven proposals, sized

An assessment of seven requested features against the code as it stands on
2026-09-20, at commit `85a1075`. Nothing here is built. Each entry says what the
feature means *in this app* rather than in general, what it touches, where the
difficulty actually is, and what it would cost.

**They are ordered by recommendation, not as they were asked for** — cheapest
and safest first, blocked and deferred last. The summary table at the end maps
back to the original list.

## What a "day" means here

A day of one developer already fluent in this codebase, and **including the
tests and documentation this project demands**. That inclusion is most of the
number. The repository is 115 source files against 119 test files and 1,426
tests; every behavioural rule carries a test that fails when the rule is
removed, and every non-obvious decision is written down. A change that is two
hours of typing is routinely a day and a half of work here, and the estimates
below reflect that rather than apologising for it.

Ranges are honest ranges. Where the low end assumes a decision goes a
particular way, that is said.

## The one constraint that prices everything

    accounts = Σ category balances + Ready to Assign + held for next month

`identityResidual()` must return exactly zero, in integer paise, in every month,
in every test. It is the invariant the whole engine is derived from, and the
reason several proposals below are cheap and one is not: **anything that changes
where money is costs an order of magnitude more than anything that changes how
money is displayed.** The cheapest version of most of these features is the one
that stays on the display side of that line.

Two secondary constraints matter almost as much:

- **No runtime dependencies.** Outbound HTTP already exists (Gmail, price
  providers, OIDC, the backup webhook) using the global `fetch`, so an
  integration is not unprecedented — but it arrives without a library.
- **Self-hosted and hosted are the same binary.** A feature that only works when
  a company operates the instance is a feature that splits the product in two,
  and two of these are that.

---

## 1 · Locked categories

**Do this first.** It is the cheapest item on the list and the one with the
clearest daily use: school fees and insurance sinking funds that must not be
raided in a tight month.

**The rule, exactly.** A lock forbids **reducing `assigned`**. Adding to a
locked envelope is always allowed, so a lock never gets in the way of funding
something — only of raiding it. Spending *from* a locked envelope still reduces
the balance, because refusing that would mean refusing to record something that
already happened at a till.

That phrasing settles the case that would otherwise have to be argued: a lock is
a constraint on **budgeting decisions**, not on reality.

**A departing member is the exception, and it is a real one.** `departure.ts`
withdraws a leaving member's unspent assigned by calling `setAssigned` downward
— which is precisely what the lock forbids. It must still work: that money is
leaving with a person, not being raided to cover an overspend, and a lock that
stranded it would leave the budget claiming money the household no longer has.
Departure is therefore an explicit, named exemption with its own test, not an
accident of ordering.

**Touches.** A `locked_at` column on `categories`, then every writer that can
reduce `assigned`: `setAssigned` and `moveMoney` in `src/domain/budget.ts`, and
their callers — `card-emi.ts`, `loans.ts`, and the auto-assign and
cover-overspending paths in `app.ts`. `suggestCoverSources()` in the engine must
stop proposing locked envelopes, or the app will keep recommending a move it
then refuses.

**Effort: 2–3 days**, and firmer than it was — the add-only rule removes the
design question. Most of it is the sweep across writers, a test per writer
proving the refusal bites, and one proving departure still gets its money out.

## 2 · Category group targets & nested pooling

These are two features and should be priced separately, because one is routine
and the other is not.

**Group targets — 3–5 days.** `targets` is keyed by `category_id` as its primary
key, so this needs either a parallel `group_targets` table or a generalised
owner column. The engine work is real but bounded: `targetProgress()` takes a
single `CategoryState`, so a group target needs a rolled-up state, and
`totalUnderfunded()` must not count a category twice once its group has a target
of its own. Decide early whether a group target *replaces* its children's
targets or sits above them; "both, summed" is the answer that produces numbers
nobody can explain.

**Nested pooling — depends entirely on which thing is meant.**

- *Display-only rollup* (a parent row showing the sum of its children, money
  staying in the children): **+2–3 days.** Safe, because the identity never
  sees it.
- *True nested categories* (a `parent_id` on `categories`, with a parent holding
  a balance children can draw on): **+8–12 days**, and it lands in the
  most-tested part of the app. Every one of these becomes recursive or has to
  explicitly refuse to be: the budget grid, auto-assign, move money, merge,
  delete, hide, the underfunded total, reports, and the identity itself, which
  currently sums a flat `state.categories`. A parent that both holds money and
  has children holding money is a double-count waiting to happen.

**Recommendation.** Group targets plus display-only rollup gets most of the
value for a third of the cost. Reach for real nesting only if a household
actually wants to *fund a parent and spend from children*, which is a different
feature from wanting to see a subtotal.

## 3 · Richer recurrence rules

*Re-scoped.* This was first read as scheduling under **uncertainty** — a bill due
"around the 15th", a service every four to six weeks. What is actually wanted is
**exact rules that today's model cannot express**: "the first Sunday of each
month", "the 24th every three months", "annually on 6 January". That is a
smaller, more tractable feature, and pricing it turned up two defects.

**Two of the three already work.** `quarterly` and `yearly` both go through
`shiftMonthsKeepingDay()`, which preserves the day of month — so "the 24th every
three months" and "annually on 6 January" are already correct, including the
short-month policy for a 29th–31st.

**The weekday one is broken, not missing.** `monthly-nth-weekday` is declared in
the `Recurrence` union and counted in the annualisation table used by the
subscriptions view — but **`nextOccurrence()` has no case for it**. It falls
through to `default:`, which advances by day of month. A schedule set to "first
Sunday" would silently behave as ordinary monthly, and the household would never
be told. It is not currently reachable from the UI, which offers only monthly,
weekly, fortnightly, quarterly and yearly — so it is a latent fault rather than
a live one, but implementing the feature means fixing it.

**And the enum is not validated.** All three schedule routes do
`field(ctx.body, "recurrence") as Recurrence` — a bare cast — and the
`schedules.recurrence` column carries no `CHECK` constraint. Any string a
crafted POST supplies is stored, and then falls through to monthly. Nothing
downstream ever complains. This is a data-integrity gap in shipped code, not
part of the feature, and it should be closed whether or not the feature is
built.

**The work.** Implement nth-weekday properly — ordinal 1st through 5th plus
"last", and the weekday, stored explicitly rather than inferred from `next_due`.
Add it to the three schedule forms. Validate the enum on the way in and add the
`CHECK` constraint by migration. Then decide whether arbitrary intervals are
wanted ("every five weeks"); they need an `interval` column, and they are the
only part of this that is genuinely new rather than a completion.

**Effort: 3–5 days**, *lower* than the uncertainty-window version priced before,
and part of it is a fix rather than an addition.

**The window idea is set aside, not dropped.** Scheduling under genuine
uncertainty — a band rather than a date, funded at the earliest end — remains a
separate and worthwhile feature at roughly 4–6 days, if irregular real-world
commitments ever justify it.

## 4 · Credit card milestone & reward tracking

Tracking only — it records what a card is about to earn, and touches no ledger
row. That is what makes it safe: the identity never sees it, so the cost is
modelling and arithmetic rather than invariant risk.

**The honest limitation up front.** There is no MCC or merchant-category field
on transactions, and adding one truthfully is not possible from the data sources
in use — bank statements and SMS do not carry it reliably. Reward rules would
therefore key off **envelope or payee**, which is an approximation. The app
already ships an approximation of this kind, correctly labelled: the tax screen
says it is an estimate on figures you enter. Rewards should say the same thing
in the same voice, or it will be read as a statement of fact and be wrong.

**Three period types, not one.** Indian cards set milestones on whichever window
the issuer likes, so a milestone has to name its own:

- **Statement cycle** — `accounts` already carries `statement_day`, and the card
  screens already reason in cycles.
- **Financial-year quarter** — Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar. This is the
  common one for quarterly spend milestones and it is *not* a calendar quarter.
- **Financial year** — Apr–Mar, for annual fee waivers and yearly thresholds.

The groundwork is there: `fiscalYearRange()` and `formatFiscalYear()` already
live in `src/core/dates.ts` and are used by the tax screen and the FY reports.
FY quarters are a small addition beside them.

The design consequence is worth stating: because one card can carry milestones
on different windows at once, progress cannot be "this cycle's spend". It has to
be a generic *(window → qualifying spend)* evaluation with the window chosen per
milestone — cleaner than special-casing, slightly more work. And two milestones
on different windows must never be presented as one running total, or the
number means nothing.

**Effort: 7–10 days for milestone progress** — spend against a threshold, on any
of the three windows, with the benefit named. Points accrual (base rates,
accelerated categories, monthly caps, and how caps interact) is a further
**4–6 days** and carries a permanent maintenance cost, because card terms change
and somebody has to keep the rules current. Ship milestones first.

## 5 · Chatbot expense logging

**Build Telegram. Treat WhatsApp as a different question with a privacy answer
attached.**

The parsing half is the easy half and is largely already written: `"450
groceries hdfc"` needs amount, envelope and account, and the app already has
expression parsing on the amount field and payee→envelope memory to lean on.

The transport is where the cost is.

**WhatsApp** needs a Meta app, business verification, a dedicated phone number,
and **an inbound public webhook**. A self-hosted household behind NAT has no
public URL, so either every household runs its own Meta app and verification —
which almost none will — or Flaxvin operates a shared relay, and every
household's spending messages pass through it. That contradicts the current
privacy position directly, and pulls in DPDP obligations on top of the ones
already open. Add the 24-hour session window and template approval for anything
the app initiates.

**Telegram** needs a bot token and nothing else. Long polling means **no inbound
webhook**, so it works behind NAT, which is the deciding difference for a
self-hosted app.

**Authentication is not optional.** A message maps to a member, and anyone who
finds the bot must not be able to spend the household's envelopes. A pairing
code issued in-app plus an allowlist of chat ids is the minimum.

**Effort: Telegram 5–8 days** end to end — polling loop, pairing and
authorisation, parser, a confirmation step before anything is written, and
tests. **WhatsApp is +8–12 days on top**, most of it Meta plumbing rather than
code, and it should not start until the relay question has an answer.

## 6 · Account Aggregator auto-sync

**This is a business and regulatory decision, not a sprint.** Do not start
engineering until two things are settled.

To pull data under the RBI's AA framework you must be a registered **Financial
Information User**, onboarded with an AA (Finvu, Setu, OneMoney, CAMSFinserv,
NADL). That is an entity-level registration with a commercial contract and
per-consent or per-fetch pricing. **A self-hosting household cannot be an FIU.**
So either Flaxvin Technologies is the FIU and financial data flows through
Flaxvin to each instance — which rewrites the privacy policy, changes the DPDP
posture, and makes the feature hosted-only — or the feature does not exist.
There is no third option where the household's own server talks to an AA.

The engineering, *after* that is resolved, is substantial in its own right:
consent creation and lifecycle, FI requests, decrypting FI data (ECDH key
material, not a REST call), parsing account and transaction schemas that vary by
FIP, and deduplicating everything against statements and SMS the household has
already imported — which is the part most likely to be underestimated.

**Effort: 20–30 days of engineering, after weeks-to-months of onboarding**, plus
a privacy policy rewrite and a clear answer about what Flaxvin retains. The
existing open DPDP items — registered address, named grievance officer — become
blocking rather than outstanding.

## 7 · Spending abroad, in two very different sizes

The original request covered two things that look alike and cost differently by
a factor of four. They are separated here, because **the cheap one is probably
the one that was wanted.**

### 7a · A transaction entered in foreign currency — 4–6 days

Type `$40`, have it stored as the rupees it cost. The envelope is an INR
envelope, Ready to Assign is an INR figure, and the identity never sees a
foreign number — the conversion happens at the edge, on the way in, and
everything downstream is unchanged. That is what makes this cheap: it is an
*entry* feature, not a budgeting one.

**What it stores.** `original_amount`, `original_currency`, `rate_used` and
`rate_source` on the transaction, with `amount` staying INR paise as it is
today. The `fx_rates` table already exists and already has a stale-rate policy.
The existing `raw_amount` convention — the original record is never overwritten
— is the same instinct and the same shape.

**The wrinkle that matters, and it is not small.** For a card used abroad, the
real rupee figure is **the bank's, not the market's**: an issuer's FX markup plus
any cross-currency fee typically lands 2–3.5% away from a mid-market rate. So a
converted figure is an *estimate until the statement arrives*, and the honest
design says so — convert at entry, mark the amount estimated, and let the
statement import correct `amount` to the real figure while keeping the foreign
original intact. The app already has this exact instinct elsewhere:
`amount_is_estimate` on schedules, and a tax screen that says plainly it is an
estimate on figures you enter.

Done that way the feature is genuinely useful and carries no risk to the
invariant. Done the naive way — convert at a market rate and present it as fact
— it quietly mis-states every foreign spend by a few percent for ever.

### 7b · Multi-currency envelopes — 15–25 days



A genuinely multi-currency budget — an envelope that *holds* dollars — is a
different proposition, and **the only item here that threatens the invariant.**

The groundwork exists: `fx_rates`, a `currency` column on accounts and
instruments, and a `FEATURE_MULTI_CURRENCY` flag. But it is deliberately
confined to *valuation* — `docs/limitations.md` states that budget accounts,
envelopes and Ready to Assign are single-currency, and R30 keeps asset accounts
out of the budget engine entirely. Extending it to envelopes means choosing
between two unattractive shapes:

- **Envelopes stay in base currency; foreign accounts convert.** The identity
  then breaks every time a rate moves, unless an explicit unrealised-FX term is
  added alongside `unfundedCreditAbsorbed`. That term has to be derived,
  documented in `docs/dev/01-engine-derivation.md`, and defended — it is a new
  place money can hide.
- **Each envelope carries a currency, and cross-currency assignment is
  refused.** The maths stays clean and the user experience gets worse: Ready to
  Assign stops being one number, and the budget screen becomes one screen per
  currency.

Either way, currency awareness propagates into auto-assign, move money, targets,
card funding, holds, departures and every report — and a rounding policy has to
be chosen and tested, because integer paise converted at a `REAL` rate and back
does not return the same number.

**Effort: 15–25 days**, with the widest uncertainty of anything on this list,
plus a migration and an engine-derivation rewrite.

**Recommendation: defer** unless a real household need exists — NRI income, a
foreign card being used monthly. The current limitation is documented honestly,
and "we only do rupees, on purpose" is a far better position than a
multi-currency implementation whose identity term nobody can explain.

---

## Summary

| # | Feature | Effort | Verdict |
|---|---|---|---|
| 1 | Locked categories | 2–3 d | **Build.** Add-only; departure exempt. |
| 2a | Group targets | 3–5 d | **Build.** |
| 2b | Pooling, display-only | +2–3 d | **Build** with 2a. |
| 2c | True nested categories | +8–12 d | Only for funding a parent, spending from children. |
| 3 | Richer recurrence rules | 3–5 d | **Build.** Fixes a latent fault and an unvalidated enum. |
| 4a | Card milestones, 3 windows | 7–10 d | **Build.** Cycle, FY quarter, FY year. |
| 4b | Points accrual | +4–6 d | Later. Permanent maintenance cost. |
| 5a | Telegram logging | 5–8 d | **Build.** NAT-friendly; pairing required. |
| 5b | WhatsApp | +8–12 d | Needs a privacy answer first. |
| 6 | Account Aggregator | 20–30 d + onboarding | Blocked on FIU registration. |
| 7a | Foreign-currency entry | 4–6 d | **Build.** Estimate until the statement lands. |
| 7b | Multi-currency envelopes | 15–25 d | **Defer.** Threatens the identity. |

**Suggested order: 1 → 3 → 2a+2b → 7a → 4a → 5a.** Roughly **24–37 days**, all
of it inside the existing architecture, none of it touching the accounting
identity, and no external party involved. Recurrence moves up the order because
part of it is a fix.

## Two defects found while estimating

Neither is part of any feature above, and both are in shipped code.

1. **`monthly-nth-weekday` advances as plain monthly.** It is in the
   `Recurrence` union and in the annualisation table, but `nextOccurrence()` has
   no case for it. Not reachable from the UI today, so latent rather than live.
2. **`recurrence` is cast, never validated.** All three schedule routes do
   `field(ctx.body, "recurrence") as Recurrence`, and the column has no `CHECK`
   constraint. Any string is storable and then behaves as monthly, silently.

The second is a data-integrity gap worth closing on its own — roughly half a day
with the migration and the tests — independent of whether recurrence rules are
ever built.

## The decision that gates the rest

**Two items wait on one question:** does household financial data ever leave the
household's own server? Answering it once settles both WhatsApp (5b) and Account
Aggregator (6). Until it is answered, neither should be started — and if the
answer is no, both are closed rather than pending, which is a better place for
them to be than a backlog.
