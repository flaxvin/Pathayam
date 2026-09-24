# Loans, lending and assets

## Loans

A loan creates a tracking account of subtype `loan` (or `emi`) whose balance is
derived, and a payment envelope in the budget carrying a `debt-payoff` target
equal to the current instalment.

### Fields

| Field | Notes |
|---|---|
| `loan_type` | `home`, `home-under-construction`, `car`, `personal`, `gold`, `education`, `loan-against-property`, `credit-card-emi`, `bnpl`, `other`. |
| `interest_model` | `reducing` or `flat`. |
| `sanctioned`, `sanction_date` | |
| `tenure_months`, `original_tenure_months` | The original is retained when a rate change alters the tenure. |
| `first_instalment_date`, `instalment_day` | |
| `moratorium_months` | Interest-only period before principal repayment begins. |
| `repayment_account_id` | Where instalments are paid from. |
| `payment_category_id` | The envelope funding them. |
| `benchmark` | For floating-rate loans. |

### Schedule

The amortisation schedule is computed from the rate history in `loan_rates`, not
stored. A rate change inserts a row with `effective_from`; the schedule is
recomputed from that date forward.

A `flat` loan runs to its own schedule: interest on the original principal,
the same every month, and principal in equal parts — EMI = (P + P × rate ×
years) ÷ instalments, so ₹1,00,000 at 12% flat over 12 months is ₹9,333.33 a
month and ₹12,000 of interest. The EMI, the payment envelope's target and the
estimated split of an instalment paid without the lender's figures all come
from that schedule. The equivalent reducing-balance rate is calculated and
shown beside it, because a flat rate understates the real cost. Prepayment
comparisons on a flat loan still price the reducing-balance case.

### Payments

`loan_payments` records each instalment with its principal and interest split.
Where the lender's split is known it is recorded; otherwise it is computed and
marked `estimated`.

Paying an instalment:

1. Creates a transaction on the repayment account.
2. Consumes the payment envelope.
3. Records principal and interest against the loan.

### Prepayment

The prepayment screen compares the two options a lender must offer — reduce the
tenure, or reduce the instalment — and prices both, showing the interest saved
by each. Recording one applies it and recomputes the schedule.

### Drift

`loan_statements` records the lender's own outstanding figure at a date beside
the application's. Where they differ the difference is shown and can be
resolved; lenders round differently and post on different days.

### Disbursements

A loan drawn in tranches (typically under-construction property) records each
disbursement with its date, amount and destination. The schedule reflects only
what has been drawn.

### Closing

A loan can be closed by settlement, with an optional foreclosure charge. The
settlement is paid like any instalment — from the chosen account (or the loan's
repayment account), through the payment envelope, onto the loan account. Paid
above the outstanding, the excess is interest. Paid below it, the difference is
a waiver: a separate `foreclosure` row with no amount and the shortfall as
principal forgiven, so paid + forgiven always equals the outstanding and
interest is never negative. Closing releases the payment envelope's target.

### EMI conversion

A credit-card charge can be converted into an instalment plan. The conversion
creates a loan of type `credit-card-emi` linked to the originating transaction
and card, dated from the **charge**, with the processing fee recorded against a
chosen envelope.

## Family lending

Money lent to or borrowed from a person, held in a tracking account of subtype
`family-loan`.

- `direction` records whether the household lent or borrowed.
- The balance is **derived** from the advances and repayments recorded against
  the account, not typed.
- Advances and repayments move real money and are ordinary transactions.
- A loan can be **written off**, which records the loss against an envelope and
  closes the arrangement.
- `agreed_total` is optional and documentary.

## Portfolio

### Instruments and holdings

An `instrument` is a tradeable thing: `mutual-fund`, `equity`, `etf`, `bond`,
`commodity` or `other`, with an optional symbol, ISIN, currency, price provider
and classification (`asset_class`, `region`).

A `holding` is one instrument in one asset account. Its units and cost come from
`lots`, which are FIFO.

### Events

`holding_events` records:

| Kind | Effect |
|---|---|
| purchase | Opens a lot; optionally creates the paying transaction. |
| sale | Closes lots FIFO, computes realised gain, optionally credits an account. |
| dividend | Records income. |
| split | Adjusts every lot's units by ratio, preserving its cost and date. |
| bonus | Adds one new lot at nil cost, dated on the allotment (section 55(2)(aa)); the lots already held keep their cost and date. A 1:1 bonus is ratio 2. |
| merger | Replaces holdings in one instrument with another at a ratio. |
| return of capital | Reduces cost basis. |

### Prices

Mutual funds are priced from a keyless public provider by scheme code; equities
from Alpha Vantage when a key is configured. Prices are stored with their date;
`price_fetches` records outcomes. Instruments may be marked `manual_only`.

