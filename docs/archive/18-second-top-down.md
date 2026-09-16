# The second top-down pass

A fresh run of the standing criterion — thirty-six months, four people, two of
them gone at month 24 and one back at month 30 — with new money, a new order of
events, and a question the first pass never asked: *what did the run actually
produce?*

Then the same app again from a UI/UX angle, and then a third thing that was not
planned: seventy-seven real bank statements, put through the PDF importer.

Defects fixed are in `09`'s decision log. This is what the passes turned up and
what is worth doing next.

---

## What held

Worth stating plainly, because most of this document is about what did not.

- **The identity closed after every month, in every budget**, on two seeds the
  app had never seen. Not at the end — after each month as history grew.
- **The rollup cache agreed with a cold compute** for every month in every
  budget. 108 comparisons, no disagreement.
- **Every GET route renders.** 79 routes driven over HTTP against three years of
  real-shaped data: 68 answered 200, and all eleven that did not were right to —
  OAuth routes with no credentials configured, redirects, and routes needing an
  id of a kind the sweep had not fetched. Re-run with the right ids, they answer
  200 too. **Zero server errors in the log.**
- **The UI/UX sweep came back clean.** 45 screens × 2 widths × 2 themes, checked
  for contrast against what text actually sits on, tap-target size, labels,
  duplicate ids, heading order, and overflow. Nothing. The last pass's crop of
  contrast failures and 34px targets is gone and has stayed gone.

---

## 1. One statement line can happen on two accounts — **fixed**

The first defect the fresh run hit, and it hit it immediately: approving an
imported row died with `UNIQUE constraint failed: transactions.source,
transactions.source_id`. A 500 with SQL in it, and a row left in the queue that
could never be approved.

A row's identity is a hash of date, amount, narration and reference, which is
what makes re-importing a file idempotent. Two accounts can produce the same
four — "UPI/SWIGGY/4471" for ₹450 on the 5th of August is one payment from the
joint account and a different one from a personal one — and a household with two
accounts at the same bank meets this the first time it imports both.

The pipeline always knew. Its duplicate check is scoped to the account being
imported into, so it staged both rows, correctly. The index was global. Two
layers disagreeing about what makes a row unique, and the one that was right had
no say. Migration `0037` scopes the index the way the pipeline already scopes
itself.

## 2. The middle of a feature is the part nothing exercises — **fixed**

The first pass checked that every mutating function was *called*. This one
checked what the calls left behind, and found three tables empty:

| | |
|---|---|
| `rule_applications` | Three years produced forty-three proposals and **zero confirmations**, so the step between "the app noticed a pattern" and "the app files things for you" had never run once. |
| `transaction_splits` | Never exercised. F4.3's arithmetic — a split summing to its transaction — was covered by unit tests alone. |
| `transaction_tags` | One tag, used once. |

Confirming and dismissing a proposal lived **in the router**: a bare `UPDATE`
and a paragraph of suppression logic inside a route handler. That is why nothing
could reach them — the only way to run that code was to post a form. They are in
the domain now, the route calls them, and so does the scenario.

Which then exposed why they *still* would not have fired. See below.

## 3. A simulated statement that no bank would print — **fixed**

With rules confirmed, they matched nothing. The simulated statement line was
`UPI/DMART/4471920/GROCERY`, and because the merchant is taken as the longest
segment, "GROCERY" won. Every rule the app learned was about a payee called
**Grocery**.

The instinct was to fix the extractor. The 1,856 transactions parsed out of
seventy-seven real statements say otherwise: longest-segment gives "Uber India
Systems Pr", "State Bank Of India", "Mohd Kamil Khan", where first-segment gives
"L Td Upi", "No. UPI", "Bank Upi". **Longest is right; the fixture was wrong.**
No statement in the corpus carries a trailing purpose field.

Worth keeping as a rule of its own: *a synthetic fixture is evidence about the
fixture.* The corpus overruled a plausible one-line "fix" that would have made
real imports worse.

---

## 4. The PDF importer, against seventy-seven real statements

Run locally, against this household's own inbox — twelve institutions, three
years. Nothing from it is in this repository.

**58 of 77 opened and parsed, 1,856 transactions, no crashes.**

### What could not be opened (19)

Every one needs a digit that name + date of birth + PAN does not carry, and in
every case the app asks for exactly the right thing:

| | | |
|---|---|---|
| SBI account | 6 | last five of the **registered mobile** + DOB |
| SBI Card | 6 | DOB + last four of the **card** |
| Canara | 4 | last four of the card, alone |
| HSBC | 3 | DOB + last **six** of the card |

So the identity form's mobile field and the account's stored last-four are not
optional extras — for four of twelve institutions they are the difference
between an import and a locked file. **Suggestion:** when a statement will not
open and the bank is one of these four, say *which* detail is missing rather
than offering the generic hint. The app knows the bank and knows whether it has
a mobile on file.

