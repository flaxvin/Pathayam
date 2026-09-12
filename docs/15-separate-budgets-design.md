# 15 · Separate budgets — the design

**Written 13-09-2026.** Step 1 of `14`. The decision has been taken: *we keep
our money separate and split the shared bills*, with cards and budget accounts
shareable, and **two kinds of budget — personal and household**.

This document answers the five questions `14` §4.2 said had to be settled before
any schema work, with worked ₹ examples, because they determine the shape of the
tables and getting them wrong costs the whole engine phase.

---

## 1. The model in one picture

```
 ┌─ Ravi's personal budget ─────┐  ┌─ Household budget ───────────┐  ┌─ Priya's ──┐
 │ accounts  HDFC Savings       │  │ accounts  Joint Current      │  │ Kotak      │
 │           Axis Atlas (card)  │  │           Swiggy HDFC (card) │  │ Amazon Pay │
 │ envelopes Personal, Fuel     │  │ envelopes Rent, Groceries,   │  │ Personal   │
 │                              │  │           Electricity        │  │            │
 │ Ready to Assign  ₹12,400     │  │ Ready to Assign  ₹0          │  │ ₹8,900     │
 │ identity ✓                   │  │ identity ✓                   │  │ identity ✓ │
 └──────────────────────────────┘  └──────────────────────────────┘  └────────────┘
              │                                  ▲
              └──── committed ₹38,000, cash stays put ────┘
```

Three budgets, three identities, each closed. A **budget** is the unit that owns
money: `personal` (one per member) or `household` (exactly one).

---

## 2. Q1 · Which budget does an account's money belong to?

**Every account belongs to exactly one budget.** That is the rule everything
else hangs off, and it is what keeps each identity closed.

| | Budget | Who can see it |
|---|---|---|
| HDFC Savings | Ravi's personal | Ravi (private) or everyone (shared) |
| Joint Current | Household | Everyone |
| Swiggy HDFC (card) | Household | Everyone |
| Axis Atlas (card) | Ravi's personal | Ravi |

**Sharing a card or a budget account** means putting it in the household budget.
That is the whole mechanism — one field, `budget_id`, and the request for
shareable cards and accounts falls out of it rather than needing a second
concept.

Note what this replaces: `holder_member_id` from step 2 stops being the
interesting field for Budget and Credit accounts, because the budget now says
whose money it is. It stays meaningful for Tracking accounts, which belong to no
budget at all (FW1), and it stays as the label on shared things.

---

## 3. Q2 · Making private money available to the household

**Money is made available by assigning it, not by moving it.** Inside a personal
budget there is an envelope for the household, and assigning to it commits that
money without any cash leaving the account it sits in.

This replaces the "contribute by transferring first" model this document
originally proposed, and it is better for a reason that took working the
arithmetic to see: it lets a **private** account fund the shared budget without
publishing its balance.

### 3.1 The worked example

Ravi commits ₹38,000. No cash moves; HDFC Savings still holds ₹1,00,000.

```
RAVI'S BUDGET                    HOUSEHOLD BUDGET
HDFC Savings       1,00,000      Joint Current            0
                                 due from Ravi       38,000   ← the claim
Personal             20,000      Rent                38,000
→ Household          38,000      Ready to Assign          0
Ready to Assign      42,000
1,00,000 = 20,000+38,000+42,000  ✓   0+38,000 = 38,000+0      ✓
```

Then the rent is paid **from Ravi's own account**, filed to the household's Rent
envelope. Still no transfer between accounts.

```
HDFC Savings         62,000      Joint Current            0
                                 due from Ravi            0
Personal             20,000      Rent                     0
→ Household               0      Ready to Assign          0
Ready to Assign      42,000
62,000 = 20,000+0+42,000         ✓   0+0 = 0+0                ✓
```

Both identities stay closed at every step.

### 3.2 The identity, revised

Only the **receiving** side gains a term, and it is derived rather than stored:

```
Σ accounts + Σ due from other budgets
  = Σ categories + Ready to Assign + held + future − unfunded credit
```

`due from other budgets` for the household is exactly **the sum of every personal
budget's household envelope**. There is no second ledger to keep in step, no
settlement table, and nothing that can drift — the claim is a view of the
envelope that created it.

The personal side needs no new term at all: the commitment is an ordinary
envelope balance, which is why the personal identity above closes unchanged.

### 3.3 Why this is the answer to `14` §3

`14` established that a private account cannot fund a shared budget, because
Ready to Assign is a sum over every funding account and hiding one publishes it
by subtraction. That is true when the household budget *sums the account*.

Here it never does. The household sums **the commitment**, which its owner chose
and disclosed. Priya learns that Ravi has put ₹38,000 toward the household. She
learns nothing about the ₹1,00,000 it came out of, or which account, or whether
there are others.

**So private budget accounts become possible after all** — not by weakening the
rule, but by removing the thing that made them leak. A budget account in a
personal budget is private by construction, because only its owner can see that
budget at all.

> **Consequence for H2.2.** The `CHECK` added in migration 0023 forbids a Budget
> or Credit account being private, and that is correct *today*, while every
> account is in the one household budget. It has to be relaxed when personal
> budgets exist, to allow it precisely when the account belongs to a personal
> budget. Relaxing it earlier would reintroduce the leak.

### 3.4 Spending on behalf, and overspending the commitment

Paying a household bill from a personal account is one transaction filed to a
**household** category from a **personal** account. It does two things, and the
app already has this exact shape:

| | Spending on a credit card | Spending on the household's behalf |
|---|---|---|
| Reduces | the spending category | the household's category |
| Also moves | into the card's payment envelope | out of the personal "→ Household" envelope |

A credit-card charge already touches two envelopes from one transaction (R6), so
this is a second instance of an idiom the engine has, not a new mechanic.

If the spending exceeds what was committed, the household envelope simply goes
negative in the personal budget — the same red as any other overspend, meaning
*you have spent more on the household than you put aside for it*. Covering it is
the ordinary cover-overspend flow. No receivable, no settlement, no new screen.

### 3.5 Cash that does move

Transferring from a personal account to a joint one still works and still means
what it always meant: money leaving one budget and arriving in another. It is the
right tool when the household genuinely needs the cash in its own account — a
standing instruction for rent, say. §3.1 is for when it does not.

## 3A. Q2a · A shared card — who spends, and who pays

### 3A.1 Who can spend from it

**Anybody in the household, and the app does not try to stop them.** It records
what happened; the bank decides who holds plastic. Sharing a card means putting
it in the household budget (§2), which is a statement about whose *debt* it is,
not about who is allowed to use it.

Two things are already recorded on every charge and carry over unchanged:

- **Which card** it was made on — the primary or a named add-on (R6.c).
- **Which member** spent it (H2), defaulting to the card's holder.

So "who spent from the shared card" is answerable today, per transaction, and
the Cards screen and Query both already group by it.

### 3A.2 Where the payment draws from

**From the card's own payment envelope, which lives in the card's budget.** For a
shared card that is the household's, and it is filled automatically by every
charge — whoever made it.

This falls out of an existing property rather than needing a rule: a credit
balance is **not** on the left side of the identity. `budgetAccountBalance` sums
Budget accounts only. A card charge therefore moves money between two envelopes
and touches no account balance at all:

```
Groceries envelope   −₹2,000      the category gives the money up
Card payment         +₹2,000      the envelope holds it against the debt
budget accounts       unchanged   no cash has moved yet
```

Paying the bill is then a transfer from a household account to the card, which
draws the payment envelope down and the account balance with it. **The household
always pays the whole bill**, because the whole debt is the household's.

### 3A.3 The case that needs the claim: personal spending on a shared card

Priya buys ₹2,000 of her own clothes on the shared card and files it to her
personal Clothes envelope. The card is the household's; the envelope is hers.