Prices and valuations older than the configured threshold are reported as stale
on the health page and beside the figures they affect.

### Valuation and currency

A holding's market value is `units × price`, converted at the `fx_rates` entry
for the base currency as of the date being asked about.

Hand-valued accounts (gold, retirement balances, property) carry dated entries in
`asset_valuations` rather than a mutable number. A non-base-currency account's
valuation is converted the same way a holding is; where no rate exists the value
is carried at 1 and marked stale.

### Returns

XIRR is computed from the dated cash flows of a holding or the portfolio.
Realised gains are reported by financial year and split by holding period, which
is what Indian capital gains treatment requires. The holding period is counted in
calendar months ("more than 12 months"), not days, by the same test the tax
estimate and the sale preview use.

### CAS import

A Consolidated Account Statement is parsed, matched against existing holdings,
and applied as a plan the household confirms: which schemes map to which
holdings, which are new, and where units disagree.

## Net worth

```
net worth = cash + investments + other assets − credit cards − loans
```

- **Cash**: budget accounts at working balance.
- **Investments**: holdings at market value.
- **Other assets**: hand-valued tracking accounts at their latest valuation.
- **Credit cards**: outstanding balances.
- **Loans**: outstanding principal.

Every line carries the date of its oldest input, and the statement reports the
worst of those. Snapshots are written to `net_worth_snapshots` at month close
and on demand, giving a dated history.

Totals are computed per viewer: an account a member cannot see is excluded from
the total shown to them, not merely from the list.

## When the ledger and the figure disagree

Three kinds of account show a value the app *derives* rather than counts from
their transactions:

| Account | Shows | So a transaction on it |
|---|---|---|
| Tracking, with a stated valuation | the stated figure (B56) | does not move it |
| Investment | market value of its holdings | is counted nowhere |
| Loan | the amortisation schedule | does not reduce what is owed |

Each is defensible alone and indefensible together: the app accepted an entry,
stored it, and showed a number that did not include it.

Two things now address that. Plain transactions are no longer offered against
these accounts on the Add screen — each has a flow that works (revalue, a
portfolio purchase or sale, a loan payment), so offering the account only ever
led somewhere wrong. And `accountDrifts` reports what is already there, or what
a transfer creates, beside the net worth total.

It **reports rather than resolves**, deliberately. Adding the movements is
right for a recurring deposit being paid into and wrong for a revalued flat,
where the stated figure already includes everything. Only the household knows
which it meant, so the divergence is surfaced and they decide — the same thing
this app does when a statement and the ledger disagree. The threshold is ₹500,
the one Q12 set for loan reconciliation.

## A hand-valued asset over its life

Four things happen to gold, and until recently only two of them could be
recorded:

| | Route | What it records |
|---|---|---|
| Buy it | `/portfolio/asset/new` | The asset, and optionally the money that left to pay for it |
| Buy more | `/portfolio/asset/:id/add` | The payment, and the new total value |
| Revalue it | `/portfolio/asset/:id/revalue` | What it is worth now. No money moves |
| Sell some | `/portfolio/asset/:id/dispose` | The proceeds, and what is left |
| Sell all | the same route, with nothing left | The proceeds; the account closes |

Its history is on **its own account page**, reached from Accounts like any
other. A hand-valued asset has no transactions and never will — its worth is
stated, not counted — so where a register would be, it shows every valuation it
has had, with the change between each and the note saying what happened:
*Added ₹50,000*, *Revalued*, *Sold part for ₹80,000*. Nothing is overwritten,
so what you thought it was worth in March is still there in December. R23.2 has
written that series all along; until now nothing displayed it.

**Selling part of it is the ordinary case.** A few grams of gold, not the whole
holding. Disposal used to be all-or-nothing, so somebody selling a portion had
to close the account and open a new one for the remainder — losing the history
to record something that did not happen. Now the sale asks what is left: zero
closes the account, anything else keeps it open at that value.

Only the hand-valued kinds have any of this. A fixed deposit is a tracking
account worth its balance, so there is nothing to state and revalue is not
offered on one — selling it is money arriving in another account, recorded
there.

What you paid and what it is worth are never assumed to be the same number.
Adding to a pot prefills the new value with the old one and lets you correct it:
gold bought at a premium is worth the market rate the moment you own it.

## Disposing of a hand-valued asset

An asset could be created and revalued but never sold, so gold that paid for a
wedding stayed on the statement forever and the only way out was revaluing it to
zero — losing both the proceeds and the fact that anything happened.

