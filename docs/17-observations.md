# Observations — what using it suggests next

Not a plan and not a backlog. This is what two full top-down passes turned up
that is *not* a defect: things that work as designed and could be better, with
the reason written down so the decision can be made once rather than re-argued.

Defects found in the same passes are recorded where defects go — `09`'s decision
log and `16`'s build plan. This file is only the suggestions.

---

## 1. Privacy needs a rule, not a list of patches

Six separate leaks were found in two days, and every one of them had the same
shape: a surface that reads the whole household's data and shows it to one
person. The account list, net worth and the loans page had been fixed once;
`queryTransactions` had not, then the category pickers had not, then the write
side had not, then the rule proposals had not, then the Rules screen had not.

Each fix was correct and each was found by hand.

**The suggestion:** make it structural rather than remembered. Two candidates:

- **A viewer-scoped handle.** Routes take `db`; if a screen took something like
  `as(db, viewer)` instead, every query through it would carry the predicate and
  the default would be safe. Expensive to retrofit, impossible to forget.
- **A test that walks every screen as two members and diffs.** Cheap, and it
  would have caught all six: seed a household where one member has a private
  account, a private envelope and a private arrangement, render every screen as
  each member, and assert that no string unique to one member's private things
  appears in another member's HTML. The sweep that found these was exactly this,
  done by hand in a shell loop.

The second is a morning's work and would have caught every one.

**It exists now** — `src/web/privacy-sweep.test.ts`. It plants a string in each
kind of private thing, renders every GET route the router serves as the member
who cannot see them, and fails on any match. The screen list comes out of the
route table, so a screen added tomorrow is swept tomorrow.

On its first run it found **five more**, none of which anybody had looked at:

| | |
|---|---|
| **The activity log** | It narrates everything in words — "Added the account Zzyzx Private Account", "Moved ₹5,000 from Zzyzx to Lending — Pennyfarthing Cousin", "Set Xylophone Finance's target to ₹4,754 a month" — with an undo button beside each. Every other surface had been taught whose money it was showing; the one whose entire job is to say what happened had not. |
| **Assignment and target events** | Named the envelope: "Assigned ₹9,000 to Qwertyuiop Envelope". A loan's target event names the *lender*, and it fires automatically whenever the loan changes. |
| **Payees** | A merchant seen only on a private account was in everybody's payee list and every Add form. A payee is a household-wide name, and mostly that is right — the same DMart is everybody's DMart — but one that has only ever been seen in one place is not a shared fact. |
| **Insights, on Overview and Reports** | "Qwertyuiop Envelope is new this month." A sentence about somebody else's envelope, on the first screen of the app. |
| **Transfers** | Name both ends, so both ends have to be visible. |

So: eleven leaks, six found by hand and five by the sweep written because of
them.

**And then the first candidate too** — `src/web/viewer-required.test.ts`. Not the
`as(db, viewer)` handle, which is a large retrofit for a rule that can be stated
more cheaply: *if a function accepts a viewer, every call in `app.ts` passes one,
or its line is listed with a reason*. Both halves are read out of the source, so
a function that gains a viewer tomorrow is enforced tomorrow.

It found **two more**, and both were kinds the string sweep is blind to:

| | |
|---|---|
| **A leaked number** | The Overview's net-worth headline was the whole household's while the page behind it was the viewer's — ₹55.6L and ₹28.6L, two clicks apart, the difference being exactly the private money. Published by subtraction, with no string to search for. |
| **A parameterised route** | The sweep skips `/loans/:id` because it addresses one thing, and that page's charge-category picker was offering every budget's envelopes. |

Thirteen in total. The generalisation holds and gets sharper: **the sweep catches
a leak after it is written; the rule catches it as it is written, and catches
what has no name to search for.**

## 2. The demo's import log is all one date

Every imported batch says it arrived today, because the seeder runs in one pass
and `ingest` stamps `nowIST()`. The file names carry the period, so it is
legible, and it is *true* — they were all imported today, by the seeder.

It is only wrong-looking, and the fix would be a date parameter on `ingest`
existing solely for the seeder's benefit. Left alone deliberately; noted so the
next person does not spend an hour deciding it is a bug.

## 3. Forty-three rule proposals is not a list, it is a wall