```
PRIYA'S BUDGET                   HOUSEHOLD BUDGET
Clothes             −2,000       Card payment        +2,000
owed to household   +2,000       due from Priya      +2,000
0 = −2,000 + 2,000   ✓           0 + 2,000 = 2,000    ✓
```

Both close, and the claim says exactly the true thing: **she used the household's
credit for herself, so she owes the household.** The household still pays the
bank in full; the ₹2,000 is settled between the two of them, not by splitting the
bill.

Settling needs no new mechanism. Either she transfers ₹2,000 to a household
account, or — far more usually — it is simply netted against her "→ Household"
commitment (§3.1), which is the same claim with the opposite sign.

### 3A.4 The one rule underneath all of this

Everything in §3 and §3A is one rule:

> **When a transaction's account is in one budget and its category is in another,
> a claim arises between them.** The "→ Household" envelope is that claim
> pre-funded, which is why spending on the household's behalf draws it down
> instead of creating a debt.

| Account's budget | Category's budget | Effect |
|---|---|---|
| Household | Household | Nothing extra. The ordinary case. |
| Personal | Household | Draws down that member's commitment; overspends it if there is not enough |
| Household | Personal | That member owes the household |
| Personal · A | Personal · B | Allowed **only** through a shared instrument — see §3A.5 |

The last row cannot simply be refused, because an add-on card is exactly that
case and this household already has one.

**The governing rule:** a claim may arise only between budgets linked by an
instrument the household deliberately shared — an account in the household
budget, or an add-on card held by another member. Filing across two personal
budgets with no shared instrument between them is refused, because it would
create a debt through no arrangement either person made.

### 3A.5 Add-on cards

An add-on is not an account (R6.a). It is a second card on somebody else's
account: one limit, one statement, one payment, and **the primary holder is the
one the bank can chase.** So the account's budget — and therefore the payment
envelope — stays with the primary holder, whoever did the spending.

Priya spends ₹6,200 on her add-on of Ravi's personal card and files it to her own
Personal envelope.

```
PRIYA'S BUDGET                   RAVI'S BUDGET
Personal            −6,200       Card payment        +6,200
owed to Ravi        +6,200       due from Priya      +6,200
0 = −6,200 + 6,200   ✓           0 + 6,200 = 6,200    ✓
```

Both close, and the claim states the true position: **Ravi's credit paid for
Priya's shopping, so Priya owes Ravi.** It is the shared-card case of §3A.3 with
a personal budget on the receiving side instead of the household, which is why it
needs no separate mechanism.

The other direction works out too. If she files the same charge to the
household's Groceries envelope, the household owes Ravi — which is just Ravi
spending on the household's behalf (§3.4), and it draws down his commitment.

| Who spent | Filed to | Claim |
|---|---|---|
| Add-on holder | Their own envelope | Add-on holder owes the primary |
| Add-on holder | A household envelope | Household owes the primary; drawn from the primary's commitment |
| Primary | Their own envelope | None — one budget throughout |

This is also why an add-on is worth keeping as a card rather than promoting it to
an account: the liability genuinely is the primary's, and modelling it as a
separate account would put the debt in the wrong budget.

## 4. Q3 · Splitting one receipt across budgets

A supermarket trip that is half household groceries, half Priya's own things.

Splits already exist within a transaction. They gain a budget per line:

```
Amazon Pay ICICI (Priya's personal)   −₹3,400
  ├ ₹2,000  Household · Groceries     → draws on her "→ Household" envelope
  └ ₹1,400  Priya     · Personal      → ordinary spending in her budget
```

The household line behaves exactly as §3.4: the household's envelope falls, and
so does her commitment. One rule, applied per line instead of per transaction.

---

## 4A. Q3a · When one of you has put in more

### 4A.1 The words matter, and "debt" is the wrong one

The app already has transactional language — *"Ammu owes you"*, *write off*,
*forgiven* — and it is right where it lives: `10` §3.5's family lending is money
lent to a cousin, which genuinely is a debt with a creditor.

