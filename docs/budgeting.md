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
