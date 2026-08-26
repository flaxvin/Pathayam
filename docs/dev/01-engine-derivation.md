# Engine derivation — the identity the budget must satisfy

**Implementation note, not a design doc.** This records the arithmetic behind
`src/engine/`, so the rules in `02` §4 can be checked against something
provable rather than against the code.

---

## 1. The identity

Everything in the engine exists to keep one equation true at the end of every
month `M`:

```
Σ budget-account balances
  = Σ category balances
  + Ready to Assign
  + held for next month
  + Σ assignments made into months after M
  − unfunded credit-card balance
```

Each term is defined below. If a change to the engine breaks this equation, the
change is wrong — `src/engine/engine.test.ts` asserts it after every scenario,
which is the cheapest possible guard against the `05` §7 risk of "engine
semantics get subtly wrong and are discovered in month four".

---

## 2. Sign convention

A transaction amount is **signed paise relative to its own account**. Negative
means money left that account.

| Event | Account | Amount |
|---|---|---|
| Spend ₹1,800 from savings | savings | −1,80,000 p |
| Salary ₹80,000 into savings | savings | +80,00,000 p |
| Spend ₹1,800 on a credit card | the card | −1,80,000 p |
| Pay the card ₹18,400 from savings | savings | −18,40,000 p |
| …the other leg of that payment | the card | +18,40,000 p |

A credit account's balance is therefore negative while money is owed, which is
what `02` R6 describes ("the card account balance becomes more negative").

Account balance = opening balance + Σ of its transaction amounts.

---

## 3. `to_budget` — what actually reaches Ready to Assign

For each month `m`:

```
to_budget(m) = Σ over budget accounts of
                 opening balances dated in m
               + Σ non-transfer transaction amounts in m
               − Σ amounts of those transactions that carry a category
```

Three consequences, all of them intended:

- A **salary** lands uncategorised, so `amount − 0 = amount` reaches RTA (F2.5:
  an opening balance "MUST arrive in RTA as income").
- A **categorised spend** contributes `amount − amount = 0`. It reduces the
  account balance and the category balance equally, and never touches RTA.
- An **uncategorised spend** reduces RTA directly. This is honest — the money
  is gone and no envelope recorded it — and it is why F4.1 flags an
  uncategorised transaction as needing attention.

**Transfers are excluded entirely.** Between two budget accounts they would net
to zero anyway; to a credit account the budget-side leg must reduce the card's
payment category rather than RTA (R6), which §5 handles.

---

## 4. Ready to Assign

```
RTA(M) = Σ to_budget(m) for m ≤ M
       − Σ assignments in every month, past, present and future
       − held for next month, set in M
       − Σ cash overspend carried into any month ≤ M
```

Subtracting assignments from *every* month, including future ones, is `02` R2
as written: all months draw on one pool of cash held today (R1, R7).

**Why past assignments are subtracted but past income is not "given back".**
`to_budget` counts only uncategorised flows, so money that was assigned and
then spent never re-enters the sum. Assign ₹1,00,000 in January and spend
nothing: February's RTA is `1,00,000 − 1,00,000 = 0`, and the money is visible
in the category where it actually sits.

**The known wart.** Viewing a *past* month subtracts assignments made in months
since, so a July view in December can read lower than July ever did. This
follows R2 literally. It is contained by itemising the breakdown — the RTA
popover shows "assigned in future months" as its own line — and the historical
answer proper comes from the as-of-date view (`08` F25.11).

### R2's worked example, and the state it leaves implicit

> Budget accounts hold ₹1,20,000. ₹10,000 held for next month. Last month
> over-spent cash by ₹2,500. Assigned this month ₹85,000, assigned to next
> month ₹5,000. RTA = ₹17,500.

The example states its outputs but not the July that produced them, and **not
every July reaching those inputs gives ₹17,500**. If July ends with every
category at zero, the answer is ₹20,000, not ₹17,500 — because a cash
overspend has already left the bank, so it is inside the ₹1,20,000 balance
*and* subtracted again as the carry.

The reading that is self-consistent is that July also left a positive balance
carrying forward. Reconstructed:

| July | |
|---|---|
| Income | ₹1,42,500 |
| Assigned to Groceries | ₹20,000 |
| Assigned to Travel | ₹2,500 |
| Spent from Groceries | ₹22,500 → overspent ₹2,500 |