**Between two people running a household it is the wrong register entirely.**
Nobody says their partner is in default on the electricity. What they say is that
one of them has put in more this month.

| Not this | This |
|---|---|
| debt, claim, liability | what's outstanding between you, the balance |
| Ravi owes the household ₹2,000 | the household is ₹2,000 behind with Ravi |
| creditor, debtor | ahead, behind |
| forgive, write off | call it even |
| settle the debt | square up |
| overspent the commitment | put in more than planned |

The engine's internal terms can stay whatever is clearest for the arithmetic.
This is about every word a person reads.

### 4A.2 Covering your own shortfall is not forgiveness — it is a bigger share

Ravi planned ₹3,000 toward the household and ended up spending ₹5,000 of his own
on groceries. His household envelope sits at −₹2,000, meaning **he is ₹2,000
ahead** — he has put in more than he said he would.

If **Ravi** resolves that from his own Ready to Assign, nothing has been forgiven.
He has simply decided his share this month was ₹5,000.

```
→ Household   −2,000 → 0
Ready to Assign       −2,000        0 = categories + RTA   ✓
```

Mechanically this is the cover-overspend flow that has existed since R4, so there
is nothing to build. What has to change is the **label**: on a household envelope
the button is not *cover overspending*, it is **"Put it down to me"**, and what it
means is that your share for the month has gone up.

### 4A.3 Three different things, and only one of them is letting it go

The same −₹2,000 can end three ways, and they are not the same act:

| | What happens | What it means |
|---|---|---|
| **Put it down to me** | Ravi covers it from his own Ready to Assign | His share this month was simply larger |
| **I'll pick it up** | Priya commits ₹2,000, and the household squares up with Ravi | She has taken on the shortfall; Ravi is made whole |
| **Call it even** | Nobody pays. The balance is closed by agreement | The only one of the three that is actually letting something go |

Only the third is what `10` §3.5 would have called a write-off, and it is the
rarest of the three. The first two are just how a household with two incomes
settles a month.

### 4A.4 Where the money comes from

Priya used the household's shared card for ₹2,000 of her own shopping, so her
household envelope is +₹2,000 — **she is ₹2,000 behind.** The household says
leave it.

The obvious objection is the right one: *the money has to come from somewhere.*
It does, and following the household's side to the end shows where.

```
                                   Joint   owed by   card pay   Gifts     RTA
start                                  0         0          0       0       0
1  Priya charges ₹2,000 on the card    0    +2,000     +2,000       0       0
2  the household calls it even         0         0     +2,000  −2,000       0
3  the bank is paid from Joint    −2,000         0          0  −2,000       0
4  Gifts is funded, as any
   envelope must be               −2,000         0          0       0  −2,000
```

Every line satisfies `Σ accounts + owed to us = Σ categories + RTA`.

**The money comes from the household's own Ready to Assign, at step 4.** Calling
it even is the household buying Priya a ₹2,000 present — which is exactly what
happened, so that is what it should cost and where it should appear.

Step 2 on its own does not conjure anything. It moves an obligation from *Priya
owes this* to *the household spent this*, and the spending still has to be
funded like any other. Skip step 4 and Gifts simply sits at −₹2,000: an ordinary
overspent envelope, which under the default overspend model comes off next
month's Ready to Assign. The household pays either way.

**Calling it even never pays the card bill.** Step 3 happens regardless — the
bank is owed ₹2,000 whatever the two of them agree between themselves. That is
the whole reason the amount must land in a real category: if it vanished at step
2, the payment at step 3 would arrive against nothing and the household would be
short by a figure with no history behind it.

Priya's side is the mirror, and simpler:

```
→ Household   +2,000 → 0        the obligation goes
Ready to Assign      +2,000     she received ₹2,000 of value for nothing
0 = categories + RTA     ✓
```

