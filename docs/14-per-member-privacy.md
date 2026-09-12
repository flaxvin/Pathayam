# 14 · Per-member accounts and budgets — feasibility

**Written 12-09-2026. Analysis only; no code has been changed.**

The request: accounts of every type, assets, loans and **the budget** become
per-individual, with a share-with-household flag on create and edit, the owner
shown as a tag when shared, and an option to hide an account from "view as".

---

## 1. The short answer

| Piece | Feasible? | Effort |
|---|---|---|
| Owner tag on shared things | Yes, mostly built | ~0.5 week |
| Private **assets and loans** | Yes, genuinely easy | 1–1.5 weeks |
| Hide an account from "view as" | **Yes** — see §5 for the caveat that matters | 2–3 days |
| Private **accounts**, budget still shared | **Not coherent** — see §3 | — |
| Per-individual **budgets** | Yes, but it is a different product | **12–20 weeks** |

The middle row is the finding worth having. Three of the four pieces are easy.
The fourth is not a feature, it changes what the app *is*, and there is a
version of the request that looks cheap but cannot be built honestly.

---

## 2. What is true today

Measured from the tree rather than remembered:

```
member-scoped queries in the engine          0
"FROM accounts" in non-test source          29
"FROM transactions"                         92
"FROM categories"                           19
"FROM assignments"                          12
engine.ts + repository.ts + viewmodel.ts  1,542 lines
tables that would need a budget scope        24
tests                                  827 across 59 files
```

**The engine is entirely member-blind.** Not incidentally — by design. `02` §3
is one household with one shared budget, `schema.ts` enforces `CHECK (id = 1)`
on the household row, and the whole engine exists to keep *one* equation true:

```
Σ budget-account balances
  = Σ category balances + Ready to Assign + held
  + Σ future assignments − unfunded credit absorbed
```

Per-individual budgets means this becomes **one identity per person**, plus one
for anything shared. That is the whole job, and everything below follows from it.

What already exists and can be reused: transactions carry an owner (H2), cards
carry a holder, accounts carry a holder as of yesterday (H2.1), Query groups by
who spent it, and categories can already be hidden — so a visibility mechanism
has precedent.

---

## 3. The problem with "private accounts, shared budget"

This is the cheap-looking version, and it does not work. It is worth being
precise about why, because the flaw is arithmetic rather than aesthetic.

Ready to Assign is a **sum over every budget account**. If Priya's account is
private but still funds the household budget, then Ravi sees a Ready to Assign
computed partly from a balance he is not allowed to see. He knows every other
account's balance. So:

```
Priya's hidden balance = Ready to Assign + Σ assigned − Σ visible balances
```

**One subtraction and the privacy is gone.** Worse, it is gone *silently* — the
app would be presenting a number as private while publishing it, which is a
worse failure than not offering privacy at all.

Every aggregate has the same property: net worth, the month-close summary, the
runway figure, the reports. You cannot hide an input while showing a total built
on it.

There are only two honest resolutions:

- **The private account is not a budget account.** It is tracking-only, feeds
  nothing, and appears in no shared total. Cheap, coherent, and limited.
- **The budget itself is per-person.** Then there is no shared total to leak
  through, because the money was never pooled. This is §4.

---

## 4. Per-individual budgets — what it actually takes

### 4.1 The model

A **scope** owns money: one per member, plus one for the household. Every
budget-bearing row belongs to exactly one.

```
  Ravi's scope        Priya's scope        Household scope
  ├ accounts          ├ accounts           ├ accounts (joint)
  ├ categories        ├ categories         ├ categories (rent, groceries)
  ├ Ready to Assign   ├ Ready to Assign    ├ Ready to Assign
  └ identity ✓        └ identity ✓         └ identity ✓
```

Three identities instead of one, each asserted independently.

### 4.2 The new concepts this forces

None of these exist today, and each is a design question before it is code:

1. **Contribution.** Ravi moves ₹30,000 from his scope to the household scope for
   rent. That is not a transfer between accounts — the account may not move at
   all — it is money changing *budget*. A new primitive, and it has to appear in
   both scopes' identities without being counted twice.
2. **Shared spending from a private account.** Priya pays the electricity bill
   from her own account. Which envelope falls, hers or the household's? Both
   answers are defensible and they produce different products.
3. **Splitting.** One supermarket receipt, half household and half personal.
   Splits exist, but not across scopes.
4. **Settling up.** If contributions are unequal, does the app track who owes
   whom? Family lending already models this shape and would need connecting.
