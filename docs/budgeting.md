# The envelope engine

## Definitions

| Term | Meaning |
|---|---|
| **Envelope** (category) | A named balance that money is assigned to. Balances roll forward month to month. |
| **Assignment** | An absolute amount of money placed in one envelope for one month. Stored per `(month, category_id)`. |
| **Ready to Assign** | Money available and not yet assigned. Computed, never stored. |
| **Activity** | The sum of transactions filed against an envelope in a month. |
| **Available** | An envelope's balance: opening + assigned + activity. |
| **Budget account** | An account whose balance is spendable and feeds Ready to Assign. |
| **Tracking account** | An account counted in net worth but not in the budget. |
| **Payment envelope** | An envelope owned by a credit-card account, holding cash to clear it. |

## Ready to Assign

```
Ready to Assign = income to date
                − assigned across all months
                − held for next month
                − cash overspend carried in
                − unfunded credit absorbed
```

Only budget accounts contribute income. An account's opening balance is income
in the month of its opening date.

## Envelope balance

```
available(month) = available(month − 1)          [rollover]
                 + assigned(month)
                 + activity(month)
```

A positive balance rolls forward in full. A negative balance is resolved at the
month boundary by the overspend model.

## Overspend models

Set per household (`household.overspend_model`).

| Model | Cash overspend at rollover | Credit overspend at rollover |
|---|---|---|
| `reduce-rta` | The negative balance is cleared and subtracted from the next month's Ready to Assign. | Absorbed into `unfunded credit absorbed`; the payment envelope is not automatically topped up. |
| `carry-negative` | The negative balance rolls forward on the envelope. | As above. |

**Covering** an overspend moves money from another envelope into the overspent
one, within the same month.

Cash and credit overspend are treated differently because they are different
facts: a cash overspend has already left a bank account; a credit overspend has
increased a debt that no envelope is funding.

## Credit cards

An account of kind `credit` owns exactly one payment envelope, created with the
account and managed by the application.

When a transaction is filed against a credit account:

1. The amount is recorded as activity on its spending envelope.
2. The same amount moves into the card's payment envelope.

The money is therefore committed at the moment of spending, not at the moment
the statement arrives.

### Funded and unfunded

```
owed       = max(0, −outstanding)
reallyFunded = payment envelope balance − attributed credit overspend
unfunded   = min(owed, max(0, owed − reallyFunded))
startingDebt = min(owed, max(0, −opening_balance))
```

`unfunded` is bounded by `owed`: the figure can never exceed the balance it
describes. `startingDebt` is the portion of what is owed that arrived with the
account, for which no transaction exists; the interface states this where it
applies.

## Targets

| Type | Needed this month |
|---|---|
| `monthly` | The target amount, every month. |
| `refill` | `max(0, amount − opening balance)`. |
| `by-date` | The remainder spread across the months to `target_date`. |
| `debt-payoff` | The instalment the linked loan requires; kept in step with the loan's schedule. |
| `spending` | The target pro-rated by day of month. |

`underfunded = max(0, needed − assigned)`. The budget screen totals these and
reports the next scheduled income date alongside.

## Held for next month

`held_for_next_month(month, budget_id)` removes an amount from that month's
Ready to Assign and returns it in the next. It appears as its own term in the
identity.

## Goals

A goal has a target amount, an optional target date, and one or more envelopes.
Progress is the sum of those envelope balances against the target. Completing a
goal releases its envelopes; the money stays where it is.

## Month close

Closing records income, spending, assigned and commitments for a month in one
budget, takes a net-worth snapshot, and writes an event. Closed months can be
reopened. Each budget closes independently.

## Commitments between budgets

A personal budget can commit money to the household budget: an envelope in the
personal budget carries `commits_to_budget_id`. Assigning to it increases the
household's means without a transfer between accounts. Spending from the
household on that member's behalf reduces it.

The claim appears in the identity as `due from other budgets`. The standing of
a commitment envelope is described as **overfunded**, **underfunded** or
**square** — never as debt.

An `even_call` settles a lopsided month by moving an agreed amount between
budgets.

## The identity

```
Σ budget-account balances  +  due from other budgets
    =  Σ category balances  +  Ready to Assign  +  held for next month
       +  Σ future assignments  −  unfunded credit absorbed
```

`identityResidual(state)` must be exactly `0` for every month in every budget.
Derivation: [dev/01-engine-derivation.md](dev/01-engine-derivation.md) §1.

## Viewing past months

A past month's figures are computed with the data as it is now. Assignments made
in later months are subtracted from the earlier month's Ready to Assign, so a
past month can read lower than it did at the time. See
[dev/01-engine-derivation.md](dev/01-engine-derivation.md) §4 and
[limitations.md](limitations.md).

## Merging two categories

Two envelopes turn out to be the same envelope. Merging moves everything from
one into the other and deletes the loser:

- **Assignments are added, month by month.** Not moved — added. `assignments`
  is keyed `(month, category_id)`, so two categories assigned to in the same
  month collide, and resolving that collision by keeping one row would take
  money out of the ledger without taking it out of any account. The identity
  would break by exactly the amount discarded.