Her Ready to Assign rises because she genuinely is ₹2,000 better off. The rule
underneath is the one `writeOffFamilyLoan` already encodes, and the vocabulary
does not change it: what is given up is an expense for the one giving it, and
income for the one receiving it.

### 4A.5 What the action needs

- **A category on the side giving it up.** Not optional, for the reason above.
  *Gifts and treats* is the obvious default and the household can pick another.
- **Partial amounts.** ₹2,000 of a ₹6,200 balance is ordinary.
- **Who did it, in the event log.** A balance that changed overnight should have
  an answer. Undoable for thirty days like everything else (R37).
- **It belongs to whoever is ahead.** They are the one giving something up. For a
  balance with the household, any member may act and the log records who.

### 4A.6 Between the two of you

Identical, and it is the add-on case (§3A.5): Priya is behind with Ravi because
she used his card. He can put it down to himself, she can square up, or they can
call it even — the same three endings, with a person on the other side instead of
the household.

§3A.4's restriction carries over: a balance only exists where a shared instrument
created one, so there is never anything to call even that nobody arranged.

## 5. Q4 · Settling up

**Mostly there is nothing to settle**, which is the quiet advantage of §3. A
commitment is spent down by the household spending it; it does not accumulate
into a debt somebody has to square.

Two figures are still worth showing:

- On a personal budget: *"₹6,200 of your ₹38,000 household commitment is
  unspent."* Roll it, release it back to your own Ready to Assign, or leave it.
- On the household budget: what each member has committed this month and how
  much of it is left — the only cross-budget figure anyone needs.

If a member consistently spends more on the household than they commit, their
household envelope runs negative month after month. That is visible to them and
is a conversation to have, not a number for an app to enforce.

---

## 6. Q5 · What the budget screen shows

A switcher, defaulting to whichever budget the member last used.

| View | Shows |
|---|---|
| **My budget** | The member's own envelopes and Ready to Assign |
| **Household** | The shared envelopes and Ready to Assign |
| **Both** | Two columns side by side, totals kept separate — never summed |

**Never a combined total.** Adding a personal Ready to Assign to the household's
produces a number that means nothing and would let one member infer the other's
position by subtraction, which is the same mistake `14` §3 identified.

Another member's personal budget is not visible at all. That is the point of
separating them, and it needs no privacy flag: the budget itself is the boundary.

**Including through "view as"** (`08` R38.6b). That feature is now off unless an
operator enables it (R38.6a), and even then it shows the household budget only —
a personal budget a partner can step into is not a separate budget.

### 6.1 What happens at the end of a month

- **A commitment stays and rolls.** Unspent money in a household envelope carries
  into next month like every other envelope (R3), with no exception for being a
  commitment. Taking it back is a deliberate move out of the envelope, because
  automatically un-committing money the household was counting on is exactly the
  kind of surprise this app exists to avoid.
- **Each budget closes on its own.** The household month can close while a
  personal one is still open, and the other way round. Coupling them would let
  one person's procrastination block the other's ritual. The household's close
  still reports what each member committed and how much of it was spent.

---

## 6A. When a member leaves

Removing a member already keeps their historical attributions (F1.6). With
separate budgets there are two more things to settle, and neither may be silent.

**Their commitments are released.** Money still sitting in their household
envelope goes back to their own Ready to Assign. It was theirs; they simply
promised it, and the promise ends with the arrangement. The household's claim
falls by the same amount and its identity stays closed.

**What was already spent becomes a family loan.** If the household had drawn on
their commitment — or they had spent beyond it on the household's behalf — that
balance does not evaporate because somebody left. It converts into an ordinary
family-lending arrangement (`10` §3.5, F2.10), with them as the counterparty.

That is the right destination rather than a convenient one. Family lending is
exactly "money between this household and a person outside it", which is what
they have just become. It already has advances, repayments, a derived balance and
a write-off, so nothing new is built — and the transactional vocabulary R6.n
forbids between partners is correct again, because they are no longer partners in
the budget.

