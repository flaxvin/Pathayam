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

## A schedule that splits

The two most regular payments a household has are both splits. A salary arrives
and is immediately three things — provident fund, tax deducted, and what landed.
Rent is rent plus maintenance plus parking, one payment on one date. Both had to
be entered and split by hand every month, which is the work a schedule exists to
remove.

`schedule_splits` mirrors `transaction_splits` rather than inventing a second
shape, because when the schedule posts, one becomes the other. The lines must
add up to the schedule's amount: a split that does not reconcile is money the
ledger cannot account for, and a recurring one repeats that every month until
somebody notices.

When a split schedule posts, the transaction's own `category_id` goes null and
the lines carry the categories — the same rule as a hand-entered split. Setting
both would file the amount twice.

A schedule with no amount cannot be split, since there is nothing to divide, and
a card's payment envelope cannot be a line for the usual reason (R6).
