# Accounts and transactions

## Account kinds

The **kind** determines how the engine treats an account. The **subtype**
determines what the interface calls it and which extra fields apply.

| Kind | Subtypes | In the budget | In net worth |
|---|---|---|---|
| `budget` | `savings`, `current`, `cash`, `wallet` | Yes — feeds Ready to Assign | Yes, as cash |
| `credit` | `credit-card`, `charge-card` | Owns a payment envelope | Yes, as a liability |
| `tracking` | `asset`, `liability`, `loan`, `emi`, `fixed-deposit`, `recurring-deposit`, `family-loan` | No | Yes |

Fields by subtype:

- `credit-card`, `charge-card`: `credit_limit`, `statement_day`, `due_day`.
- `fixed-deposit`, `recurring-deposit`, `asset`, `liability`: worth the
  balance their register adds up to, unless a dated valuation states
  otherwise — in which case the stated figure is what net worth uses, and
  carries its own date and staleness. Recorded on `/portfolio/valuations` or
  `/portfolio/asset/:id/revalue`, the same screens the Portfolio-created
  asset subtypes use.
- `loan`, `emi`, `family-loan`: balances are derived from the companion tables
  and cannot be edited directly. These accounts are created and managed from
  `/loans` and `/family`.

An account carries `budget_id` (which budget it belongs to), `holder_member_id`
and `visibility` (`household` or `private`). See [privacy.md](privacy.md).

## Balances

| Balance | Definition |
|---|---|
| **Cleared** | Opening balance plus transactions marked cleared. |
| **Uncleared** | The sum of transactions not marked cleared. |
| **Working** | Cleared plus uncleared. What the engine uses. |

## Transactions

A transaction has an account, a date, a signed amount in paise, an optional
payee, and — for outflows — a category. Negative is money out.

Rules enforced on write:

- An outflow must name an envelope. Money in does not: its job is to arrive in
  Ready to Assign.
- The envelope must be visible to the member writing it.
- A split's parts must sum exactly to the transaction amount.
- A transaction on a tracking account must not carry a category; tracking
  accounts are outside the budget.
- Deleting is soft (`deleted_at`). The row remains so the activity log and undo
  can reach it.

Optional fields: `memo`, `tags`, `owner_member_id` (who spent it),
`reimbursable`, `card_id` (which physical card on a multi-card account),
attachments.

### Raw values

Imported transactions retain `raw_narration`, `raw_payee`, `raw_amount` and
`raw_date` exactly as received. These are shown on the transaction page and are
never overwritten by later edits.

## Transfers

A transfer is two transactions sharing a `transfer_pair_id`, one negative and
one positive, on different accounts. Neither carries a category: money moving
between your own accounts is not spending.

Editing or deleting one leg acts on both.

## Splits

A split transaction carries `is_split = 1`, no `category_id`, and rows in
`transaction_splits`. Each part has its own category and optional memo. Reports,
envelope activity and the engine all read the parts.

## Payees

A payee is a household-wide name. `payee_aliases` maps raw narration fragments
to it, so an imported row resolves to the same payee as a typed one.

Merging sets `merged_into_id` on the losing payee and repoints its
transactions. A payee that has only ever appeared on accounts a member cannot
see is not offered to that member.

## Tags

Free-form labels on transactions. A tag may carry `budget_amount` with
`starts_on` and `ends_on`, which makes it a spending budget for a project or
trip, reported independently of envelopes.

## Reconciliation

Reconciling an account records a `bank_balance` at an `as_of` date against the
application's computed balance. If they differ, an adjustment transaction can be
created to close the gap.

A checkpoint **breaks** when a transaction dated on or before `as_of` is later
added, edited or deleted. The account shows the break and the reason until it is
reconciled again.

## Credit cards

An account of kind `credit` may have several physical `cards` — a primary and
add-ons — each with its own last four digits and optional holder. Imported rows
are attributed to a card by matching the digits in the narration.

Recording a statement (`card_statements`) stores the statement date, due date,
amount and minimum due. Funding advice keys off the statement rather than the
calendar month, because statement cycles do not follow calendar months.

## Account lifecycle

- **Closing** an account keeps its history and removes it from pickers. Closed
  accounts can be reopened.
- An account with a non-zero balance warns before closing.
- **Opening balances** are set at creation with an opening date, and are treated
  as income to Ready to Assign in that month for budget accounts, and as
  starting debt for credit accounts.