**Every option is offered, not chosen for them.** Leaving presents the balance
and the ways to end it — settle it now, convert it to a family loan, or call it
even — with the consequence of each written next to it. The app never picks.

## 6B. Goals belong to a budget, and cannot move

A goal is personal or shared, **chosen when it is created and fixed after that**.

The reason is that a goal is measured by its categories' balances (F11), so
moving it between budgets would move money's meaning underneath a figure people
have been watching for months — the trip fund that was yours becomes the
household's, and the history stops describing the same thing.

Creating a new goal in the other budget and closing this one is honest about what
happened. Silently re-pointing it is not.

## 7. What this does to the schema

| Table | Change |
|---|---|
| `budgets` | **new** — `id`, `kind` (`personal`/`household`), `member_id`, name |
| `accounts` | `budget_id` — which budget's money this is. Null for Tracking. |
| `category_groups`, `categories` | `budget_id` — envelopes belong to one budget |
| `assignments`, `held_for_next_month`, `targets` | inherit through the category or gain `budget_id` |
| `transaction_splits` | `budget_id` — for §4, the line's budget when it differs from the account's |
| `cards` | no change. R6.c already records which card and which member for every charge, which is what §3A.1 answers |
| `month_rollups`, `month_rollup_state` | keyed by `(budget_id, month)` |
| `month_closes`, `goals` | `budget_id` |
| — | **no new table.** The household's claim is the sum of the personal budgets' household envelopes (§3.2), so there is nothing separate to keep in step |

`loans`, `holdings`, `lots`, `net_worth_snapshots` need **no** change: they hang
off Tracking accounts, which belong to no budget.

### The migration

Every existing row goes into the household budget, and each member gets an empty
personal one. A household that never touches the feature sees exactly what it
sees today — one budget, called Household.

---

## 8. Effort, revised

`14` estimated 12–20 weeks before this design existed. Two things learned since
move it:

**Down:** the engine's arithmetic does not change at all. `loadEngineInput`
builds its inputs from SQL, and scoping it is one more `WHERE budget_id = ?` on
each of ~37 reads. `computeBudget` operates on whatever it is given and never
learns that budgets exist. That was the part I expected to be hardest.

**Up:** the inter-budget receivable in §3.2 and §4 is a genuinely new primitive
that has to appear in the identity, the undo log, and the month-close ritual.

| Phase | Est. |
|---|---|
| 1 · `budgets` table, `budget_id` columns, migration into the household budget | 1.5–2 w |
| 2 · Engine scoping: `loadEngineInput`, rollup cache keyed by budget, identity per budget | 2–3 w |
| 3 · The household envelope: the derived claim in the identity, spending on behalf, and forgiveness (§4A) | 2.5–3.5 w |
| 4 · Reads and writes across the app scoped to a budget | 2–3 w |
| 5 · UI: switcher, both-view, share controls on accounts and cards, split-by-budget | 2–3 w |
| 6 · Tests: identity per budget, the receivable, migration | 2–3 w |
| | **12–17 weeks** |

---

## 9. The order to build it in

Each step leaves the app working and shippable, which matters over three months.

1. **`budgets` table, everything in the household budget.** No behaviour change
   at all — the app looks identical. This is the riskiest migration and it is
   worth doing while nothing depends on it.
2. **Engine scoped, still one budget.** The identity test now runs per budget
   and there is exactly one. Any regression here is caught before a second
   budget exists to confuse it.
3. **Create personal budgets, empty.** Members can see a second budget with
   nothing in it. Moving an account into one becomes possible.
4. **Contributions** — §3.1, which needs no new primitive.
5. **Cross-budget filing** — §3A.4's single rule, which covers spending on the
   household's behalf and personal spending on a shared card at once. Done last,
   on top of an engine already proven per budget.
6. **Splits across budgets** — §4, which is §3.4 applied per line.

Steps 1 and 2 are the foundation and carry the migration risk. Step 5 is where
the design could still be wrong, and putting it last means finding that out
against a working system rather than a half-built one.