**Suggestion, minor:** `passwordCandidates(identity, undefined, …)` is called
with no bank id, so the bank's own rule is never tried first. The account knows
its institution. This costs only speed, but it is free to fix.

### The text extractor puts spaces inside words — **the significant one**

Three ICICI savings statements parse to **zero rows**, and the reason is not in
the statement parser at all. The layout pass in `src/pdf/text.ts` places each
text run at the column its x-position implies. Some generators draw one figure
as several runs — `27,333.00` arrives as `2`, `7,3`, `33.0`, `0` — and each gets
its own column, so the line reads `2 7,3 33.0 0` and the date reads
`2 7-03 -202 6`. Every date and amount stops matching. The file opened, the text
is all there, and it is unreadable one character at a time.

It is not confined to those three files. **534 of 1,856 real payee names — 29% —
carry a space the page put inside a word**: `Transfer T O Riy As Pilakk O Th`,
`Fino P A Ym`, `Airtel P A Yments`, `A Ch-dr -indian Clearing Corp`. Every one
of those is a payee name in the ledger, a key the duplicate check compares, and
a value a learned rule would be written against.

**Two fixes were tried and both were worse, which is the useful part:**

- *A fixed tolerance* — join runs closer together than some fraction of a
  character. Measured on the ICICI statement, the pieces of one number sit 0.2
  to 2.6 characters apart and its columns 6 to 53 apart, so three characters is
  the right answer there. On Axis and YES the **columns themselves** are two to
  four characters apart. Swept across all 77 files: a tolerance wide enough to
  fix ICICI took the corpus from 1,856 rows to **921**.
- *A text repair after the fact* — close up a single space between two digits,
  since columns are reached by padding and so are separated by runs of spaces.
  This looked excellent: 1,856 → 1,864 rows, and all three ICICI statements
  started parsing. It was still wrong. The column reader keys off character
  offsets, and closing up spaces shifts them, so the rows it then read took the
  **balance** column as the amount and invented a transaction out of the
  brought-forward line. Two right-looking rows with wrong numbers in them, which
  is worse than none.

Neither shipped. Page-level column detection was the next candidate — cluster
piece x-positions down the page and treat a gap as a boundary only where the
page agrees. Measuring killed that too: the gap histogram on the failing page is
**continuous from 0 to 19 characters**, so no threshold exists, and the x-anchors
that repeat down the page belong to the three *other* blocks on it rather than
to the transaction table.

**Fixed, in the statement parser rather than the extractor** — see below.

### The fix: tolerant readers, original offsets

The lesson from the two failures is that **repairing the text is what breaks it**.
The column reader keys off character offsets, so closing up spaces moves every
column after the repair, and the parse then reads the balance as the amount.

So nothing is repaired. Three readers gained a second, pieced pattern, each
tried only where the strict one has already failed, and each reporting the span
it matched **in the original line** — spaces included, offsets intact:

| | |
|---|---|
| `findDate` | `2 7-03 -202 6` reads as 27-03-2026. Both patterns are tried, because the strict one can *match* and still not parse: on `0 1-03 -202 6` it takes `0 1-03`, which is not a date, and the line would have been abandoned on the strength of it. |
| `figuresWithOffsets` | `3,807 .04` is ₹3,807.04, not ₹3,807. A generous span, then a shape check: what it covers has to still look like one amount with the spaces out, or the strict pattern reads the span instead. `1,234.56 789.00` fails that check and stays two figures. |
| `readHeader` | `DAT E … DE POSITS … WITH  D RAWA  LS … BAL ANCE`. Up to three spaces between letters, because the pieces of a split word are padded to their own columns. |

The header is the part that matters most, and the reason the first two are no
use alone: without it no column is known, so the parser cannot tell a balance
from an amount and reads the running total as the movement — every row
plausible, every number wrong.

