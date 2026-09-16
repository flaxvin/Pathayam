# Decisions that still bind

The ones worth knowing before changing anything. The full history — every
decision taken during the build, in order, with its reasoning — is in
[`archive/09-decisions-log.md`](archive/09-decisions-log.md).

## Product

**A budget engine, not a tracker.** Money is assigned until nothing is
unassigned. Overspending is handled explicitly. An app that only categorises
what already happened is a different product.

**One household, self-hosted.** Not a SaaS. That decision removes multi-tenancy,
billing, and somebody else holding the family's complete financial history.
[`archive/12-saas-conversion.md`](archive/12-saas-conversion.md) and
[`archive/13-hosted-service-plan.md`](archive/13-hosted-service-plan.md) record
what a hosted version would take, if that ever changes.

**Indian banking, specifically.** UPI narration shapes, split credit-card
cycles, password-derived statement PDFs, reducing-balance and flat loans, EMI
conversion, CAS portfolio imports. These are not generalisable features and are
not meant to be.

**₹ only, by default.** Multi-currency exists behind a flag. A hand-valued
account in another currency is converted at the dated rate like a holding is —
which nobody noticed was missing until a simulation held a Singapore account and
₹25.6 lakh was being counted as ₹42,000.

## Engineering

**Zero runtime dependencies.** No supply chain to audit, no lockfile drift, no
upgrade treadmill for an app one household runs for years. Everything that would
be a package — HTTP, SQLite, templating, charts, PDF, CSV — is in the platform
or in `src/`.

**Server-rendered, no client framework.** First paint is complete. The client
script adds shortcuts and inline submission, and the app works with it disabled.
That constraint has caught real defects: a control that submitted itself with
`onchange` did nothing without scripting.

**Integer paise, everywhere.** No float goes near a balance.

**The engine is pure.** No I/O, so it can be exhaustively tested and the
identity can be asserted after every month of a three-year run.

**Business logic in the domain, not the router.** A step that lives only in a
route handler cannot be reached by a simulation. This has been violated once and
cost the entire rules lifecycle going unexercised for three simulated years.

**Migrations are append-only and the app refuses to start on a newer schema.**
Guessing at a schema you do not know is how a ledger gets corrupted.

## Privacy and security

**Not-found, never "not allowed".** A refusal confirms the thing exists, and for
a private account the existence is the disclosure.

**Totals are a disclosure surface.** A figure that includes what somebody cannot
see publishes it by subtraction.

**Guards are structural, not remembered.** Fourteen privacy leaks have been
found. Each time the question was not "fix it" but "what kind of blindness let
it through" — and the answer was never the same twice, which is why there are
three differently-shaped guards rather than one bigger one.
See [privacy.md](privacy.md).

**Enforce in one place, not in a hundred templates.** Same-origin checking is
one middleware rather than a hidden field in each of 105 forms, because the
106th is the one somebody forgets.

**Secrets never leave the box.** Statement identity and Gmail tokens are
excluded from every export and never logged.

## Working practice

Three habits that produced most of the defects found, and are worth keeping.

**A synthetic fixture is evidence about the fixture.** A simulated statement
line read `UPI/DMART/4471920/GROCERY`, and because the merchant is the longest
segment, every learned rule was about a payee called "Grocery". The instinct was
to fix the extractor. A corpus of 1,856 real transactions said the extractor was
right and the fixture was wrong — first-segment gives "Bank Upi" and "L Td Upi"
on real data.

**More rows is not better.** Three parser changes made statements parse that
never had, and were wrong: they read the balance column as the amount, invented
transactions from brought-forward lines, and merged two real payments into one.
Only an oracle the change cannot influence — the bank's own printed closing
balance — could tell the difference.

**Count what a run produced, not what it called.** Coverage said every function
was exercised. Three features had never left a row behind.

## Deliberately not done

- **No bank API connections.** India has no usable open-banking surface for a
  self-hosted app, and this will not screen-scrape a bank login with somebody's
  real credentials.
- **No SMS parsing.** It needs a phone-side agent; the alert emails carry the
  same information.
- **No offline-first sync.** Withdrawn during the build. A local-first replica
  of a financial ledger is a distributed-systems project, and the failure mode
  is a household's accounts disagreeing with themselves.
- **The PDF text extractor's word spacing.** Some generators split a word across
  columns, so 29% of payee names arriving by PDF carry a space inside a word
  (`Fino P A Ym`). Five attempts at fixing it are recorded in
  [`archive/18-second-top-down.md`](archive/18-second-top-down.md); four made
  statements unreadable and the fifth cost three real transactions. The
  information needed to reconstruct the boundaries is destroyed by the layout
  pass. Left alone knowingly.
