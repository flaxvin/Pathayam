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

### B28 · Text extraction preserves column alignment, because that is the data

*28-08-2026.* The extractor originally emitted two spaces for any column gap.
That is enough to split a CAS row, where every column is populated, and it is
**not** enough for a bank statement, where the whole difficulty is that an empty
column vanishes:

```
03/08/26  UPI-SWIGGY   431202847592  03/08/26  450.00              144550.00
05/08/26  NEFT-SALARY  N123456789    05/08/26            145000.00 289550.00
```

Collapsed to two-space gaps, both rows read as "date, text, ref, date, figure,
figure". Nothing in that says the first ₹450 is a withdrawal and the second
₹1,45,000 is a deposit — and getting it backwards does not fail loudly. It
silently inverts a transaction, which is the worst thing an importer can do.

`layout()` now places each piece at the character column its x-position
implies, using a character width derived from the pieces themselves rather than
assumed. Column positions survive, and `readHeader` reads the table's headings
to find out where "Withdrawal Amt." actually is.

**The bug this surfaced in the test method.** The first fixtures were
hand-typed strings with two-space separators — an approximation of what
extraction produces. They passed while the real chain would have failed,
because the approximation had thrown away the very property under test. The
fixtures are now real PDFs run through the real reader, and the tests exercise
decrypt → extract → recognise → parse end to end.

### B29 · A figure belongs to the column it sits under, not to the nearest one

The first assignment asked, per column, "which figure is nearest?". In the ICICI
layout the deposit column begins a few characters past the end of the
*withdrawal* heading, so the withdrawal column claims the deposit figure and
every salary becomes an expense.

Inverted: each figure is assigned to **its own** best column, scored by span
overlap rather than edge distance. Overlap is indifferent to whether a bank
left- or right-aligns its figures, and the banks do not agree with each other
about that.

### B30 · The statement layouts are unverified, and say so

*28-08-2026.* The parsers for HDFC, ICICI, Axis and SBI are written from the
banks' published formats, **not** from opening this household's own statements.

Every real statement is password-protected — Axis wants the first four letters
of the name plus DDMM of birth, ICICI wants lowercase personal details, the
brokers want a PAN. Those are precisely the values PR5 says are used once at
import and never stored, and they have no business being handed to a build
process or living in a repository as a test fixture.

So the module carries an `[unverified against a live file]` tag, the same
convention `10` §3.3 used before AMFI was checked, and the fixtures are
synthetic PDFs generated for the purpose. Two things make an incorrect guess
survivable rather than damaging:

1. **An unrecognised statement is a mapping task, not an error.** Failing to
   detect a bank, or parsing zero rows, routes the extracted text to the same
   mapping UI an unrecognised CSV goes to (B6's §3.2 path). The household names
   the columns once.
2. **Each layout is a small table with its own test**, so correcting one
   against a real file is a line, not a rewrite.

### B31 · What the inbox was actually good for

The statements themselves could not be opened, but reading the emails they
arrive in produced two things that went straight into the build:

- **The per-bank password rules**, now shown in the import screen. "It is
  usually your PAN, in lowercase" is the difference between an import that
  works and one that is abandoned at the password box, and every bank states
  its own rule in its own email.
- **The sender-to-institution map** (`STATEMENT_SENDERS`), which `04` §3.4
  needs for Gmail ingestion and which also routes a CDSL CAS to the portfolio
  importer rather than the bank one. Its patterns are anchored, so a lookalike
  domain cannot impersonate a bank into being trusted — there is a test for
  that.

### B32 · The running balance decides the sign, not the column position

*28-08-2026, from a real statement.* B29's assignment-by-column was reasonable
and wrong, and only a real file could show it. Across **848 rows** of an actual
Axis account, debit figures occupied character columns 67–85 and credit figures
81–99. **They overlap.** The columns are right-aligned to a ragged edge, so a
₹640 debit is printed further right than a ₹2,500 debit and lands squarely
under the "Credit" heading.

A parser that trusts position therefore inverts a large share of transactions
while looking completely healthy — no exception, no empty result, just a
statement where half the spending is income.

Every Indian bank statement prints a running balance, and the movement between
two rows **is** the amount, sign included. On that same file it resolved 845 of
848 rows to the exact printed figure, and the three it did not are rows where
the printed figure genuinely disagrees. So:

1. Balance movement decides the amount.
2. Column position is the fallback, for statements with no balance column.
3. The printed figure **verifies** the movement rather than deriving it; a
   disagreement is reported (IL3) rather than resolved silently.

This also made layout largely irrelevant, which matters more than the fix
itself: the parser no longer needs a per-bank column map to get signs right, so
the seven banks whose layouts remain unverified are far less risky than B30
assumed.

### B33 · Narration wraps upward, and losing it breaks three things at once

The same file: a payee is printed across two lines with the **date on the
second**.

```
                     UPI/P2M/400111223000/Zoomcar
 01-12-2025          /Making/Kotak Mahindra Bank    640.00      148212.55
```

Reading only dated lines yields "/Making/Kotak Mahindra Bank" — the merchant is
on the line above. That is not a cosmetic loss: payee matching, rule matching
and dedupe all key off the narration, so all three degrade together and none of
them says why. Continuation lines are now carried down into the row.

### B34 · The statement's own closing balance is an integrity check worth surfacing

Once amounts come from balance movements, the parse can be checked against a
number the bank printed and the parser never touched: opening balance, plus
every parsed amount, should equal the closing balance. On the real file —
₹11,33,172.01 plus ₹−9,98,303.49 — it lands on ₹1,34,868.52, exactly what the
statement says.

It is reported to the household in those words, because nothing else this app
does gets that kind of independent confirmation, and because "it reconciles" is
the difference between trusting an import and spot-checking 848 rows.

### B35 · PR5 is reversed, opt-in, and the settings screen says so

*28-08-2026.* Unattended fetching (`04` §3.4) cannot coexist with PR5's
*"never persisted"*, because Indian banks derive the password from your name,
date of birth or PAN — so storing those **is** storing the password, and
storing only the derived string would be worse (same exposure, and it breaks
silently when a bank changes its rule).

Specified as PR5.1–PR5.6 in `10` §3.6. Three boundaries are enforced by tests
rather than by intention: never in an export (F15 output travels), never in the
event log (R37 keeps it forever), never returned unmasked to a screen. Stored
in the clear, consistent with `08` S9's refusal of at-rest encryption and its
reasoning about key management.

The settings copy states the cost in plain terms — *"this is the same as saving
your statement passwords, which the app otherwise never keeps"* — because a
household consenting to a reversal should be consenting to the real thing.

### B36 · The password candidates are a list, and every one is tried

A bank that wanted DDMM last year wants DDMMYYYY this year. `bankId` only
**reorders** the candidates; all of them are still attempted, so a changed rule
costs a few milliseconds instead of a failed import. Trying a wrong password
against a local file has no cost worth optimising — there is no server to
rate-limit and no account to lock.

What opened it is reported as a description — "your PAN", "your name and date
of birth" — never as the value.

### B37 · The bank's password is usually the **owner** password, not the user one

*28-08-2026, against 81 real statements.* Six institutions would not open with
any derived candidate, and it looked like the derivation was wrong. It was not.
qpdf's verdict on a Union Bank statement:

> Supplied password is owner password. User password = «a customer number»

*(the number is the account holder's internal customer id, redacted here)*

The bank's own email tells the customer to type first-four-of-name plus DDMM —
`RAVI0101` for their worked example. That string
is the **owner** password. The user password is an internal customer number
nobody is given. A decryptor implementing only Algorithm 6 therefore rejects
the one password the bank documented.

Algorithm 7 recovers the user password by decrypting `/O` with a key derived
from the owner password, and it is now tried for every candidate. Union Bank
went from 0 of 6 files to 6 of 6, all reconciling.

**The lesson beyond PDFs:** when a documented input fails, check whether the
documentation and the implementation mean the same thing by the word. An
independent implementation said "owner password" in one line; another day of
brute-forcing candidates would not have.

### B38 · Everything that "obviously" ends a table appears above one

Table-end detection began with `Summary`, `Closing Balance` and
`IMPORTANT INFORMATION`. Each is a section heading printed *before* the
transactions in at least one real statement — Axis leads with a summary block
and a closing-balance footnote, HDFC's card with IMPORTANT INFORMATION — and
each silently discarded **every row** of the files it appeared in. Axis fell
from 895 rows to 173 and reconciliation went from clean to broken.

What survives is the one marker with no ambiguity: Union Bank's `LINKED LOAN &
ADVANCES` appendix, whose rows carry a date and a balance and would otherwise
import as an ₹18 lakh movement that never happened.

A heuristic that discards data needs far stronger evidence than one that keeps
it. This list is now short on purpose.

### B39 · What real statements do that invented ones do not

Each of these cost a broken parse and is now a regression test. They are worth
listing because none of them was imaginable from the format documentation:

| What | Where it showed up |
|---|---|
| Narration wraps **around** the dated line, not just above it | Union Bank puts one fragment above and one below the same row |
| Rows open with a **serial number** before the date | Union Bank |
| The date is followed by `\| 23:08` | HDFC card |
| A **single space** separates date and narration, so column splitting never sees two fields | YES Bank |
| A trailing **branch code** after the balance | Axis |
| The rupee sign decodes as the letter **C** | HDFC card — the font maps ₹ to 0x43, so a faithful extractor reports `C 491.00` |
| The letterhead is the **customer's postal address**; the bank is named only by its IFSC prefix | Axis |
| Per-glyph positioning splits words: `A XIS BANK`, `R elationship` | Axis |
| A **statement period** — `15/02/2026 To 14/03/2026 … Credit Limit: Rs. 3,00,000.00` — parses as the largest transaction on the file | YES Bank |
| Summary labels sit in the table's vertical band and glue onto payees | Axis, HDFC, ICICI |

The last two are the dangerous class: they do not fail, they produce plausible
wrong numbers. A ₹3,00,000 "purchase" would have gone through dedupe, rules and
the review queue looking exactly like a transaction.

### B40 · Fragments are assigned to the nearest row, and must be indented past the date

Attaching every wrapped line to the row above — the obvious rule — glues each
row's *opening* fragment onto its predecessor, so every payee lands one
transaction late. Nearest-row-wins, ties going upward, handles both Axis
(fragment above) and Union Bank (fragments both sides), because a wrapped cell
is vertically centred on its own row.

A fragment must also be **indented past its row's date column**, which is what
distinguishes a wrapped payee from a letterhead: the letterhead starts at the
left margin.

### B41 · Where this got to, and what it still cannot open

Against 81 real statements from 13 institutions:

- **58 of 77** open. All 12 files that print both an opening and a closing
  balance reconcile exactly — 0 failures.
- **1,856 transactions** parsed from 52 files.
- **19 remain locked**: SBI accounts, SBI Card, Canara and HSBC use a password
  derivable from neither PAN, date of birth nor name — verified against qpdf,
  so it is the password and not the reader. Those need the household to type it
  once, which is the path that already exists.
- RBL prints two tables side by side on the page, so its rows interleave with
  an account summary. Left unparsed rather than guessed at.

---

### B42 · Four password rules need a card number or a mobile, not just PAN and DOB

*28-08-2026.* The household supplied the exact rules for the four institutions
B41 left locked, quoted from each statement email:

- **SBI account** — last five of the registered mobile, then DOB as DDMMYY.
- **SBI Card** — DOB as DDMMYYYY, then the card's last four.
- **Canara** — the card's last four, alone.
- **HSBC** — DOB as DDMMYY, then the card's last six.

Each needs a datum the identity triple does not hold. The turn is that the app
*already* stores a card's last four per account, for SMS matching (F2.9) — so
Canara and SBI Card derive on the auto-fetch path with nothing extra, once the
destination account's last four is handed to the derivation. SBI's account rule
took one more optional identity field, the registered mobile; HSBC's last-six
needs a fuller number than the stored last-four and so falls back to
type-it-once.

I could not crack the four real files, because the card and mobile digits are
masked in the filenames and absent from the PDFs I hold — so the rules are
verified the honest way instead: against each bank's own worked example, the
same standard Union Bank's RAVI0101 met. What this closes is the *capability* —
the household with these accounts configured will have the last four, and the
statements will open.

Migration 0011 adds the mobile column; it never leaves the server, asserted by
the same export and event-log tests as the rest of the identity.

---

### B43 · Allocation is by asset class, which the instrument kind cannot supply

*28-08-2026 · F19.11.* The obvious source for "allocation by class" is the
instrument's kind — but a `mutual-fund` kind says nothing about whether the
fund is equity, debt or gold, so grouping by it reports a portfolio as "100%
mutual-fund". Class is therefore a field of its own (migration 0012), seeded
from kind only where the kind decides it: an ETF is equity, a bond is debt, a
commodity is gold. A mutual fund's class starts null.

N9 governs the null. An unclassified fund is **not** folded into a bucket on a
guess — it is reported as its own figure, above the percentages, with a one-tap
classifier, and the shares are of the *classified* total so they never imply a
precision the data does not have. Manually-valued assets need no such step:
their subtype fixes the class unambiguously — a deposit is cash, a flat is real
estate.

Geography and currency (the SHOULD half) fall out for free: an instrument's
currency already distinguishes an international holding, so region defaults from
it and the split appears only when a foreign holding exists.

---

### B44 · Gmail is a second OAuth grant, not an extension of login

*28-08-2026 · `04` §3.4.* Sign-in is already Google SSO, so it was tempting to
widen its scope and get Gmail "for free". That is the wrong trade. Login asks
for `openid email profile` and keeps nothing but the identity — no refresh
token, no stored secret — and that minimalism protects every household that
never wants Gmail read.

So Gmail is its own opt-in grant: `gmail.readonly`, `access_type=offline` and
`prompt=consent` (the two together are what actually yield a refresh token),
with the token stored under the statement-identity discipline — migration 0013's
table is out of every export and the event log, and disconnect deletes it and
best-effort revokes it at Google. Login stays as small as it was.

Two §3.4 constraints are structural rather than promised. The Gmail search query
is built from the configured senders alone, so a message from any other address
is never even requested. And a message is parsed into fields and dropped — only
the extracted record reaches the ledger, never the body.

### B45 · The alert parser was written against real alerts, and the add-on case is why

Reading this household's actual alerts showed two shapes a spec would not have:
Axis's label/value layout (`Amount Debited:` / `INR 600.00` on separate lines)
and YES/IndusInd's single sentence. Both are parsed.

The case that justified the whole exercise is the add-on card. Priya's card
alert arrives in **Ravi's** inbox and greets "Dear Priya Menon". The parser
surfaces that name, and the fetch layer routes the alert to the primary's Credit
account while carrying the holder through so the transaction's owner defaults to
the add-on holder (R6.e) rather than the mailbox owner — exactly what §3.4
calls out, and it only became visible by looking at a real one.

---

*Entries B46 onward are recorded as the work happens.*
