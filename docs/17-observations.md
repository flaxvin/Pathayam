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

The second is a morning's work and would have caught every one. It should exist.

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