Then August opens with Travel holding ₹2,500, bank balance
`1,42,500 − 22,500 = ₹1,20,000` ✓, and:

```
RTA = 1,42,500 − (20,000 + 2,500 + 85,000 + 5,000) − 10,000 − 2,500 = ₹17,500 ✓
```

The identity confirms it: `1,20,000 = 87,500 (categories) + 17,500 (RTA)
+ 10,000 (held) + 5,000 (September)`.

Reproduced as a test in `engine.test.ts`, with the reconstruction spelled out
so the assumption is visible rather than buried.

---

## 5. Credit cards — R6 without synthetic transactions

The payment category's **activity is derived, never stored**:

```
payment category activity(M) = − Σ (all transactions on that credit account in M)
```

One rule covers every case in R6, because the payment envelope is tracking the
change in the debt:

| Event on the card | Amount | Contribution | Correct? |
|---|---|---|---|
| ₹1,800 purchase charged to Groceries | −1,800 | +1,800 | Reserves the cash to clear it |
| ₹18,400 payment from savings | +18,400 | −18,400 | Spends the reserve, touches no spending category |
| ₹500 annual fee, categorised to Fees | −500 | +500 | The fee needs funding too |
| ₹900 refund, categorised | +900 | −900 | Releases money that is no longer owed |

The **opening balance is excluded** from the sum, so starting debt does not
fund itself: R6 says the payment category "starts at ₹0" and the gap is shown
as a debt figure, not a budgeting error.

Nothing synthetic is written to the ledger, so there is no second record to
drift, and "explain this number" on a payment-category balance can name the
actual card transactions behind it.

**Add-on cards** (`09` §4) need nothing here: an add-on is a card *on* the
account, so its spending is already inside the same sum, settled by the same
payment category. The `card_id` column is what makes R6.c/R6.d — which card,
which member — answerable.

### 5.1 The unfunded figure cannot be derived by subtraction

R6 describes the warning as "the payment category holds less than the card
balance". Implemented literally that never fires, and the reason is worth
recording because it is not obvious:

```
payment envelope balance = assigned + (− card flow)
card debt                = − card flow
```

The two move together by construction. Subtracting one from the other gives
`assigned`, never a shortfall.

What actually goes missing is upstream. A ₹4,200 card purchase from a category
holding ₹1,000 still moves ₹4,200 into the payment envelope — but ₹3,200 of it
came from an envelope that had nothing to give. The envelope *looks* funded;
₹3,200 of it is not real money.

So the figure is the **credit overspend itself**, carried per card:

```
unfunded(card) = max(0, debt − (payment envelope − credit overspend on that card))
```

Where a category was charged to several cards, the overspend is split between
them in proportion to what each was charged, so S2b can name a card rather than
report a household-level total.

This only became visible by running the app against seeded data — every
engine test passed while the warning could never fire. It is covered now by
`engine.test.ts` under "a credit overspend leaves the card's balance partly
unfunded".

---

## 6. Overspending, and telling the two kinds apart

A category ending the month negative is split by cause, because R4 and R6
handle them differently and only one of them destroys cash:

```
credit overspend = min(|negative balance|, outflow charged to cards in that category this month)
cash overspend   = |negative balance| − credit overspend
```

**Cash overspend**, default model (Actual's): the category reopens at zero and
the amount is subtracted from the next month's RTA. The money genuinely left a
budget account, so RTA is where the loss belongs.

**Cash overspend**, alternative model (YNAB-style, a household setting per Q1):
the negative rides on the category into the next month and RTA is untouched.

Both preserve the identity in §1, which is what makes shipping both cheap
rather than a rewrite — the difference is only *which* term absorbs the
negative. Both are implemented and tested; neither is a stub.

**Credit overspend** never reduces RTA — no cash was created (R6). The category
reopens at zero and the shortfall surfaces as the `unfunded credit-card
balance` term in the identity, which is the figure S2b states in words:
*"₹3,200 of this balance isn't funded yet"*.

---

## 7. Moving money (R5)

A move is two assignment deltas in the same month: `−X` from the source, `+X`
to the destination. `Σ assignments` is unchanged, so **RTA does not move** —
which is what J4 requires.

The table stores the net assigned figure per (month, category); the *event log*
records that the change was a move and where it went. That is what lets J22
answer with "₹1,850 moved out to Eating Out on 14-08 by Priya" rather than
"assigned changed from 12,000 to 10,150".
