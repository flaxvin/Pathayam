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
              └────── contribution ₹38,000 ──────┘
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

## 3. Q2 · Paying a household bill from a personal account

This is the question that decides the product, and it has two honest answers.
Both are needed.

### 3.1 The default — contribute, then the household pays

Ravi moves ₹38,000 from HDFC Savings to Joint Current. Money genuinely moves.

```
Ravi's budget      Joint Current is not his, so this leaves his budget:
                   an outflow of ₹38,000, filed to the "Household" envelope
                   HDFC Savings  −₹38,000        Household envelope −₹38,000

Household budget   The money arrives with no job yet:
                   Joint Current +₹38,000        Ready to Assign  +₹38,000
                                                 → assigned to Rent
```

Two identities, both still closed, and the ₹38,000 is counted once in each
because it is a different thing in each: spending in his, income in the
household's. This is exactly how the app already treats a transfer to an account
outside the budget, so **no new primitive is needed for the common case.**

### 3.2 The exception — paid on somebody's behalf

Priya pays the ₹4,200 electricity bill from her own card because she happened to
be the one holding the phone. Nobody wants to reverse that into a contribution.

```
Priya's budget     Amazon Pay      −₹4,200
                   Owed by household  +₹4,200      ← a receivable, not an envelope

Household budget   Electricity envelope −₹4,200
                   Owed to Priya       +₹4,200      ← a liability
```

Each identity stays closed by gaining **one term**: money due between budgets.

```
Σ accounts = Σ categories + RTA + held + future − unfunded credit
             + due from other budgets − due to other budgets
```

Settling is then an ordinary transfer that clears both sides, and the shape is
already familiar: family lending is a tracking account with a derived balance
and this is the same idea pointed inward. **Reuse that code rather than
inventing a second one.**

### 3.3 Why not allow a personal account to fund a household envelope directly

Because the money would be in two budgets at once. Ravi's identity would show
cash he no longer controls, or the household's would show an envelope funded by
money it cannot spend. One of the two identities has to break, and the whole
value of this engine is that neither does.

---

## 4. Q3 · Splitting one receipt across budgets

A supermarket trip that is half household groceries, half Priya's own things.

Splits already exist within a transaction. They gain a budget per line:

```
Amazon Pay ICICI (Priya's personal)   −₹3,400
  ├ ₹2,000  Household · Groceries     → becomes "owed by household ₹2,000"
  └ ₹1,400  Priya     · Personal      → ordinary spending in her budget
```

The household line behaves exactly as §3.2: an envelope falls there, a
receivable rises here. One rule, two places it applies.

---

## 5. Q4 · Settling up

The app tracks the running balance between each pair of budgets and shows it
where it matters. It does **not** invent a settlement schedule — real households
settle irregularly and an app that nags about ₹340 is an app people stop
reading.

- The figure appears on each budget's screen: *"Household owes you ₹6,200."*
- Settling is a transfer, and it clears the receivable automatically.
- A balance that has been outstanding for two months appears in the digest,
  once, and can be muted like every other digest kind.

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

---

## 7. What this does to the schema

| Table | Change |
|---|---|
| `budgets` | **new** — `id`, `kind` (`personal`/`household`), `member_id`, name |
| `accounts` | `budget_id` — which budget's money this is. Null for Tracking. |
| `category_groups`, `categories` | `budget_id` — envelopes belong to one budget |
| `assignments`, `held_for_next_month`, `targets` | inherit through the category or gain `budget_id` |
| `transaction_splits` | `budget_id` — for §4, the line's budget when it differs from the account's |
| `month_rollups`, `month_rollup_state` | keyed by `(budget_id, month)` |
| `month_closes`, `goals` | `budget_id` |
| `inter_budget_balances` | **new** — the §3.2 receivable, or reuse family lending |

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
| 3 · Inter-budget balances: the new term, settling, the digest item | 2–3 w |
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
5. **Inter-budget balances** — §3.2, the receivable. The hardest part, done last
   and on top of an engine already proven per budget.
6. **Splits across budgets** — §4, which is the receivable applied per line.

Steps 1 and 2 are the foundation and carry the migration risk. Step 5 is where
the design could still be wrong, and putting it last means finding that out
against a working system rather than a half-built one.