5. **What the budget screen shows.** Your scope, the household scope, or a
   combined view? A combined view re-introduces the §3 leak unless the totals
   are kept separate.

### 4.3 The work

| Phase | Item | Est. |
|---|---|---|
| **1 · Design** | Settle the five questions above, in writing, with worked ₹ examples | 1–2 w |
| **2 · Schema** | `scope` table; `scope_id` on 24 tables; migration that puts every existing row in the household scope | 1–1.5 w |
| **3 · Engine** | `loadEngineInput` per scope; identity per scope; the contribution primitive; rollup cache keyed by scope | 3–4 w |
| **4 · Reads** | Scope every read across ~152 call sites on the four core tables, plus loans, assets and reports | 2–3 w |
| **5 · UI** | Scope switcher, combined view, share flag on create/edit, owner tags, cross-scope splits | 2–3 w |
| **6 · Tests** | Rework the ~827-test suite for N budgets; identity tests per scope; new tests for contributions and splits | 2–3 w |
| **7 · Migration** | Existing households must land somewhere sensible without losing history or breaking the identity | 1–1.5 w |
| | **Total** | **12–20 weeks** |

For comparison: `12` costed full SaaS multi-tenancy at 41–66 weeks and managed
hosting at 14–19. **This is the same order of magnitude as the entire hosting
programme**, for a single household feature.

### 4.4 The risk that is not in the table

Every one of the 827 tests currently asserts the behaviour of a shared budget.
Reworking them is in the estimate; what is not is that the identity test — the
single thing that has caught the most serious bugs in this project — has to be
re-derived for N scopes before it can guard anything. Until that is done and
trusted, the engine is being changed without its safety net.

---

## 5. Hiding an account from "view as" — yes, with a caveat

**Yes, and it is about two days.** Impersonation already resolves to a distinct
"viewing as" member in `sessions.ts`, so the filter has an obvious home, and
categories already support hiding, so the pattern exists.

Two things must be true for it to be honest:

1. **The hidden account must leave the totals too.** Hiding a row while its
   balance stays in the sums is the §3 leak again, one subtraction away.
2. **It is a courtesy, not a security boundary.** Anyone who can impersonate can
   usually also reach `/export.json`, the Health screen, and — on a self-hosted
   box — the SQLite file itself. Label the control *"not shown when someone
   views as you"*, never *"private"*, because the second is a promise the
   deployment cannot keep.

If real confidentiality between household members is wanted, that is
encryption-per-member, which is a different and much larger conversation.

---

## 6. Recommended plan

### Step 1 — Decide which product this is *(no code)*

The request as written contains both readings. They are not variations, they are
different applications:

- **"I don't want my partner browsing my register."** A visibility feature.
  Cheap, and §6.2 delivers it.
- **"We keep our money separate and split the shared bills."** A different
  product. §4, and worth doing properly if it is what is wanted.

Nothing below step 1 should start before this is settled, because the cheap path
is not a stepping stone to the expensive one — scoping 24 tables afterwards is
the same work plus a migration.

### Step 2 — Ship the cheap 80% *(2.5–4 weeks)*

Valuable on its own, and it does not prejudice the decision above:

| | |
|---|---|
| **Owner tags everywhere shared** | Accounts have a holder already; extend to assets and loans and show the tag. ~0.5 w |
| **Private assets and loans** | Neither feeds Ready to Assign, so §3's leak does not apply. A `visibility` column and a filter. Net worth needs a per-member view, which is the only real work. 1–1.5 w |
| **Private tracking accounts** | Same reasoning: tracking accounts never fund the budget. 0.5 w |
| **Hide from "view as"** | §5, honestly labelled. 0.5 w |
| **Share flag on create and edit** | The UI the request asks for, wired to the above. 0.5 w |

What this deliberately does **not** do: make a *budget* account private. That is
the one case §3 forbids, and the create form should say so in a sentence rather
than offering a checkbox that cannot mean what it says.

### Step 3 — Only if step 1 chose separate budgets

Run §4 as its own project, starting with the two weeks of design. Do not begin
the schema work until the five questions in §4.2 have worked ₹ examples, because
they determine the shape of the scope table and getting that wrong costs the
whole of phase 3.

---

## 7. What I would do

Step 2, now. It answers the practical complaint — *"my accounts, my assets, my
loans, tagged and shareable"* — in under a month, without touching the engine or
its identity.

Then use it for a few months before deciding on step 3. Separate budgets are a
real and legitimate way for a household to run its money, and this app cannot do
it today; but 12–20 weeks is a serious commitment for a two-person household, and
the cheap version may turn out to have been the actual want.