Three years of filing produces forty-three proposals, shown as one long list in
no particular order. Every one is individually reasonable ("You've put Zomato in
Going out 4 times") and collectively they are unusable: the eye stops at four.

**The suggestion:** rank by evidence and show the strongest handful, with the
rest behind a count. The data is already there — the proposal knows how many
times it saw the pattern. A proposal seen thirty-six times and one seen three
times should not be the same size on the screen.

**Done.** The data was *nearly* there: the count was in the sentence — "You've
put Blinkist in Books and courses 36 times" — and nowhere a query could reach,
which is why the list came out in the order the rows happened to be written.
Migration `0036` puts it on the row, `proposeCategoryRules` records it, both
screens that show proposals order by it, and the six strongest lead with the
remaining thirty-seven behind their own count. Nothing is discarded; it is one
click and the click says how many.

## 4. A fully-assigned month reads as an empty one

The demo now opens on **Ready to Assign ₹0 — "Every rupee has a job"**, which is
the app's own definition of success. But on the same screen, mid-month before
payday, several envelopes read "Not funded" against their targets, because the
money for them arrives on the 26th.

Both statements are true and together they read as a contradiction: everything
is assigned, and nothing is funded. A household that budgets a month ahead would
see neither.

**The suggestion:** the underfunded line could say *when* the money is expected —
"₹1,49,056 underfunded; your next income is on the 26th" — which turns an alarm
into a schedule. The cashflow projection already knows.

**Done.** `nextIncome` in `src/domain/schedules.ts`, on the line itself: *"₹20,000
underfunded across 1 category · your next income, Salary — Ravi, is on the
26th"*. It is scoped to the budget being looked at and to what the viewer may
see — a salary paid into somebody's private account is neither theirs to know
about nor money this Ready to Assign will receive — and a payday nobody ticked
off rolls forward to the one it implies, so the line does not go quiet exactly
when the month is tightest.

## 5. The card opening balance nobody can fund

A card added with an opening balance of −₹6,200 shows "₹6,200 of your Swiggy
HDFC balance has no envelope behind it" for ever, because an opening balance has
no transaction to file and therefore no envelope to file it to.

It is honest — the money *is* owed and nothing is set aside — and it is also
un-clearable, which makes it a permanent warning, and permanent warnings are
wallpaper (see the card that said it was nine days late).

**The suggestion:** either let an opening balance be funded like anything else
(an assignment into the card's payment envelope, which already works — the
warning simply never goes away because the balance is not a transaction), or
say so in the warning: "this came with the card and will not clear until you
fund it".

**Done, and the premise was half wrong.** It was never un-clearable: assigning
₹6,200 to the card's payment envelope takes the shortfall to zero, and always
did. What made it *look* permanent is that the warning pointed at the card's own
page — the right place to find the spending behind a shortfall, and the wrong
one when there is no spending to find, because the register there is empty.

So `CardFunding` now reports `startingDebt`, all three wordings say *"it came
with the card when you added it, so there is no spending to file — it clears
when you put money in the envelope"*, and the digest links to the assignment
that clears it rather than to the empty register. The card page's "Fund the
shortfall" button also now names the envelope, which it never did.

## 6. Two controls for one idea: scope

Most screens take their budget from the header switcher. Reports and Query have
their own "Whose money these are about" dropdown, which `16` settled
deliberately: those two offer every scope rather than picking one.

The decision is right and the *result* is that the app has two different
controls that both answer "whose money am I looking at", in different places,
looking nothing alike. Somebody who learns one does not find the other.

**The suggestion:** make them look like each other. The header switcher and the
reports dropdown could be the same component with an extra "Everything" option
on the screens that allow it.

**Done, exactly that.** `src/web/scope-switch.ts` is the one component; the
header, Reports and Query all render it, and the extra scope is an extra pill
rather than an extra kind of control. `16`'s behaviour is untouched. Two things
fell out of it: the dropdown submitted itself with a script and so did nothing
without one, where links need nothing; and the CSV export was dropping the
account and category filters, so "export" answered a different question from the
screen it sat under — the scope pills needed the whole filter in a link, and
fixing that fixed the export too.

## 7. What the top-down scenario still does not do

Worth writing down so it is a decision rather than an oversight:

- **No PDF statement import.** The CSV path is exercised end to end; the PDF
  parser, its password derivation and the bank-detection matrix are covered by
  unit tests against generated fixtures only.
- **No Gmail ingestion.** It needs a live OAuth grant, so it cannot run in a
  test at all. The parser has fixtures; the fetch loop does not.
- **No multi-currency.** The feature flag exists and the scenario never turns it
  on. One holding in USD is bought, which exercises the FX rate, but no account
  is held in another currency.
- **No concurrent writers.** Everything runs single-threaded. Two members
  editing the same month at once is a state the app can reach and the suite
  cannot.

The first two are genuinely hard to reach. The last two are not, and a scenario
flag would cover them.