One more thing fell out of it. **A brought-forward balance is not a transaction**,
and it has a date and a figure, so it read as one: ICICI's `01-03-2026 B/F
3,807.04` imported as a ₹3,807.04 payment out. Two banks already listed the line
in their own skip rules, one at a time, which is the tell — it is universal now,
carried-forward included.

Measured across the same seventy-seven files, with the bank's own printed
closing balance as the judge:

| | before | after |
|---|---|---|
| transactions read | 1,856 | **1,860** |
| statements reading zero rows | 6 | **4** |
| reported errors | 44 | **40** |
| **balance reconciliations exact** | **12 / 12** | **12 / 12** |

The row count moves little and the composition changes a lot: **+8 real ICICI
transactions, −4 fabricated balance lines**. One of the four remaining zero-row
statements is *correctly* zero — its only two "transactions" were the brought
and carried forward lines. Every ICICI figure was checked against the statement
by hand, and the twelve files that carry a closing balance still reconcile to
the paise.

### The payee-name pollution: five attempts, and a decision

The same defect seen from the other side — `Fino P A Ym`, `Transfer T O Riy As
Pilakk O Th`, `A Ch-dr -indian Clearing Corp` — 29% of every payee name that
arrives by PDF. It no longer stops a statement being read. It is **not fixed**,
and this is the record of what that cost to establish, so nobody spends the
afternoon again:

1. **A fixed gap tolerance** — corpus fell from 1,856 rows to 921.
2. **A per-line adaptive tolerance** (a fraction of the line's widest gap) —
   921 rows, 20 statements reading nothing.
3. **A text repair after the fact** — looked like the winner at 1,864 rows, and
   every number in the newly-read statements was wrong: closing up spaces moves
   the character offsets the column reader keys off, so it read the running
   balance as the movement.
4. **Page-level column detection** — abandoned on measurement. The gap
   histogram on the failing page is *continuous from 0 to 19 characters*, so no
   threshold exists, and the x-positions that repeat down the page belong to the
   three other blocks on it, not to the transaction table.
5. **Joining pieces that overlap** (gap < 0, the most conservative rule there
   is) — this one is worth recording in detail, because it looked excellent:
   pollution **29% → 5.3%**, references no longer truncated, `RIY AS PILAKK O
   TH` reading `RIYAS PILAKKOTH`. Then the amount-level diff: one real interest
   credit of ₹2,246 lost, and two transactions on one date — −₹15,000 and
   +₹66,700 — merged into a single +₹51,700. Three real rows gone to make the
   names prettier.

And a sixth, in the names alone where money cannot be harmed: joining
single-letter fragments. It fixes `T O` → `TO` and `Y esBank_Y` → `YesBank_Y`,
and it turns `Anil K Umar P Al` into `Anil KUmar PAl`. Initials are
single letters too, and nothing in the text says which is which.

**The decision: leave it.** The information about where the word boundaries were
is destroyed by the layout pass, and neither geometry — tried four ways — nor
text heuristics can reconstruct it without damaging something real. Money
accuracy beats name quality, and this app's premise is the identity closing.

What *was* fixable in the names was fixed: a bracketed reference at the end of a
merchant — `TO SUNEESH M (603229525067)` — is never part of a name, and it was
turning every payment to one person into a different payee. 855 distinct payees
became 803.

The manual-mapping fallback is now rarely needed, but it remains the honest
failure path: it reports `"0 1-03 -202 6" is not a date I can read.`

### RBL: the example table wins — **fixed**

RBL prints its statement as two columns — the account summary down the left,
the transactions down the right — sharing lines, so a row reads `Card Number
XXXXXXXXXXXXXX27   21 Apr 2026  PYU*Swiggy Food  338.00`. The date is
forty-six characters in, behind text that is not a serial number: past the
window a date is looked for in, and past the guard that stops a date inside a
narration being read as the transaction's own. Both rules are right and together
they read nothing — what the parser found instead was the worked example RBL
prints to explain how to read a statement.

A table announces its left edge with its own Date heading, so slicing every line
there drops the column beside it — but **only as a second attempt, after the
ordinary read comes back empty**. Tried first it is a catastrophe: 1,860 rows to
422, and all twelve balance reconciliations broken. Both real transactions now
read, with the right sign, and nothing else in the corpus moved.

---

## 5. Smaller things, and suggestions

- **A managed category renders a form that can never be submitted.** A payment
  envelope's name is read-only and has no Rename button, but the `<form>` and
  `<input readonly>` are still emitted. Harmless, and it is the only thing the
  UI sweep flagged that is not by design. It could be a `<span>`.
- **Literal NUL bytes in `src/import/pipeline.ts`.** The source-id digest joins
  its fields with real `\x00` bytes typed into the source, which is a sound
  separator and makes the file "binary" to `grep`, invisible in most editors,
  and a hazard for anything that reads the repository as text. `\0` in the
  template would do the same job visibly.
- **Confirming a rule had no domain function** (now fixed). Worth a general
  look: anything that only a route can do is something no simulation can reach,
  and the census is a cheap way to find the rest.
- **The census itself is worth keeping.** Counting what a run *produced* found
  three dead features that the call-coverage check called covered. It now runs
  as part of the scenario test: rules must actually file something, splits must
  exist and sum, more than one tag must be in use.

## 6. Still not covered

Unchanged from `17` except where noted:

- **No Gmail ingestion.** It needs a live OAuth grant, so it cannot run in a test
  at all.
- **PDF import is now exercised by hand** against a real corpus — but not in the
  suite, because the corpus cannot be committed. The generated fixtures remain
  the automated coverage. A synthetic statement built to reproduce the
  piece-splitting layout would be worth having, and would have caught §4.
- **No import profiles in the route sweep.** `import_profiles` is exercised by
  the scenario but the saved-mapping screens are only rendered, never driven.