- **History follows**: transactions, splits, staged imports, schedules, a
  loan's payment envelope, goal membership.
- **The winner's target stands.** The loser's is inherited only where the
  winner has none — two targets cannot both apply, and the category being kept
  is the one whose intent was meant to survive.
- The rollup cache is dropped and rebuilt, because it is keyed by category.

It refuses two things. **A card's payment category**, on either side: its
activity is derived from the card account rather than stored (R6), so a merged
one would lose that link or give the winner a second. And **a merge across
budgets** — two budgets are two people's money, so moving a balance between
them is a transfer, not a rename, and it would tip a private envelope's
contents into the shared budget where everyone can see it.

Compare `deleteCategory`, which insists the balance is already zero and only
remaps transactions. Merge is for when the balance is the thing that has to
survive.

## Splitting a transaction

One payment, more than one envelope. A supermarket bill is half groceries and
half household; a bank charge rides along with a transfer.

### There is no main category — there are lines

A transaction has envelopes, and usually one. So every screen that files money —
add a transaction, edit one, add a schedule, edit one — shows the same control:
a **list of lines**, where

- the **first carries no amount** and takes whatever the others leave;
- the rest are behind *Split it across more than one*, and name an amount.

One line is an ordinary single-envelope entry, which is what almost every
transaction is. Two lines make it a split without the first ever being retyped:
add a ₹900 line to a ₹2,400 bill and the first quietly becomes ₹1,500.

Lines are posted as `split_category_N` / `split_amount_N` — the same names on
all four screens, so they agree about what a split is. `split_amount_0` is not
read: the first line's amount is computed, never typed.

This replaced a separate "main category" box sitting above a split section, and
with it a whole class of bugs. The box meant nothing while the section was in
use, so the form emptied and disabled it — which destroyed whatever had already
been chosen, left an empty box the form then refused to submit, and gave no way
back to a single envelope. Every question about what that box should say, and
whether it was required, stopped having an answer worth giving.

**The lines can no longer disagree with the total.** The remainder is computed
rather than typed, so the arithmetic the household used to have to get right —
and the refusal when they got it wrong — stopped existing. What is refused is
only the case that has no reading at all: later lines claiming the total or more,
which would leave the first line nothing or a negative amount.

When lines are present the transaction's own `category_id` is **null** and the
lines carry the categories. Setting both would file the amount twice. B99's rule
still holds: money out needs an envelope, and the first line is that envelope —
so it is required for an expense whether or not the entry is split.

### Going back to one envelope

**One line means one envelope.** Clear the extra lines and the split is removed;
the first line's category becomes the transaction's or the schedule's own. It
used to be refused as "not a split", which was a dead end.

Clearing the *first* line is how you say "no envelope". On money coming in that
is ordinary — it lands in Ready to Assign. On an outgoing schedule with nothing
else to post to it is **refused**: it would post itself every month into
nothing, which is the queue of unrecorded spending the envelope rule exists to
prevent.

A present-but-empty first select means "clear it", not "no lines were sent". The
two used to be indistinguishable, and reading it the other way made clearing an
envelope a save that reported success and changed nothing.

### A blank first line

Blank means **no envelope**, and what that is worth depends on which way the
money is going.

- **Money in:** ordinary. The remainder lands in **Ready to Assign**, stored as
  a line with a null `category_id` — which is what Ready to Assign is. A
  ₹50,000 salary with ₹5,000 named for provident fund leaves ₹45,000 waiting to
  be given a job, and `identityResidual` comes out at exactly zero.
- **Money out:** refused on all four screens. An expense with an uncategorised
  remainder is precisely the queue of unrecorded spending B99 exists to prevent.

The rule is `outgoingLacksEnvelope`, and it checks the **lines**, not only the
single-envelope case. That distinction is the whole of it: "this entry is split,
so of course it names its envelopes" was true until the first line became one
that may legitimately be left blank. Until this was fixed, `/add` refused an
uncategorised expense and the other three screens wrote one — and none of the
four handled the income case at all. The create routes skipped a blank first
select as "no line sent", which promoted the second line to first and filed the
**whole** amount into it: ₹50,000 of salary, all of it in provident fund, with
nothing refused, because a single-envelope income is a perfectly legal
transaction.

### The half a test cannot see

The envelope select is *also* the thing the browser can decline to send. A
disabled select submits nothing, so when the client script kept disabling it —
correct under the old form, wrong the moment the box became the first line — a
₹5,000 expense with ₹1,200 on the second line arrived with no first envelope and
was filed whole into the second. The forms were right and the server was right;
the bug lived entirely in between. `client-envelope.test.ts` runs that rule
against a stub DOM for exactly this reason.

## A transfer that costs something

IMPS above a threshold, NEFT at some banks, a demat transfer, the markup on a
currency conversion. The two legs of a transfer used to have to be equal, so a
charge had to be entered separately by hand — and if it was not, the account
stopped matching the statement.

A transfer may now carry a fee. It comes out of the **sending** account on top
of the amount, so ₹10,000 sent with a ₹5 charge leaves ₹10,005 and delivers
₹10,000, which is what the statement will say.

