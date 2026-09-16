# The budgeting model

Strict envelope budgeting, on money you already have. Every rupee that arrives
is given a job before it is spent, and the app will not let that arithmetic
drift.

## Ready to Assign

Income lands unassigned. **Ready to Assign** is what is left over after every
envelope has been given what it is getting this month, and the target is zero —
not because zero is tidy, but because an unassigned rupee is a rupee with no
decision attached to it.

It is computed, never stored. Assign money into an envelope and it comes out of
Ready to Assign; take it back out and it returns. Nothing rounds.

Only **budget accounts** feed it. A tracking account — an investment, a loan, a
pot you watch but do not spend from — is part of net worth and no part of the
money you can assign.

## Envelopes

An envelope (category) has a balance that **rolls over**. Ten thousand assigned
to Repairs in January and untouched is ten thousand available in February. This
is the whole point of the model: the envelope is a decision that persists, not a
monthly allowance that resets.

Envelopes live in groups, and a group belongs to a budget (see
[privacy.md](privacy.md) for what that means in a household).

## Overspending

Spend more from an envelope than it holds and the app makes you deal with it.
Two models ship, both complete:

| | |
|---|---|
| **`reduce-rta`** | The overspend is taken out of next month's Ready to Assign. You start the month already down, which is what actually happened. |
| **`carry-negative`** | The envelope carries its negative balance forward and has to be dug out of. |

Neither is a stub and either can be chosen. What the app will not do is quietly
absorb the difference.

**Covering** an overspend moves money from another envelope, which is the honest
fix: the money came from somewhere, and now the screen says where.

## Credit cards

The part most budgeting apps get wrong.

Spending ₹2,000 on a card does two things: it creates the expense in its
envelope, and it moves ₹2,000 into that card's **payment envelope** — cash set
aside to clear the statement. The money stops being available for anything else
at the moment it is committed, not when the bill arrives.

So a card balance is either *funded* — its payment envelope holds the cash — or
it is not, and the difference is stated as a figure rather than left implicit:

> ₹6,200 of your Swiggy HDFC balance has no envelope behind it.

Three ways a card can be unfunded:

1. **A credit overspend** — spending on the card from an envelope that was
   already empty.
2. **An opening balance** — debt the card came with when it was added. There is
   no transaction to file, so the warning says so, and names what clears it:
   money assigned to the payment envelope.
3. **Deliberately** — you chose not to fund it this month.

The unfunded figure is bounded by the debt itself. A warning larger than the
balance it describes is one a household can disprove with arithmetic, which
costs more trust than the warning was worth.

## Targets

An envelope can carry a target, and the budget screen shows how far short it is:

| | |
|---|---|
| **monthly** | ₹9,000 every month. |
| **refill** | Top up to ₹20,000 — what is already there counts. |
| **by-date** | ₹1,20,000 by March, spread across the months between. |
| **debt-payoff** | The instalment a loan needs, kept in step with the loan. |
| **spending** | Pro-rated across the month, so "am I on track on the 12th" has an answer. |

Underfunded envelopes are summarised at the top of the budget screen, with the
one useful piece of context: **when the money arrives**.

> ₹1,49,056 underfunded across 22 categories · your next income, Salary — Ravi,
> is on the 26th

A fully-assigned month mid-cycle otherwise reads as a contradiction — every
rupee has a job, and nothing is funded — when what is actually true is that
payday is the 26th.

## Goals

A goal is a named thing you are saving for, with its own envelope and a
progress bar. Completing it releases the money; deleting it does not silently
lose it.

## Holding money back

**Held for next month** sets money aside during this month explicitly. It is not
a hidden reserve — it appears in the identity as its own term, so the arithmetic
still closes and the screen still says where every rupee is.

## Closing a month

Closing is a ritual, not a lock. It takes a net-worth snapshot, records what was
overspent and what was left, and writes the close as an event. A closed month
can be reopened.

A household with separate budgets closes each one; the month-close screen lists
months per budget rather than repeating the same month once per member.

## The identity

Underneath all of it, one equation that must hold exactly:

```
Σ budget-account balances  +  due from other budgets
    =  Σ category balances  +  Ready to Assign  +  held for next month
       +  Σ future assignments  −  unfunded credit absorbed
```

Derived in [`dev/01-engine-derivation.md`](dev/01-engine-derivation.md) §1, and
asserted after every month of a thirty-six-month simulation in every budget. In
integer paise, with a residual of exactly zero.

Most defects found in the engine were found by this equation rather than by a
screen looking wrong: a family-loan write-off that put a categorised transaction
on a tracking account, a loan instalment that never consumed its payment
envelope, an EMI conversion dated from the button rather than the charge.
