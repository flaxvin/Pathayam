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
| ✅ | **P2 · Personal budgets** | A member can open their own budget, move accounts into it, keep them private, and keep their own envelopes. A household that never opens one sees no change — asserted, not assumed. |
| ✅ | **P3 · The household envelope** | Committing money without moving it, the claim in the identity, a standing monthly figure, rollover, and the household screen. Brought P4's cross-budget filing forward with it — see below. |
| ⬜ | **P4 → P7** | Below. |

---

## P2 · Personal budgets, and moving money's home into one — done

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

**Two things found on the way**, neither of them in the estimate:

- Migration 0026 rebuilds `accounts`, and a table rebuild behaves differently on
  a database with rows in it. It passed 851 tests and failed on the first real
  database it met, because `DROP TABLE` on a parent leaves SQLite's deferred
  violation counter high and `PRAGMA foreign_key_check` cannot see it. The
  runner now turns `foreign_keys` off around a migration marked `rebuildsTable`
  and checks for genuine orphans before committing, and B105 runs every rebuild
  against a populated database.
- A domain refusal reached the household as *"Something went wrong on the
  server"*, with a 500 and an entry on the Health page. `core/refusal.ts` gives
  the domain a way to decline on purpose; it arrives as a 422 carrying the
  sentence that was the reason for refusing (B106).

---

## P3 · The household envelope, and where shared money comes from — done

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

**What P2 made urgent.** P2 shipped a control that moves an account between
budgets, and every account worth moving has years of spending filed to household
envelopes — so one click turns a pile of ordinary transactions into cross-budget
ones. That is P4's first line item, and leaving it undone would have left the
books open in a state a household could reach in two clicks. So it came forward,
and finding it took three separate defects:

- **Activity followed the account, not the envelope.** A household bill paid from
  a personal account landed in the payer's budget and left the household's
  envelope untouched. Both identities failed by the amount, in opposite
  directions that cancelled in the combined view where nothing was looking.
- **"Internal to the budget" was assumed rather than checked.** A transfer leg
  was excluded from Ready to Assign whenever the other leg was a Budget or Credit
  account. Once budgets can differ the two cases part company: cash into another
  budget's account is money genuinely gone, while paying another budget's card
  buys a claim (`15` §3.5).
- **A commitment's negative was absorbed at the rollover.** R4 reopens an
  overspent envelope at zero and charges Ready to Assign. Done to a commitment,
  the receiving budget's claim snapped back to zero while the payer's own pool
  took the hit — so the two stopped describing the same obligation. A commitment
  now carries its debt, which is also what `15` §6.1 said it should.

Each is pinned by a test that fails without it, and the identity is asserted for
**every month of a 63-month household**, in both budgets, cached and live.

Two smaller ones surfaced on the way: four creators made envelopes with no
`budget_id` at all — a card's payment envelope, a loan's, Reconciliation and the
blank-start group — and every scoped read compares with `=`, which NULL never
satisfies, so those envelopes and their balances vanished from the grid and from
the identity (B108). And `updateAccount` treated a key present-but-undefined as
"set this to null", so a form offering a field conditionally wrote NULL into
whatever it named (B107).

---

## P4 · Spending across budgets

The single rule from `15` §3A.4, which covers every case at once.

| | Est. |
|---|---|
| ~~Cross-budget filing: an account in one budget, a category in another~~ — **done in P3**, which needed it to keep the books closed | — |
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
