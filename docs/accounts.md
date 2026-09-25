# Accounts and transactions

## Account kinds

The **kind** determines how the engine treats an account. The **subtype**
determines what the interface calls it and which extra fields apply.

| Kind | Subtypes | In the budget | In net worth |
|---|---|---|---|
| `budget` | `savings`, `current`, `cash`, `wallet` | Yes — feeds Ready to Assign | Yes, as cash |
| `credit` | `credit-card`, `charge-card` | Owns a payment envelope | Yes, as a liability |
| `tracking` | `savings`, `current`, `asset`, `liability`, `loan`, `emi`, `fixed-deposit`, `recurring-deposit`, `family-loan` | No | Yes |

`savings` and `current` appear under both `budget` and `tracking`, and that is
deliberate: whether you budget from an account is a decision about the account,
not a fact about what sort it is. A salary account you assign every rupee of and
a parent's account you only keep an eye on are both savings accounts.

Because of that, the account form offers the **pair** as one choice — the option
value is `kind:subtype`, grouped under what each kind means. It used to ask for
the two separately and offer every subtype of every kind in one flat list, so
`budget` + `credit-card` was a click away and produced a 500 with no body, which
reads as a save that hangs. `kindsForSubtype()` is the list, derived from
`ACCOUNT_SUBTYPES` so the two cannot drift.

## Counted, or derived

Most accounts are worth what their transactions add up to. Some are worth a
figure computed elsewhere, and for those a plain transaction is accepted and
then reflected nowhere:

| Subtype | Worth |
|---|---|
| `investment` | the market value of its holdings |
| `loan`, `emi` | its amortisation schedule |
| `family-loan` | the transfers behind it |
| `physical`, `commodity`, `retirement` | its latest dated valuation |

`DERIVED_VALUE_SUBTYPES` is that list. Those accounts are not offered when
adding a transaction, they show their derived figure on the Accounts screen
rather than a misleading ₹0, and `accountDrifts` reports any gap already
recorded. Everything else — including deposits and tracked savings — behaves
ordinarily, because posting to them is how you say what happened.

Fields by subtype:

- `credit-card`, `charge-card`: `credit_limit`, `statement_day`, `due_day`.
- `fixed-deposit`, `recurring-deposit`, `asset`, `liability`: worth the balance
  their register adds up to. **Revalue is not offered on these**, and that is
  the point of them being tracking accounts: interest credited to a deposit is a
  transaction, and the balance moves with it. A stated figure would override the
  balance (B56) and silently stop the interest counting from that moment on.
  Hand-valued subtypes — `physical`, `commodity`, `retirement` — are the ones
  with no balance to count, and they are revalued on `/portfolio/valuations` or
  `/portfolio/asset/:id/revalue`.
- `loan`, `emi`, `family-loan`: balances are derived from the companion tables
  and cannot be edited directly. These accounts are created and managed from
  `/loans` and `/family`.

**A plain transfer cannot reach a derived account.** Its value comes from its own
records, so money transferred in would leave the bank and be counted nowhere —
₹5,000 into a demat once made net worth fall by exactly ₹5,000. `createTransfer`
refuses and names the screen that records it properly, and the transfer form
does not offer these accounts. The lending code is the one caller that may,
because a family loan's value is derived *from* its transfers.

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

Editing or deleting one leg acts on both. Specifically:

- **Amount and date** belong to the pair. Change either on one leg and the other
  leg takes the same amount, opposite sign, and the same date. A reconciled
  period on *either* account guards the change.
- **Direction** cannot change from a leg — which account the money left is what
  the transfer is. Delete it and record it the other way.
- **No envelope, ever.** The edit screen offers none for a leg, and the domain
  refuses one. The "money out needs an envelope" rule does not apply: nothing
  was spent.
- **Cleared, memo and tags** stay per leg, because each bank statement clears
  its own side.
- **Delete and its undo** act on both legs. So does undoing an edit.

**Between a card and a tracking account** (topping up a wallet from the card,
an EMI on a loan tracked outside the budget) the card side is treated exactly
like an unfiled charge — or, the other way, an unfiled refund. The tracking
account is outside every budget, so nothing on the budget side meets the money;
the card's debt moves and its payment envelope does not, and the card's funding
warning shows the gap until money is assigned to it. Treating the card leg as a
card *payment*, as it once was, moved the envelope by the full amount with no
category giving it up.

This was documented before it was true. Editing one leg of a ₹1,000 transfer to
₹3,000 used to change that leg alone, and ₹2,000 left one account and arrived
nowhere — the identity was out by that much in every month after. Undoing a
transfer's delete brought back one side. `src/domain/transfer-integrity.test.ts`
now holds all of it.

## Undo

An edit's undo puts back the row **and its split lines**, which live in their own
table — an edit event now records both. Events recorded before that change
can't restore lines they never kept; undoing one of those on a transaction that
was split is refused with a sentence rather than half-applied.

Not every event carries a whole row: marking a line cleared while reconciling
records only `cleared`. Undo writes back exactly the columns an event recorded.

Undoing an account's **creation** is refused once anything has been recorded
against it — transactions, schedules, holdings, reconciliations, imports — and
says so; close the account instead. The list of what counts is read from the
schema's own foreign keys, so a table added later cannot be forgotten. Undoing an
account **edit** restores every column an edit can change, including holder,
visibility, budget and sort order.

Undoing a **payee merge** moves back the transactions and aliases the merge
moved, provided they still sit with the payee they were merged into.

The engine also refuses to be the victim of an inconsistent ledger: split lines
count only when the transaction says it is split, and a transfer leg whose
partner has been deleted counts as an ordinary flow into or out of Ready to
Assign rather than as half of a transfer. On a card, a leg whose partner is gone
counts as an unfiled card charge or refund, for the same reason.

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
