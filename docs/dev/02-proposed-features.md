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

Lock governs **assignment**, not spending. Money already in a locked envelope
cannot be moved out or assigned down; spending *from* it still reduces the
balance, because refusing that would mean refusing to record something that
actually happened. Getting that distinction wrong is the whole risk.

**Touches.** A `locked_at` column on `categories`, then every writer that can
reduce an envelope: `setAssigned` and `moveMoney` in `src/domain/budget.ts`, and
their callers — `departure.ts` (which pulls a leaving member's balances back),
`card-emi.ts`, `loans.ts`, and the auto-assign and cover-overspending paths in
`app.ts`. `suggestCoverSources()` in the engine must stop proposing locked
envelopes, or the app will keep recommending a move it then refuses.

**Effort: 2–3 days.** Most of it is the sweep across writers and a test per
writer proving the refusal actually bites. No schema risk, no engine maths, no
migration beyond one column.

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

## 3 · Fuzzy scheduling

For irregular commitments: a quarterly bonus that lands "sometime in April", a
service every four to six weeks, a bill due "around the 15th".

`Recurrence` is a closed union of eight values and `next_due` is a single date.
Fuzziness means a **window**: either a tolerance in days or an earliest/latest
pair. The rule that keeps it honest is *fund by the earliest date, display the
band* — a schedule-linked target (R8) needs a date to fund by, and choosing the
optimistic end of a window is how a household ends up short.

**Touches.** `nextOccurrence()`, `projectCashflow()` (a line becomes a band, and
the cashflow screen has to show that without implying false precision),
`markPaid()` (which should recompute the window from what actually happened, so
the estimate improves with use), the calendar, and schedule-linked targets.
`detectSchedules()` already computes a confidence and is the natural place for
detected-but-irregular schedules to land as fuzzy rather than be discarded.

**Effort: 4–6 days.** Self-contained, no external dependency, but projections
are well covered by tests and a band is genuinely harder to present than a date.

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

**Touches.** New `card_reward_rules` and `card_milestones` tables, and spend
measured per **statement cycle** rather than per calendar month — `accounts`
already carries `statement_day`, and the card screens already reason in cycles,
so the hard part is mostly done.

**Effort: 6–9 days for milestone progress** (spend against a threshold, per
cycle and per year, with the benefit named). Points accrual — base rates,
accelerated categories, monthly caps, capping interactions — is a further
**4–6 days** and carries a permanent maintenance cost, because card terms change
and somebody has to keep the rules current. Ship milestones first; treat points
as a separate decision.

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

## 7 · Multi-currency budget envelopes

**The most expensive item here, and the only one that threatens the invariant.**

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
| 1 | Locked categories | 2–3 d | **Build.** Cheapest, clearly useful. |
| 2a | Group targets | 3–5 d | **Build.** |
| 2b | Pooling, display-only | +2–3 d | **Build** with 2a. |
| 2c | True nested categories | +8–12 d | Only for funding a parent, spending from children. |
| 3 | Fuzzy scheduling | 4–6 d | **Build.** Fund by earliest, show the band. |
| 4a | Card milestones | 6–9 d | **Build.** Label it an estimate. |
| 4b | Points accrual | +4–6 d | Later. Permanent maintenance cost. |
| 5a | Telegram logging | 5–8 d | **Build.** NAT-friendly; pairing required. |
| 5b | WhatsApp | +8–12 d | Needs a privacy answer first. |
| 6 | Account Aggregator | 20–30 d + onboarding | Blocked on FIU registration. |
| 7 | Multi-currency envelopes | 15–25 d | **Defer.** Threatens the identity. |

**Suggested order: 1 → 2a+2b → 3 → 4a → 5a.** Roughly 20–31 days, all of it
inside the existing architecture, none of it touching the accounting identity,
and no external party involved.

**Two decisions gate the rest, and they are the same decision:** does household
financial data ever leave the household's own server? Answering it once settles
both WhatsApp (6) and Account Aggregator (7). Until it is answered, neither
should be started — and if the answer is no, both are closed rather than
pending, which is a better place for them to be than a backlog.
