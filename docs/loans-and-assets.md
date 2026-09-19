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

For a `flat` loan the equivalent reducing-balance rate is calculated and shown,
because a flat rate understates the real cost.

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

A loan can be closed by settlement, with an optional foreclosure charge. Closing
releases the payment envelope's target.

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
| split | Adjusts units by ratio, preserving cost. |
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
is what Indian capital gains treatment requires.

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
| Sell it | `/portfolio/asset/:id/dispose` | It is gone, and where the proceeds landed |

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

## Which screen an account lives on

A tracking account shows a figure this app derives rather than counts, and it is
derived on the screen that owns it — Portfolio for what is held, Loans for what
is owed. So tracking accounts are **not listed on the Accounts screen** and are
not offered as the target of a plain transaction: beside accounts you can
transact on they looked like accounts you can transact on, and an entry against
one went nowhere visible. Each still has its own page, and every link to it
still works.

A deposit belongs on Portfolio, because a household thinks of it as something
held. "Other liability" does not — it is a debt, so it appears on Loans under
*Everything you owe*, alongside money borrowed from family. That table used to
show only loans and credit cards, which made its heading false.

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
| Budget accounts, investments, deposits, commodities | Retirement balances (EPF, NPS) | Physical assets, receivables, untyped assets |

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
