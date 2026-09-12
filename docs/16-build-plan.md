# 16 · The build plan

**Written 13-09-2026.** Everything agreed across `14`, `15` and the decisions
since, in the order it gets built. The separation of personal and household
money comes first; everything else waits behind it.

Two phases are already done. They are listed so the sequence reads whole.

---

## Where it stands

| | | |
|---|---|---|
| ✅ | **P0 · Budgets exist** | `budgets` table, `budget_id` on accounts and envelopes, everything backfilled into one household budget. No behaviour change. |
| ✅ | **P1 · The engine is scoped** | `loadEngineInput` computes one budget. Identity holds per budget on cached and uncached paths, verified over 36 months. |
| ✅ | **P1a · View-as gated** | Off unless `ADMIN_DEBUG`; household budget only when on (R38.6a–b). |
| ⬜ | **P2 → P7** | Below. |

---

## P2 · Personal budgets, and moving money's home into one

**The first thing a household actually sees.** Until this ships, the rest is
plumbing nobody can touch.

| | Est. |
|---|---|
| Create a personal budget per member; `ensurePersonalBudget` gets its route | 0.5 w |
| Budget switcher in the chrome — *My budget* / *Household* — remembering the last used | 0.5 w |
| Move an account between budgets, from the account screen, as one undoable step | 1 w |
| Account create and edit both offer **whose** and **shared or private** (today only edit does, and only for tracking accounts) | 0.5 w |
| Relax H2.2's `CHECK` to permit a private Budget or Credit account **when it sits in a personal budget** (H2.2a) | 0.5 w |
| Envelopes belong to a budget: create, move, and the grid showing only this budget's | 1 w |
| Migration and tests: a household that never opens a personal budget sees no change | 0.5 w |
| | **4.5 weeks** |

**Done when:** two people can put their own current accounts and cards in their
own budgets, keep them private, and see only their own grid — with the household
budget still working exactly as it does today.

---

## P3 · The household envelope, and where shared money comes from

| | Est. |
|---|---|
| The household envelope in each personal budget, and the derived claim in the identity (`15` §3.2) | 1.5 w |
| Identity per budget extended with `due from other budgets`; tests per budget | 1 w |
| A **target** on the household envelope, so *"₹40,000 a month"* is a standing thing rather than a monthly chore | 0.5 w |
| Rollover: a commitment stays and rolls like any envelope (`15` §6.1) | 0.5 w |
| Household screen: what each member committed, and how much is left | 0.5 w |
| | **4 weeks** |

**Done when:** Ravi can commit ₹40,000 a month to the household without moving a
rupee between accounts, and both identities still close.

---

## P4 · Spending across budgets

The single rule from `15` §3A.4, which covers every case at once.

| | Est. |
|---|---|
| Cross-budget filing: an account in one budget, a category in another | 1.5 w |
| Shared cards (R6.h–j) and add-on cards (R6.k–l): the claim, and the payment envelope staying with the account's budget | 1 w |
| Splits across budgets, one line at a time (`15` §4) | 1 w |
| Refuse personal-to-personal filing with no shared instrument (R6.l) | 0.5 w |
| | **4 weeks** |

**Done when:** Priya can buy groceries on the shared card and her own clothes on
it, and each lands in the right budget with the right balance between them.

---

## P5 · Ahead, behind, and calling it even

| | Est. |
|---|---|
| The balance between budgets shown on both sides, in the household's words (R6.n) | 0.5 w |
| *Put it down to me* — relabelling cover-overspend on a household envelope (`15` §4A.2) | 0.5 w |
| *I'll pick it up* and *call it even*, with the funded expense (R6.m, `15` §4A.4) | 1 w |
| Digest item when a member is behind, mutable like every other kind | 0.5 w |
| Month close per budget, independent, reporting each member's commitment | 0.5 w |
| | **3 weeks** |

**Done when:** a month where one of them put in more can be ended three different
ways, and each is described in words a couple would actually use.

---

## P6 · Everything that has been waiting

Small, already-agreed items, deliberately parked behind the feature rather than
done piecemeal in front of it.

| | Est. |
|---|---|
| Demo seed: Priya on a salary, Ravi on irregular consulting income; private and held accounts so the feature is visible | 0.5 w |
| Docs, feature lists, README and website brought level with all of the above | 0.5 w |
| Website: the demo page and the feature tour covering separate budgets | 0.5 w |
| Correct `14`'s superseded 12–20 week estimate | — |
| | **1.5 weeks** |

---

## P7 · The hosted service

`13`, unchanged and still gated on the same thing: ten people who will pay.
Nothing here should start before P2–P5 have been lived with for a few months,
because the shape of the product changes what is being sold.

---

## Totals

| | |
|---|---|
| P2 → P6 | **17 weeks** |
| One engineer | ~4 months |
| Already done | P0, P1, P1a |

`15` estimated 12–17 weeks for the separation alone; this is the same work with
the agreed additions and the waiting items folded in.

---

## Why this order

**The riskiest migration went first**, while nothing depended on it, and the
engine was proven against a single budget before a second one existed to confuse
a regression.

**P2 before P3** because a budget you can see and put an account into is worth
something on its own. P3 before P4 because a claim needs somewhere to live before
anything can create one. P5 last because it is the part where the design could
still be wrong, and finding that out against a working system beats finding it in
a half-built one.

**P6 last on purpose.** Updating the README and the demo before the feature
exists means writing them twice, and a demo that shows an empty personal budget
teaches nobody anything.

---

## What would change this plan

All three of the questions this section opened with now have answers, in `15`
§6A and §6B: a leaving member's commitments are released and anything already
spent becomes a family loan; reports offer every scope rather than picking one;
and a goal is personal or shared from creation and cannot move.
