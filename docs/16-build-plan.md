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
| ✅ | **P4 · Spending across budgets** | Shared cards, add-on cards, splits per line, and the filing with no arrangement behind it refused. |
| ✅ | **P5 · Ahead, behind, calling it even** | The three endings, in words a couple would use, with the money traced to where it comes from. Independent month closes. |
| ✅ | **P6 · Everything that was waiting** | Demo seed, docs, README, feature list and website. |
| ✅ | **After P6** | A round of using it. See the last section. |
| ⬜ | **P7** | Below. |

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

## P4 · Spending across budgets — done

The single rule from `15` §3A.4, which covers every case at once. Cross-budget
filing itself came forward into P3, where the identity needed it; what remained
was the instruments, the splits, and the refusal.

| | Est. |
|---|---|
| ~~Cross-budget filing: an account in one budget, a category in another~~ — **done in P3**, which needed it to keep the books closed | — |
| Shared cards (R6.h–j) and add-on cards (R6.k–l): the claim, and the payment envelope staying with the account's budget | 1 w |
| Splits across budgets, one line at a time (`15` §4) | 1 w |
| Refuse personal-to-personal filing with no shared instrument (R6.l) | 0.5 w |
| | **4 weeks** |

**Done when:** Priya can buy groceries on the shared card and her own clothes on
it, and each lands in the right budget with the right balance between them.

**How it turned out.** The one rule did cover every case, and the instruments
needed no mechanism of their own — an add-on charge filed to the holder's own
envelope is the same arithmetic as a member paying for the household, read from
the other end. Two things had to be added:

- **The envelope has to exist before the transaction does.** The claim is derived
  from the envelope, so a cross-budget filing with nothing to absorb it is money
  the identity cannot account for — and a read cannot conjure one. So the write
  paths prepare it: creating a transaction, recategorising one, and moving an
  account between budgets, which re-files years of history in a single click.
- **R6.l, as a refusal in words.** Between two personal budgets there must be
  something the household actually shared. In practice that is an add-on card, and
  anything else is declined with a sentence saying what would be needed.

Each case asserts **both** identities across every month, which is the only check
a plausible half-implementation cannot pass.

---

## P5 · Ahead, behind, and calling it even — done

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

**How it works out.** Two of the three endings needed no machinery at all, which
is the best sign the model underneath is right: *put it down to me* is R4's move
out of Ready to Assign wearing the only label that describes what it does, and
*I'll pick it up* is an ordinary commitment. All the vocabulary lives in
`domain/standing.ts`, so there is one place to change a word and a test that
refuses the register `10` §3.5 uses for lending to a cousin — no *debt*, no
*owes*, no *forgive*.

Calling it even is the one with a record behind it, and `15` §4A.4's objection is
the reason: the money has to come from somewhere. It is an expense for the one
giving it and income for the one receiving it, and the expense lands in a real
envelope — so the household's Ready to Assign pays for it, exactly once, and the
card bill still gets paid because the payment envelope was never touched. The
whole trace is asserted step by step, including that funding the envelope
afterwards costs the household precisely the amount it let go.

---

## P6 · Everything that has been waiting — done

Small, already-agreed items, deliberately parked behind the feature rather than
done piecemeal in front of it.

| | Est. |
|---|---|
| Demo seed: Priya on a salary, Ravi on irregular consulting income; private and held accounts so the feature is visible | 0.5 w |
| Docs, feature lists, README and website brought level with all of the above | 0.5 w |
| Website: the demo page and the feature tour covering separate budgets | 0.5 w |
| Correct `14`'s superseded 12–20 week estimate | — |
| | **1.5 weeks** |

**The demo seed is the part that earned its place.** Priya on a salary the 28th of
every month with a March bonus, Ravi on consulting that sometimes does not arrive,
and from the thirtieth month he keeps his own budget: a private account, ₹40,000 a
month committed, the rent paid out of it, and one balance they agreed to let go.

Driving that found a bug no test had: calling it even gives *income* to whichever
side is released, and that is not always the side the envelope sits in. Reading it
off the envelope's budget left the household short by the amount let go, in every
month from then on. `15` §4A.6 is the same case from the other end, and it is
tested now.

A round of using the app found a further set, none of which a test was going to
catch: the household screen contradicting itself across two sections, a row that
did not add up because a level sat between two flows, the account edit form buried
behind a label that had stopped describing it, a personal budget opening with no
envelopes at all, and every screen except the budget grid ignoring the switcher
that had just been put in the chrome.

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

---

## What using it found, after P6

The phases were built against the design and the tests. Then the app was driven,
by somebody who runs a household on it, and turned up a class of problem no test
was going to catch — every one of them defensible on the page and wrong on the
screen.

| | |
|---|---|
| **The household page contradicted itself** | *"₹36,640 ahead"* in one table and *"the household is ₹36,640 behind with Ravi"* two inches below. Both true; together a bug. Every sentence now takes the commitment as its subject, in the budget screen's own words (R6.n.1, E14). |
| **A row that did not add up** | ₹40,000 in and ₹43,320 out does not make ₹36,640 — until the ₹33,320 already there is a column. A level sitting between two flows reads as an error. |
| **Controls that did nothing** | The budget switcher went into the chrome, and only the budget screen honoured it. Overview, Cards, Schedules and the cashflow projection showed the household's figures under somebody's name. |
| **A control that froze** | On pages that ignore `?budget=`, the switcher never moved. It now appears only where it works. |
| **Buried by a stale label** | The account edit form held whose money it is, whether it is private, and a card's cycle — behind a collapsed line saying "Rename or close". |
| **An empty state** | A personal budget opened with no groups: a bare grid and a picker with nothing to pick. |
| **A rule in the wrong layer** | B58 — a goal owns its own envelope — lived in the route handling the form, so the demo seed pointed goals at ordinary envelopes and nothing stopped it. |
| **A field that earned nothing** | `statement_day` was recorded, editable and read by no code. It now tags each charge with the cycle it bills in (R6.v). |
| **Ten pixels** | Inputs are 44px, small buttons 34px, the amount box 48px. Every inline form sat out of line. Fixed, and a script now measures every screen. |
| **Two screens that priced a choice and then ignored it** | The rate-reset screen offered *keep the instalment* against *keep the tenure* and always did the second; the prepayment screen recommended *reduce the tenure*, collected the answer, wrote it into the note and reduced the instalment. Both needed the tenure to move, and nothing moved it. The original tenure is now kept separately so the saving still has a baseline to be measured against (R6.x). |
| **Options priced at the wrong rate** | The rate-change table was worked out from a query parameter no control on the page could set. Typing the new rate into the form left both figures the decision turns on answering a question about the old rate (R6.y). |
| **A field that promised and did nothing** | *"A lump sum this size cannot come out of nowhere — say where, so no envelope is quietly drained."* The answer was read by nothing (R6.z). |

The three at the end of that table are one failure with three faces, and it is
worth naming separately: **a control that is rendered, priced and submitted still
does nothing unless something downstream acts on it.** Every one of them passed
review as a screen, because the screen was right. What was missing was a line in
the domain, and no test asked for it, because no test had been told the choice
was supposed to matter.

**Two defects were found by the demo rather than by a test**: calling it even gives
income to whichever side is *released*, which is not always the side the envelope
sits in — reading it off the envelope left the other budget short in every month
from then on. And migration 0026 passed 851 tests and failed on the first real
database it met, because a table rebuild behaves differently when rows exist.

The pattern is worth naming: **the tests protect the arithmetic, and using it
protects the meaning.** Both kinds of failure were real, and only one kind was
catchable by the suite that existed.