`/portfolio/asset/:id/dispose` records both halves: the asset is valued at zero
on the date and its account closed, and the proceeds are recorded arriving in an
account you choose. Either half is optional — proceeds of zero is a valid answer
for something given away or lost, and "nowhere" is valid if the money has not
landed yet. The dated history stays, because the account is closed rather than
deleted.

Creating an asset asks the mirror question. If you just bought it, the money
leaves an account you name; if you already owned it, nothing moves. Without that,
net worth rose by the value of the asset with nothing on the other side.

## Counted, or derived

The line that matters is not "tracking or not" — it is whether the figure on
screen is **counted from transactions** or **derived somewhere else**.

**Counted.** Budget accounts, credit cards, and most tracking accounts: a fixed
or recurring deposit, a savings account somebody watches without budgeting from
it, "other asset", "other liability". These are worth their balance, so posting
to them is how you say what happened, and they are ordinary everywhere —
listed on Accounts, offered when adding a transaction.

**Derived.** A demat account is worth the market value of its holdings; a loan
or an EMI, what its schedule says; a family loan, the transfers behind it; a
hand-valued asset, its latest dated valuation. A plain transaction against one
of these is stored and reflected in none of them, so they are **not offered
when adding a transaction** — each has a flow that does work (a portfolio
purchase or sale, a loan payment, a revaluation). `DERIVED_VALUE_SUBTYPES` is
that list.

They all still appear on the Accounts screen, because that is the list of what
the household has.

### Two subtypes that were saying the same thing twice

`deposit` and `receivable` are gone. The first duplicated fixed and recurring
deposits, which are tracking accounts worth their balance — a household with a
fixed deposit had two places to put it and two different behaviours, one where
interest moves the balance and one where it is a number retyped each month. The
second duplicated family lending, which tracks money owed to you better, because
it derives the balance from the actual transfers.

### Where interest on a deposit goes

Into the deposit, as a transaction. A fixed or recurring deposit is a tracking
account precisely so that it can hold one: credit the interest to the account
and the balance — which is what the deposit is worth — moves with it. Nothing
reaches the budget, which is right for a cumulative deposit, since the money is
not spendable until maturity.

Interest that is *paid out* to a savings account instead is ordinary income in
the account it lands in, recorded like any other.

Either way it is taxable, and the tax screen does not read it: enter it in the
gross figure there. That screen asks for gross rather than deriving it for
exactly this reason — what arrived in the accounts this app can see is not the
same thing as taxable income.

**Do not also state a valuation on a deposit you track this way.** A stated
figure overrides the balance (B56), so the interest transactions stop counting.
`accountDrifts` reports it if it happens.

### "Other liability" is a debt, so it is on Loans

It appears under *Everything you owe*, alongside money borrowed from family.
That table used to show only loans and credit cards, which made its heading
false.

## Financial independence

```
target        = annual spending ÷ withdrawal rate
years to hit  = ln(target ÷ corpus) ÷ ln(1 + real return)
```

**Spending** is money leaving categories over a trailing window, annualised —
the same measure the buffer uses (`envelopeSpendBetween`), so a card swipe
counts on the day it happens and settling the card afterwards does not count
again. This matters more here than anywhere else in the app: the target is that
figure multiplied by roughly thirty, so an error arrives multiplied too.

**Corpus** is only what can actually be drawn down:

| Counted | Held apart | Not counted |
|---|---|---|
| Budget accounts, investments, deposits, commodities | Retirement balances (EPF, NPS) | Physical assets, and anything with no asset class set |

A home is on the net-worth statement and not here — you cannot sell a tenth of
it each year. Everything excluded is listed on the screen with its reason, so
the gap against net worth is visible rather than mysterious.

**No further earnings are assumed.** The corpus grows on its own real return
and by nothing else: no salary, no continued saving. The screen answers "when
is what I already hold enough", not "when could I stop if I keep saving at this
rate" — the second needs a contribution assumed decades forward, which is the
easiest promise such a screen can make and fail to keep. Income and the savings
rate are still shown, because they explain the gap; they are not projected.

**The bridge.** A provident fund cannot be drawn before 58–60. Given an age,
the screen reports the years between stopping and that unlock, and whether the
drawable corpus alone covers them at current spending. Growth during the bridge
is deliberately ignored: a drawdown that depends on a good decade is not a
bridge.

The default withdrawal rate is 3.5%, not 4%. The familiar figure comes from US
data over a 30-year retirement; Indian inflation has run higher and retiring
early asks the money to last longer. The page shows what 4% would claim beside
it rather than hiding the disagreement. Rate, real return, age and whether
locked balances count are all controls.

Totals are per viewer, as everywhere else: a private investment account never
reaches another member's corpus, since a total including what they cannot see
would publish it by subtraction.
