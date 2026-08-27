# Build decisions

**Status:** living record · **Started:** 26-08-2026 · **Owner:** Ravi
**Scope:** the decisions made *while building*, which the functional set
deliberately excludes ("functional design only. No data model, no API surface,
no tech stack, no code").

`09-decisions-log.md` records what the household decided. This records what the
**build** decided, and why — the choices a reader of `02`–`08` could not have
predicted, the places where implementing a rule taught us something the rule did
not say, and the handful of deliberate departures.

Written retroactively for B1–B24 on 28-08-2026, from the commit history and the
reasoning at the time. Everything after is recorded as it happens.

---

## 1. How to read this

Each decision has a number (`B1`, `B2`, …), what was chosen, and — the part
worth keeping — **what would have gone wrong otherwise**. A decision with no
failure mode behind it is a preference, and preferences do not belong here.

Where a build decision *contradicts* the functional set, it says so explicitly
and cites which rule wins. There is one of those (B14).

---

## 2. Foundations

### B1 · Zero runtime dependencies

Node 26 ships `node:sqlite`, `node:test`, `node:http`, `node:zlib` and
`node:crypto`. Everything the app needs is in the runtime, so `package.json` has
no `dependencies` block at all — only TypeScript and `@types/node` to build with.

**Why it matters here specifically.** `08` §12 says the 2am page must be real,
and Q8 puts the deployment on a homelab box behind a tunnel. A dependency tree
is the most likely thing to break a deployment that nobody is watching: a
transitive package is yanked, a lockfile drifts, an install fails on a Node
upgrade. None of that can happen to a tree of size zero.

The cost is real and is paid in three places — the PDF reader (B18), RC4 (B19)
and multipart parsing (B21). Each is a few hundred lines that a library would
have provided. Each is also exactly scoped to what this app does, which is why
they are testable in full.

### B2 · Server-rendered HTML, no client framework

Not a preference — forced, twice over. R39.3 requires the resolved theme in the
first response so there is no flash of the wrong one, and R35 forbids client
storage of user data. Together they leave the server rendering the page and the
client holding nothing. The client script is a few hundred bytes of progressive
enhancement.

**Otherwise:** a framework would have introduced a client store, and R35 dies
the moment one exists. `08` S10 makes this a standing rule: *"the moment a read
cache appears, R35 is dead and every deleted subsystem in §3.2 comes back."*

### B3 · Integer paise everywhere, with two documented exceptions

All money is integer paise. `Number.MAX_SAFE_INTEGER` is about ₹90,07,19,92,54,740,
so the household will not reach it.

Two places deliberately do not use paise, both because a doc demanded it:

| Exception | Unit | Required by |
|---|---|---|
| Amortisation internals | unrounded rupees, `toPaise()` at boundaries only | `06` §12 — the 33 published figures do not reproduce from rounded intermediates |
| Holdings | units as **milliunits** (1e-3), prices as **micro-rupees** (1e-6) | R24.3 stores units to three decimals; a NAV carries five |

**Otherwise:** rounding at every step of a 240-month schedule accumulates into
rupees, and `06`'s worked example stops being reproducible — which is how a loan
module quietly loses the trust it exists to earn.

### B4 · The engine's identity was derived before the engine was written

`docs/dev/01-engine-derivation.md` came first: the accounting identity every
month must satisfy, derived from `02` §4 and checked against R2's worked
example, before a line of `src/engine/`. It is asserted after **every** engine
test scenario.

**Otherwise:** `05` §7's named risk — *"engine semantics get subtly wrong and
are discovered in month four"*. This is the cheapest possible guard against it,
and it earned its place immediately: it caught credit overspend being absorbed
in the wrong month (B22).

### B5 · Event log and idempotency keys were built third, before any feature

`05` §3 lists three things that can never be retrofitted: the engine's
semantics, idempotency keys, and the event log. Two of those are infrastructure,
so they were built immediately after the schema and before the first feature —
not because they were needed yet, but because every later write had to be able
to assume them.

**Otherwise:** a feature written against a database without an event log writes
directly, and retrofitting the log means auditing every write in the app. Undo,
"explain this number", and as-of-date views all become impossible rather than
merely difficult.

---

## 3. The recurring lesson: identity must be recorded, not inferred

Three separate bugs, found weeks apart in three unrelated subsystems, turned out
to be the same mistake. They are grouped here because the pattern is the useful
part.

### B6 · An imported row's identity is its content, not its file name

The import source id embedded the file name: `csv:statement.csv:7:2026-08-03:-45000`.
Re-downloading the same statement and saving it as `hdfc-august.csv` produced
different ids for identical rows, and I5 — *zero new transactions **and** zero
new review items* — silently failed. The whole month queued a second time.

Identity is now a hash of the row's own content plus an **occurrence index**.
The index is what keeps D2 working: two genuinely identical transactions (two
people, same shop, same amount, same day — `04` calls this normal) are two rows
in the file, take occurrences 0 and 1, and both survive. Re-importing that file
produces the same two occurrences and skips both.

### B7 · A CAS row's identity is recorded on the lot it creates

The obvious match for a statement row against an existing holding is trade date
and units. It is wrong, and wrong in a way that only appears in month two:
R25.4 splits a lot on a partial sale, so last month's 500-unit purchase is a
400-unit residual by the time the next statement arrives, and the row that
created it matches nothing. The naive import then duplicates it.

Migration `0006` adds `source_ref` to `lots` and `holding_events`. The row's
reference is *written down* when the lot is created, so a later statement
recognises it regardless of what has happened to the lot since.

### B8 · The price fetch log records the price

P3 says every fetch must record *"instrument, provider, request time, response
status, and the price returned"*, and explains why: *"this log is what makes a
bad number explainable three months later"*. The table had no column for the
price. It could answer "did the call succeed", which is not the question.

Migration `0008` adds `price`, `as_of` and `class`.

**The pattern, stated once.** In all three, identity or provenance was being
*inferred at read time from state that legitimately changes*, rather than
*recorded at write time*. The fix is the same each time and it is cheap: write
down what you knew when you knew it.

---

## 4. Verification

### B9 · Every worked example in the docs is a test

`02` R2 and R4, all 33 figures in `06`, `07` §10's portfolio figures, `09` §5's
reconciliation scenario. Not paraphrased — the same inputs, asserted against the
same published outputs.

**This is what found the errata.** E13 exists because R24.3's three-decimal
units could not reproduce `07` §10's figures, and the discrepancy was a test
failure rather than an opinion.

### B10 · R30's firewall is a test suite, which is more than Q15 asked for

Q15 declined R30-as-a-build-gate; errata E8 records that, and `05` §8 puts the
holdings engine first. R30 is built as a ten-invariant test suite anyway.

This is a **superset**, not a contradiction: the decision was that R30 must not
*block the build*, and it does not — it is ordinary test coverage. FW10 goes
furthest: it drops the `prices` and `fx_rates` tables outright and renders the
budget screen, because the claim being tested is that the budget engine never
reads them, and the only convincing proof is removing them.

### B11 · Hand-rolled cryptography is tested against published vectors, never against itself

RC4 (B19) is checked against RFC 6229 and the widely published `Key`/`Plaintext`
vectors. The PDF decryptor is checked against five files generated by **qpdf**.

**Otherwise:** a decryptor tested only against its own encryptor proves that two
copies of the same misunderstanding agree. Every fixture in
`src/pdf/fixtures.test-data.ts` was produced by software that has never seen
this codebase.

### B12 · `verify_docs.py` reads the errata, so known corrections are not failures

The script scans the normative documents for lines contradicted by decisions
recorded elsewhere, and consults `10` §2 so an already-corrected line reports as
*known* rather than as a failure.

**It earned itself on the first run**, finding E12 — a line in `02` F14.3 that
still implied push existed somewhere, which ten manual passes had missed.

### B13 · An unverified external surface is verified before it is coded against

`10` §3.3 flagged AMFI's endpoint as unverified and said to check the URL and
format *before* writing the adapter. That was done, and the result is recorded
in §3.3.

**It was worth doing.** The live file forces two things a guess would have
missed: a scheme carries **two** ISINs (growth/payout and reinvestment) and a
holding may be identified by either; and the file contains rows dated years
back, so R26.2's published date must be carried through rather than stamped with
the fetch date.

---

## 5. Deliberate departures and judgment calls

### B14 · Importing a CAS creates no budget transaction — FW4 does not apply

FW4 makes buying an investment a transfer from a Budget account consuming a
savings category, so envelope arithmetic stays whole. Applied literally to a CAS
import, that is wrong: the money left the bank months ago and is **already in
the ledger** from the bank statement import. Creating the transfer again
double-counts the spending.

`recordPurchase` still does it for a purchase entered by hand, where the
transfer is the only record of the money moving. Asserted by a test that imports
a CAS and checks the transaction count is zero.

**This is the one place the build does not do what a rule says literally.** The
rule's purpose — envelope arithmetic stays whole — is served by *not* applying
it here.

### B15 · Pro-rata FIFO, because it is the only self-consistent convention

At NAV 82.50, ₹25,000 buys 303.030 units (R24.3), not 303.0303…, so those units
cost fractionally more than NAV each. Pro-rating what was actually paid — rather
than recomputing units × NAV — is the only convention under which **selling a
holding entirely realises exactly the gain that was showing as unrealised the
moment before**. There is a test for that invariant.

A user would notice the contradiction. They will not notice a paisa. Recorded as
errata E13.

### B16 · Closing a month locks nothing

`08` S5 asks for a close ritual. It would be natural to make it a state
transition. It is not one, and migration `0007` has no column that could become
one.

R13's rollover is derived arithmetic rather than a job, and R7.g keeps every
past month editable. A close records that a human looked and takes a dated net
worth snapshot. It can be reopened, closing twice is harmless, and it undoes
like anything else — **which is what makes it safe to make a habit of**. A
ritual with a consequence is a ritual people avoid.

### B17 · Notification preferences are stored as mutes, not subscriptions

F14.2 requires each notification type to be individually toggleable. Storing
what a member *wants* would mean a member who has never opened settings gets
nothing. Storing what they have *turned off* means the default is on.

**Otherwise:** the most important item in the digest — *"₹3,200 of your card
balance has no envelope behind it"* — would never reach the person who most
needs it, because they never went looking for a settings page.

---

## 6. The parts a library would normally provide

### B18 · The PDF reader ignores the cross-reference table

`src/pdf/objects.ts` scans for every `N G obj` in the file rather than following
the xref. Statement PDFs are small, and broken xref offsets are the single most
common reason a real generator's file will not open in a strict reader.

Object streams are expanded *after* decryption, because in an encrypted document
the container's bytes are encrypted but the objects inside inherit its
protection and must not be decrypted twice.

### B19 · RC4 is implemented here because Node 26 removed it

The standard PDF security handler at revisions 2–4 encrypts with RC4, and that
is what registrar generators still emit. `node:crypto` no longer offers it. It
is thirty lines, it is used for exactly one thing — reading a file the household
already has — and its header says so, so nobody reaches for it later.

### B20 · Text extraction keeps positions

Concatenating strings in reading order turns a CAS table into
`Purchase25,000.00312.500`, which no parser recovers. Pieces are collected with
their text-matrix position, grouped into lines by Y and ordered by X, with a gap
wider than a third of the nominal glyph width becoming a column break.

**A statement is a table, and a table only survives extraction if the layout
does.**

### B21 · Multipart bodies are parsed over raw bytes

The existing body reader decoded to UTF-8. A PDF pushed through that has every
invalid byte replaced with U+FFFD — the file is destroyed while the upload
appears to have worked. `parseMultipart` works on the `Buffer` and never
stringifies a file part. There is a test asserting bytes `0x80`–`0xFF` survive.

---

## 7. Operational shape

### B22 · Bugs the identity assertion and the docs caught

Recorded because each one is an argument for a practice, not for a fix.

| Bug | Found by | The lesson |
|---|---|---|
| Credit overspend absorbed in the wrong month | the B4 identity assertion | An invariant asserted everywhere finds what no test targets |
| `450++120` evaluated to ₹570 | a unit test on the expression parser | Unary sign needs a position rule, not a character rule |
| R6's unfunded-card warning could never fire | reading R6 against the code | Envelope and debt move together by construction; the warning needed per-card attribution |
| Impersonation expired instantly | a live check | A timestamp built in UTC and labelled `+05:30` is wrong by 5½ hours |
| Drift measured against the app's own schedule | reading R18.8 | R18.8 measures against a *lender statement*; drift is null until one exists |
| A foreign lot cost ₹1,500 instead of ₹1,24,500 | the `07` worked example | R33's frozen trade-date rate applies to **cost**, not only to display |
| Two tests passed locally and failed as root in a container | the Docker build | A test asserting "this path is unwritable" is a test about the user, not the code |

### B23 · In-memory state where the deployment is one box

Two things are held in memory rather than in the database: the API token rate
limiter, and the CAS plan between the review screen and its confirmation.

Q8 puts this on one box as one process, so there is nothing to share them with.
A rate limiter that writes a row per request makes the problem it exists to
solve worse; and a plan derived from a password-protected statement is
specifically the thing that must not round-trip through a hidden form field.

### B24 · The dev bypass is absent from the production image structurally

The Dockerfile compiles first, then deletes both `auth/dev-login.ts` and its
compiled output, then asserts absence with `test ! -f`. R38.5 is therefore a
property of the image rather than a promise about configuration — the module is
loaded by dynamic import, so it cannot be present to import.

Compiling before deleting is not incidental: deleting first breaks `tsc`, which
is how the first attempt failed.

---

## 8. Open — carried forward

### B25 · Private lending within the family needs its own account type

*Raised 28-08-2026.* Money lent to or borrowed from family is neither a bank
account nor an institutional loan, and modelling it as either is wrong in a way
that shows up immediately:

- As a **loan**, `06`'s machinery does not fit — there is usually no interest
  rate, no EMI, no schedule and no lender statement to reconcile against, and
  R18.8's drift is meaningless.
- As a **tracking account**, the balance is untethered from the transactions
  that created it, and the household loses the one thing they actually want:
  *what is outstanding, since when, and what has been repaid.*

Specified in `10` §3.5 as F2.10 and FL1–FL9, and built as the `family-loan`
subtype. See B26.

---

## 9. Recorded as it happened

### B26 · A family loan is a Tracking account whose balance is derived

*28-08-2026.* F2.10 built as the `family-loan` subtype. Advances and repayments
are ordinary **transfers** against a Budget account, which buys three of the
rules for free rather than by special-casing:

- **FL2** — the balance is the account balance, so there is nothing to type. The
  table has no balance column, and a test asserts that.
- **FL4** — a transfer consumes no category, so lending does not read as
  spending and repayment does not read as income, anywhere in the app.
- **FL3** — the cash side is real, so R1 stays true.

Two things the implementation had to decide that FL1–FL9 did not say:

- **A write-off is not a repayment.** It closes the balance, but nobody paid it
  back, and counting it in the repaid tally would overstate what the
  counterparty actually returned — which is exactly the figure FL6 exists to
  state honestly. The write-off transaction is excluded by id.
- **Forgiving a debt you owed is refused, not guessed at.** It is income, not an
  expense, and it is rare enough that quietly picking a treatment would be worse
  than saying so. The error says what to do instead.

### B27 · A transfer to a Tracking account leaves the budget — an engine fix

Building B26 broke the identity from `docs/dev/01-engine-derivation.md` by
exactly the amount lent, which exposed a **pre-existing bug** in the repository:
*all* transfer legs on a budget account were excluded from Ready to Assign.

The derivation's §3 says "transfers are excluded entirely" and gives two
reasons — budget↔budget nets to zero, and budget↔credit must reduce the card's
payment envelope (R6). Both are about transfers that are **internal to the
budget**. A transfer to a Tracking account is a third case the sentence did not
anticipate: one side is outside the budget, so the money really is gone.

The effect was not limited to family loans. Buying an asset by transfer, or
repaying loan principal by transfer, had the same hole — the budget-account
balance dropped while Ready to Assign and every category stayed put, and R1's
"money you have" quietly overstated itself.

Fixed by excluding a leg only when its counterpart account is `budget` or
`credit`. A budget-side leg facing a Tracking account now behaves like any
other flow: it reduces RTA when it carries no category, and is absorbed by the
envelope when it does — which is exactly FW4's shape.

**Why this is the entry worth reading.** B4 predicted this: an invariant
asserted everywhere finds what no test targets. But the identity is only
asserted over the *pure engine's* scenario builder, and this bug lived in the
**SQL that feeds it** — so it sat undetected until a feature happened to
construct the missing shape. The four regression tests now live in
`repository.test.ts`, on the integration side of that seam.

The lesson is narrower than "assert invariants": assert them **on both sides of
every seam where two implementations of the same definition meet**.
`repository.test.ts` already opened by saying those two paths can drift. They
had.

---

*Entries B28 onward are recorded as the work happens.*