The fee needs a category, because it is spending. Money leaving the budget
accounts with no envelope against it would come out of Ready to Assign instead,
and the household would find its unassigned money shrinking with no line item to
explain it.

It is recorded as a **third transaction, deliberately outside the transfer
pair**. Inside the pair the two legs would no longer cancel, and every report
that excludes transfers would quietly swallow a real expense. Outside it, the
charge behaves like any other categorised spend — it appears in the envelope, in
the reports, and in the month's spending, which is where somebody goes looking
for it.

## A schedule that splits

The two most regular payments a household has are both splits. A salary arrives
and is immediately three things — provident fund, tax deducted, and what landed.
Rent is rent plus maintenance plus parking, one payment on one date. Both had to
be entered and split by hand every month, which is the work a schedule exists to
remove.

`schedule_splits` mirrors `transaction_splits` rather than inventing a second
shape, because when the schedule posts, one becomes the other. The lines work
the same way too — first line takes the remainder — which matters more here than
anywhere: a recurring split that was quietly wrong would repeat itself every
month until somebody noticed.

When a split schedule posts, the transaction's own `category_id` goes null and
the lines carry the categories — the same rule as a hand-entered split. Setting
both would file the amount twice.

A schedule with no amount cannot be split, since there is nothing to divide, and
a card's payment envelope cannot be a line for the usual reason (R6).

Changing a split schedule's amount re-files its lines the same way: the first
takes whatever the others leave. ₹1,000.01 split ₹666.68 / ₹333.33 and changed
to ₹500 becomes ₹166.67 / ₹333.33. If the other lines alone already use up the
new amount, or are money going the other way, the change is refused with the
numbers rather than stored — a schedule whose lines no longer add up could never
be marked paid. Undoing the change puts the lines back with the old amount.

## When a schedule comes round again

A month-based schedule (monthly, quarterly, half-yearly, yearly) remembers the
day it was set to, not the date its last occurrence happened to land on. A rent
on the 31st goes 31 Jan, 28 Feb, 31 Mar — it does not settle on the 28th after
February. The day moves only when somebody moves the due date.

**Schedules created before migration 0048** had their day read back from the
due date, so one that had already slid from the 31st to the 28th is backfilled
as the 28th — the day it was set for is not recorded anywhere reliable. Moving
its due date back to the 31st once re-anchors it for good. Schedules the old
`skip` policy ended (next due empty) can be found with
`SELECT id, name FROM schedules WHERE next_due IS NULL AND short_month_policy = 'skip'`
and given a due date again.

Undoing a change to a schedule's **split** puts back the lines and envelope it
replaced. It used to delete the schedule, because those events recorded no
before-state and undo read that as "this was a creation".

The short-month policy decides what happens in a month without that day:

| Policy | 31st, in February 2026 |
| --- | --- |
| `last-day` | 28 Feb |
| `next-day` | 1 Mar — and March's own 31st still comes |
| `skip` | nothing in February; the next is 31 Mar. The schedule carries on. |

Marking an occurrence paid moves the schedule on from the date it was **due**,
not the date it was paid. Rent due on the 15th and paid on the 20th of the next
month leaves that month's 15th still due; a quarterly payment due 15 Mar and
paid 2 Apr is next due 15 Jun, not 15 Jul; a Monday payment made on a Wednesday
stays a Monday schedule. The transaction is still dated the day it was paid.
Paying early works the same way: due 15 Mar, paid 10 Mar, next due 15 Apr.

### Suggested schedules

Suggestions come from three or more transactions with the same payee at a
steady rhythm. They keep the direction they were seen in — a salary is proposed
as money coming in, a bill as money going out — and a payee seen both ways is
judged on the way it mostly goes, with the odd refund left out. A monthly
rhythm is projected in whole months on the day it usually falls, so a salary on
the 1st is next expected on the 1st, not 30.75 days after the last one.

### The cashflow calendar and cards

A card's balance is not cash leaving on the day it is charged; it leaves on the
due date. What a card owes today is projected once, at its next due date. A
schedule billed to a card leaves cash on the due date of the statement it falls
into — statement on the 20th, due the 5th: charged 12 Oct, paid 5 Nov. A
schedule on a tracking account does not move cash. The same rule holds in every
scope, and a budget's projection takes only that budget's accounts and cards.

## Rules that build a value

A rule's text actions — `setMemo`, `setPayee` — may interpolate `{field}` from
the transaction: `UPI ref {reference}`, `{merchant} via {channel}`. The fields
are the ones already extracted from narration (`channel`, `vpa`, `merchant`,
`reference`) plus `narration`, `importedPayee`, `payee`, `memo`, `date` and
`cardLast4`.

An unknown placeholder is **left exactly as written**. `{refrence}` that
silently became empty would look like the rule working, and leave empty memos
with no reason for them. A known field that happens to be empty does become
empty, because that is its value.

It is substitution and nothing else — no arithmetic, no conditionals, no calls,
and no recursion, so a narration containing braces cannot inject a placeholder
of its own. A rules engine that evaluates expressions is one that can loop, fail
at run time, or be handed something hostile out of a bank statement, and none of
that buys enough to be worth it.
