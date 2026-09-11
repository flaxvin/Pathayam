/**
 * The engine's acceptance suite.
 *
 * `05` §7 names the worst risk in the project: "engine semantics get subtly
 * wrong and are discovered in month four", costing a rewrite of every stored
 * monthly figure. Its mitigation is to write the rules as executable test
 * cases with the worked ₹ examples from `02` §4 *before* writing UI. This is
 * that suite.
 *
 * Every scenario also asserts the identity from
 * `docs/dev/01-engine-derivation.md` §1, so an arithmetic slip anywhere shows
 * up immediately rather than as a wrong balance months later.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees, formatPaise } from "../core/money.ts";
import {
  computeBudget,
  identityResidual,
  cardFunding,
  targetProgress,
  totalUnderfunded,
  suggestCoverSources,
  computeBuffer,
  isFullyFunded,
  futureMonthCaveat,
} from "./engine.ts";
import { Scenario } from "./scenario.ts";
import type { BudgetState, CategoryState, MonthState } from "./types.ts";

const AUG = "2026-08";
const SEP = "2026-09";
const OCT = "2026-10";

/** Assert the identity holds in every computed month. */
function assertIdentity(state: BudgetState) {
  for (const [month, s] of state) {
    assert.equal(
      identityResidual(s),
      0,
      `identity broken in ${month}: budget accounts ${formatPaise(s.budgetAccountBalance)} ` +
        `vs categories + RTA (${formatPaise(s.readyToAssign)})`,
    );
  }
}

function cat(s: MonthState, id: string): CategoryState {
  const c = s.categories.get(id);
  assert.ok(c, `category ${id} missing`);
  return c;
}

// ---------------------------------------------------------------------------

describe("R1 · You may only assign money you hold", () => {
  test("assigning beyond the balance is allowed but drives RTA negative (P2)", () => {
    const state = computeBudget(
      new Scenario()
        .category("groceries")
        .income(AUG, 80_000)
        .assign(AUG, "groceries", 95_000)
        .build(),
    );

    const aug = state.get(AUG)!;
    // Never blocked — the app has no authority to prevent this (P2).
    assert.equal(cat(aug, "groceries").balance, rupees(95_000));
    assert.equal(aug.readyToAssign, rupees(-15_000));
    assert.equal(aug.rtaState, "negative");
    assertIdentity(state);
  });

  test("all months draw on one pool, so a future assignment reduces RTA now", () => {
    const state = computeBudget(
      new Scenario()
        .category("groceries")
        .income(AUG, 80_000)
        .assign(AUG, "groceries", 50_000)
        .assign(SEP, "groceries", 40_000)
        .build(),
    );

    assert.equal(state.get(AUG)!.readyToAssign, rupees(-10_000));
    assertIdentity(state);
  });
});

describe("R2 · Ready to Assign", () => {
  test("reproduces the worked example — ₹17,500", () => {
    // Budget accounts hold ₹1,20,000, ₹10,000 held for next month, last month
    // over-spent cash by ₹2,500, ₹85,000 assigned this month, ₹5,000 assigned
    // to next month.
    // The example states its own outputs but not the July that produced them.
    // Reconstructed here so every figure is consistent: Groceries is overspent
    // by ₹2,500, and Travel ends July holding ₹2,500 that carries forward.
    const state = computeBudget(
      new Scenario()
        .category("groceries")
        .category("travel")
        .category("rent")
        .income("2026-07", 142_500)
        .assign("2026-07", "groceries", 20_000)
        .assign("2026-07", "travel", 2_500)
        .spendCash("2026-07", "groceries", 22_500)
        // August: nothing spent yet.
        .assign(AUG, "rent", 85_000)
        .assign(SEP, "rent", 5_000)
        .hold(AUG, 10_000)
        .build(),
    );

    const aug = state.get(AUG)!;
    assert.equal(aug.budgetAccountBalance, rupees(120_000), "budget accounts hold ₹1,20,000");
    assert.equal(aug.cashOverspendCarriedIn, rupees(2_500), "July's overspend arrives here");
    assert.equal(aug.readyToAssign, rupees(17_500));
    assertIdentity(state);
  });

  test("itemises the breakdown, which is what the RTA popover shows", () => {
    const state = computeBudget(
      new Scenario()
        .category("groceries")
        .income(AUG, 100_000)
        .assign(AUG, "groceries", 60_000)
        .assign(SEP, "groceries", 10_000)
        .hold(AUG, 5_000)
        .build(),
    );

    const b = state.get(AUG)!.rtaBreakdown;
    assert.equal(b.incomeToDate, rupees(100_000));
    assert.equal(b.assignedThisMonthAndEarlier, rupees(60_000));
    assert.equal(b.assignedInFutureMonths, rupees(10_000));
    assert.equal(b.heldForNextMonth, rupees(5_000));
    assert.equal(b.total, rupees(25_000));
  });

  test("reports the three display states", () => {
    const build = (assigned: number) =>
      computeBudget(
        new Scenario().category("c").income(AUG, 100_000).assign(AUG, "c", assigned).build(),
      ).get(AUG)!;

    assert.equal(build(60_000).rtaState, "positive");
    assert.equal(build(100_000).rtaState, "zero");
    assert.equal(build(120_000).rtaState, "negative");
  });

  test("an uncategorised spend reduces RTA, because no envelope recorded it", () => {
    const state = computeBudget(
      new Scenario().category("c").income(AUG, 50_000).spendUncategorised(AUG, 4_000).build(),
    );
    assert.equal(state.get(AUG)!.readyToAssign, rupees(46_000));
    assertIdentity(state);
  });
});

describe("R3 · Positive balances roll forward", () => {
  test("a category opens the next month with what it held", () => {
    const state = computeBudget(
      new Scenario()
        .category("travel")
        .income(AUG, 50_000)
        .assign(AUG, "travel", 8_000)
        .spendCash(AUG, "travel", 3_000)
        .month(SEP)
        .build(),
    );

    assert.equal(cat(state.get(AUG)!, "travel").balance, rupees(5_000));
    assert.equal(cat(state.get(SEP)!, "travel").opening, rupees(5_000));
    assert.equal(cat(state.get(SEP)!, "travel").balance, rupees(5_000));
    assertIdentity(state);
  });

  test("no expiry and no sweep — the balance survives an untouched month", () => {
    const state = computeBudget(
      new Scenario()
        .category("festivals")
        .income(AUG, 20_000)
        .assign(AUG, "festivals", 6_000)
        .month(SEP)
        .month(OCT)
        .build(),
    );
    assert.equal(cat(state.get(OCT)!, "festivals").balance, rupees(6_000));
    assertIdentity(state);
  });
});

describe("R4 · Cash overspending", () => {
  test("reproduces the worked example — Groceries −₹1,400", () => {
    // Groceries assigned ₹12,000, spent ₹13,400.
    const state = computeBudget(
      new Scenario()
        .category("groceries")
        .income(AUG, 50_000)
        .assign(AUG, "groceries", 12_000)
        .spendCash(AUG, "groceries", 13_400)
        .month(SEP)
        .build(),
    );

    const aug = cat(state.get(AUG)!, "groceries");
    assert.equal(aug.balance, rupees(-1_400), "shows −₹1,400 for the rest of the month");
    assert.equal(aug.cashOverspend, rupees(1_400));
    assert.equal(aug.creditOverspend, 0);

    const sep = state.get(SEP)!;
    assert.equal(cat(sep, "groceries").opening, 0, "Groceries opens at ₹0");
    assert.equal(sep.cashOverspendCarriedIn, rupees(1_400), "next month's RTA is reduced by ₹1,400");
    // ₹50,000 in, ₹12,000 assigned, ₹1,400 carried away.
    assert.equal(sep.readyToAssign, rupees(36_600));
    assertIdentity(state);
  });

  test("the YNAB-style model carries the negative on the category instead (Q1)", () => {
    const state = computeBudget(
      new Scenario()
        .overspendModel("carry-negative")
        .category("groceries")
        .income(AUG, 50_000)
        .assign(AUG, "groceries", 12_000)
        .spendCash(AUG, "groceries", 13_400)
        .month(SEP)
        .build(),
    );

    const sep = state.get(SEP)!;
    assert.equal(cat(sep, "groceries").opening, rupees(-1_400), "Groceries opens at −₹1,400");
    assert.equal(sep.cashOverspendCarriedIn, 0, "RTA is untouched under this model");
    assert.equal(sep.readyToAssign, rupees(38_000));
    assertIdentity(state);
  });

  test("both models leave the household equally well off — only the location differs", () => {
    const scenario = () =>
      new Scenario()
        .category("groceries")
        .income(AUG, 50_000)
        .assign(AUG, "groceries", 12_000)
        .spendCash(AUG, "groceries", 13_400)
        .month(SEP);

    const actual = computeBudget(scenario().build()).get(SEP)!;
    const ynab = computeBudget(scenario().overspendModel("carry-negative").build()).get(SEP)!;

    const total = (s: MonthState) =>
      s.readyToAssign + [...s.categories.values()].reduce((a, c) => a + c.balance, 0);
    assert.equal(total(actual), total(ynab));
    // This is why shipping both is cheap: the difference is which term absorbs
    // the negative, not how anything is stored.
  });

  test("a second overspend the following month carries again", () => {
    const state = computeBudget(
      new Scenario()
        .category("groceries")
        .income(AUG, 50_000)
        .assign(AUG, "groceries", 10_000)
        .spendCash(AUG, "groceries", 11_000)
        .assign(SEP, "groceries", 10_000)
        .spendCash(SEP, "groceries", 10_500)
        .month(OCT)
        .build(),
    );

    assert.equal(state.get(SEP)!.cashOverspendCarriedIn, rupees(1_000));
    assert.equal(state.get(OCT)!.cashOverspendCarriedIn, rupees(500));
    assertIdentity(state);
  });
});

describe("R5 · Covering overspending", () => {
  test("a move leaves RTA unchanged (J4)", () => {
    const base = new Scenario()
      .category("eating-out")
      .category("entertainment")
      .income(AUG, 50_000)
      .assign(AUG, "eating-out", 5_000)
      .assign(AUG, "entertainment", 6_000)
      .spendCash(AUG, "eating-out", 6_850);

    const before = computeBudget(base.build()).get(AUG)!;
    assert.equal(cat(before, "eating-out").balance, rupees(-1_850));

    const after = computeBudget(
      base.move(AUG, "entertainment", "eating-out", 1_850).build(),
    ).get(AUG)!;

    assert.equal(cat(after, "eating-out").balance, 0, "the red category returns to zero");
    assert.equal(cat(after, "entertainment").balance, rupees(4_150), "Entertainment reduces");
    assert.equal(after.readyToAssign, before.readyToAssign, "RTA unchanged");
  });

  test("ranks suggested sources by balance, met target and history", () => {
    const state = computeBudget(
      new Scenario()
        .category("eating-out")
        .category("entertainment")
        .category("groceries")
        .category("shopping")
        .income(AUG, 50_000)
        .assign(AUG, "entertainment", 3_200)
        .assign(AUG, "groceries", 2_400)
        .assign(AUG, "shopping", 1_900)
        .assign(AUG, "eating-out", 1_000)
        .spendCash(AUG, "eating-out", 2_850)
        .build(),
    ).get(AUG)!;

    const sources = suggestCoverSources("eating-out", state.categories, {
      categoryNames: new Map([
        ["entertainment", "Entertainment"],
        ["groceries", "Groceries"],
        ["shopping", "Shopping"],
      ]),
    });

    // J4's ranking: Entertainment ₹3,200 · Groceries ₹2,400 · Shopping ₹1,900
    assert.deepEqual(
      sources.map((s) => s.categoryId),
      ["entertainment", "groceries", "shopping"],
    );
    assert.equal(sources[0]!.available, rupees(3_200));
    // The overspent category never suggests itself, and empty ones are omitted.
    assert.ok(!sources.some((s) => s.categoryId === "eating-out"));
  });
});

describe("R6 · Credit cards", () => {
  test("reproduces the worked example — a ₹1,800 card purchase", () => {
    // Groceries holds ₹12,000. Spend ₹1,800 on the card at a supermarket.
    const state = computeBudget(
      new Scenario()
        .category("groceries")
        .paymentCategory("pay-hdfc", "acct-hdfc-card")
        .income(AUG, 50_000)
        .assign(AUG, "groceries", 12_000)
        .spendCard(AUG, "acct-hdfc-card", "groceries", 1_800)
        .build(),
    );

    const aug = state.get(AUG)!;
    assert.equal(cat(aug, "groceries").balance, rupees(10_200), "Groceries → ₹10,200");
    assert.equal(cat(aug, "pay-hdfc").balance, rupees(1_800), "HDFC Payments → +₹1,800");
    // The cash to clear it is reserved and cannot be spent elsewhere.
    assert.equal(aug.readyToAssign, rupees(38_000), "no cash was created or destroyed");
    assertIdentity(state);
  });

  test("paying the card touches no spending category (J5)", () => {
    // Spend ₹2,400 at a restaurant, then settle a ₹18,400 statement.
    const state = computeBudget(
      new Scenario()
        .category("eating-out")
        .paymentCategory("pay-hdfc", "acct-hdfc-card")
        .income(AUG, 60_000)
        .assign(AUG, "eating-out", 5_000)
        .spendCard(AUG, "acct-hdfc-card", "eating-out", 2_400)
        .assign(AUG, "pay-hdfc", 16_000)
        .payCard(AUG, "acct-hdfc-card", 18_400)
        .build(),
    );

    const aug = state.get(AUG)!;
    assert.equal(cat(aug, "eating-out").balance, rupees(2_600), "Eating Out −₹2,400 only");
    // Payment envelope: +2,400 from the purchase, +16,000 assigned, −18,400 paid.
    assert.equal(cat(aug, "pay-hdfc").balance, 0);
    assert.equal(aug.budgetAccountBalance, rupees(41_600), "savings −₹18,400");
    assertIdentity(state);
  });

  test("credit overspending does not create cash and does not reduce RTA", () => {
    const state = computeBudget(
      new Scenario()
        .category("shopping")
        .paymentCategory("pay-hdfc", "acct-hdfc-card")
        .income(AUG, 50_000)
        .assign(AUG, "shopping", 1_000)
        .spendCard(AUG, "acct-hdfc-card", "shopping", 4_200)
        .month(SEP)
        .build(),
    );

    const aug = state.get(AUG)!;
    const shopping = cat(aug, "shopping");
    assert.equal(shopping.balance, rupees(-3_200));
    assert.equal(shopping.creditOverspend, rupees(3_200), "attributed to the card, not to cash");
    assert.equal(shopping.cashOverspend, 0);

    const sep = state.get(SEP)!;
    assert.equal(sep.cashOverspendCarriedIn, 0, "RTA must not be reduced (R6)");
    assert.equal(sep.readyToAssign, rupees(49_000));
    assert.equal(cat(sep, "shopping").opening, 0, "the category still reopens at zero");
    // The gap surfaces as unfunded card debt instead.
    assert.equal(sep.unfundedCreditAbsorbed, rupees(3_200));
    assertIdentity(state);
  });

  test("splits a mixed overspend into its cash and credit parts", () => {
    const state = computeBudget(
      new Scenario()
        .category("groceries")
        .paymentCategory("pay-hdfc", "acct-hdfc-card")
        .income(AUG, 50_000)
        .assign(AUG, "groceries", 5_000)
        .spendCash(AUG, "groceries", 4_000)
        .spendCard(AUG, "acct-hdfc-card", "groceries", 3_000)
        .month(SEP)
        .build(),
    );

    const g = cat(state.get(AUG)!, "groceries");
    assert.equal(g.balance, rupees(-2_000));
    // The card outflow this month was ₹3,000, so the whole ₹2,000 shortfall is
    // attributable to it — no cash was overspent.
    assert.equal(g.creditOverspend, rupees(2_000));
    assert.equal(g.cashOverspend, 0);
    assert.equal(state.get(SEP)!.cashOverspendCarriedIn, 0);
    assertIdentity(state);
  });

  test("charges a card fee to the payment envelope as well", () => {
    const state = computeBudget(
      new Scenario()
        .category("fees")
        .paymentCategory("pay-hdfc", "acct-hdfc-card")
        .income(AUG, 50_000)
        .assign(AUG, "fees", 1_000)
        .spendCard(AUG, "acct-hdfc-card", "fees", 500)
        .build(),
    );

    assert.equal(cat(state.get(AUG)!, "fees").balance, rupees(500));
    assert.equal(cat(state.get(AUG)!, "pay-hdfc").balance, rupees(500), "the fee needs funding too");
    assertIdentity(state);
  });

  test("a refund releases money the payment envelope was holding", () => {
    const state = computeBudget(
      new Scenario()
        .category("shopping")
        .paymentCategory("pay-hdfc", "acct-hdfc-card")
        .income(AUG, 50_000)
        .assign(AUG, "shopping", 5_000)
        .spendCard(AUG, "acct-hdfc-card", "shopping", 2_000)
        .spendCard(AUG, "acct-hdfc-card", "shopping", -900) // a refund
        .build(),
    );

    assert.equal(cat(state.get(AUG)!, "shopping").balance, rupees(3_900));
    assert.equal(cat(state.get(AUG)!, "pay-hdfc").balance, rupees(1_100));
    assertIdentity(state);
  });

  test("add-on card spending shares the account's one payment envelope (R6.b)", () => {
    // Priya's add-on 3162 and Ravi's primary 3150 are one Axis account.
    const state = computeBudget(
      new Scenario()
        .category("groceries")
        .category("fuel")
        .paymentCategory("pay-axis", "acct-axis")
        .income(AUG, 50_000)
        .assign(AUG, "groceries", 8_000)
        .assign(AUG, "fuel", 4_000)
        .spendCard(AUG, "acct-axis", "groceries", 2_000) // add-on
        .spendCard(AUG, "acct-axis", "fuel", 1_500) // primary
        .build(),
    );

    // One outstanding, one statement, one payment category (R6.b).
    assert.equal(cat(state.get(AUG)!, "pay-axis").balance, rupees(3_500));
    assertIdentity(state);
  });

  test("reports starting debt as unfunded rather than as a budgeting error", () => {
    const funding = cardFunding("acct-hdfc-card", rupees(-24_000), rupees(20_800));
    assert.equal(funding.unfunded, rupees(3_200));
    // The words S2b uses: "₹3,200 of this balance isn't funded yet".
    assert.equal(formatPaise(funding.unfunded), "₹3,200");
  });

  test("a credit overspend leaves the card's balance partly unfunded", () => {
    // The trap this guards: the payment envelope's balance and the debt move
    // together by construction, so comparing them alone always gives zero and
    // the shortfall R6 wants flagged would be invisible.
    const state = computeBudget(
      new Scenario()
        .category("shopping")
        .paymentCategory("pay-hdfc", "acct-hdfc")
        .income(AUG, 50_000)
        .assign(AUG, "shopping", 1_000)
        .spendCard(AUG, "acct-hdfc", "shopping", 4_200)
        .build(),
    ).get(AUG)!;

    const payEnvelope = cat(state, "pay-hdfc").balance;
    assert.equal(payEnvelope, rupees(4_200), "the envelope looks fully funded…");
    assert.equal(state.unfundedByAccount["acct-hdfc"], rupees(3_200), "…but ₹3,200 of it isn't real");

    const funding = cardFunding(
      "acct-hdfc",
      rupees(-4_200),
      payEnvelope,
      state.unfundedByAccount["acct-hdfc"] ?? 0,
    );
    assert.equal(funding.unfunded, rupees(3_200));
  });

  test("attributes a shortfall across the cards that carry the debt", () => {
    const state = computeBudget(
      new Scenario()
        .category("travel")
        .paymentCategory("pay-hdfc", "acct-hdfc")
        .paymentCategory("pay-axis", "acct-axis")
        .income(AUG, 50_000)
        .assign(AUG, "travel", 2_000)
        .spendCard(AUG, "acct-hdfc", "travel", 6_000)
        .spendCard(AUG, "acct-axis", "travel", 2_000)
        .build(),
    ).get(AUG)!;

    // ₹6,000 short, split 3:1 by what each card was charged.
    assert.equal(state.unfundedByAccount["acct-hdfc"], rupees(4_500));
    assert.equal(state.unfundedByAccount["acct-axis"], rupees(1_500));
    assert.equal(
      (state.unfundedByAccount["acct-hdfc"] ?? 0) + (state.unfundedByAccount["acct-axis"] ?? 0),
      rupees(6_000),
      "the split loses nothing",
    );
  });

  test("keeps the shortfall visible after the category resets at rollover", () => {
    const state = computeBudget(
      new Scenario()
        .category("shopping")
        .paymentCategory("pay-hdfc", "acct-hdfc")
        .income(AUG, 50_000)
        .assign(AUG, "shopping", 1_000)
        .spendCard(AUG, "acct-hdfc", "shopping", 4_200)
        .month(SEP)
        .build(),
    );

    // The category reopens at zero, so the only remaining record of the gap is
    // this figure — which is exactly why it is cumulative. Note that a credit
    // overspend is *not* taken out of Ready to Assign: it is absorbed into
    // `unfundedCreditAbsorbed`, its own term in the identity. The money behind
    // the reservation has still never been assigned.
    assert.equal(cat(state.get(SEP)!, "shopping").balance, 0);
    assert.equal(state.get(SEP)!.unfundedByAccount["acct-hdfc"], rupees(3_200));
  });

  test("B92 · a card is never reported short by more than it owes", () => {
    // The invariant that makes the figure checkable: whatever the reasoning
    // behind a shortfall, a household can disprove one larger than the balance
    // it describes, and a number they can disprove costs more than it buys.
    assert.equal(cardFunding("a", rupees(-5_000), rupees(0), rupees(90_000)).unfunded, rupees(5_000));
    assert.equal(cardFunding("a", rupees(-5_000), rupees(5_000), rupees(90_000)).unfunded, rupees(5_000));
    assert.equal(cardFunding("a", rupees(0), rupees(0), rupees(90_000)).unfunded, 0);
  });

  test("a fully funded card reports no shortfall", () => {
    const state = computeBudget(
      new Scenario()
        .category("groceries")
        .paymentCategory("pay-hdfc", "acct-hdfc")
        .income(AUG, 50_000)
        .assign(AUG, "groceries", 12_000)
        .spendCard(AUG, "acct-hdfc", "groceries", 1_800)
        .build(),
    ).get(AUG)!;

    assert.equal(state.unfundedByAccount["acct-hdfc"], undefined);
    assert.equal(
      cardFunding("acct-hdfc", rupees(-1_800), cat(state, "pay-hdfc").balance, 0).unfunded,
      0,
    );
  });

  test("reports no shortfall once the envelope covers the balance", () => {
    assert.equal(cardFunding("a", rupees(-18_400), rupees(18_400)).unfunded, 0);
    assert.equal(cardFunding("a", rupees(-18_400), rupees(20_000)).unfunded, 0);
    assert.equal(cardFunding("a", 0, 0).unfunded, 0);
  });
});

describe("R11 · Hold income for next month", () => {
  test("removes the amount from this month and returns it to the next", () => {
    const state = computeBudget(
      new Scenario().category("c").income(AUG, 80_000).hold(AUG, 40_000).month(SEP).build(),
    );

    assert.equal(state.get(AUG)!.readyToAssign, rupees(40_000));
    assert.equal(state.get(AUG)!.heldForNextMonth, rupees(40_000));
    // ₹40,000 appears at the top of next month's RTA.
    assert.equal(state.get(SEP)!.readyToAssign, rupees(80_000));
    assertIdentity(state);
  });

  test("is reversible at any time", () => {
    const state = computeBudget(
      new Scenario().category("c").income(AUG, 80_000).hold(AUG, 40_000).hold(AUG, -40_000).build(),
    );
    assert.equal(state.get(AUG)!.readyToAssign, rupees(80_000));
  });
});

describe("R8 · Targets", () => {
  const stateFor = (opening: number, assigned: number): CategoryState => ({
    categoryId: "c",
    opening: rupees(opening),
    assigned: rupees(assigned),
    activity: 0,
    balance: rupees(opening + assigned),
    cashOverspend: 0,
    creditOverspend: 0,
    carry: rupees(opening + assigned),
  });

  test("monthly amount — underfunded is the shortfall against this month", () => {
    const p = targetProgress(
      { categoryId: "c", type: "monthly", amount: rupees(12_000), targetDate: null, period: null },
      stateFor(0, 8_000),
      AUG,
      "2026-08-15",
    );
    assert.equal(p.needed, rupees(12_000));
    assert.equal(p.underfunded, rupees(4_000));
    assert.equal(p.state, "partial");
  });

  test("refill to balance — counts what the category already carries", () => {
    const p = targetProgress(
      { categoryId: "c", type: "refill", amount: rupees(10_000), targetDate: null, period: null },
      stateFor(6_000, 0),
      AUG,
      "2026-08-15",
    );
    assert.equal(p.needed, rupees(4_000));
    assert.equal(p.state, "unfunded");
  });

  test("refill holding overages — never claws back a surplus from a refund", () => {
    const p = targetProgress(
      { categoryId: "c", type: "refill-hold", amount: rupees(10_000), targetDate: null, period: null },
      stateFor(13_000, 0),
      AUG,
      "2026-08-15",
    );
    assert.equal(p.needed, 0, "the ₹3,000 surplus is left alone");
    assert.equal(p.underfunded, 0);
  });

  test("savings by date — divides the remainder across the months left", () => {
    const p = targetProgress(
      {
        categoryId: "c",
        type: "by-date",
        amount: rupees(60_000),
        targetDate: "2026-12-31",
        period: null,
      },
      stateFor(10_000, 0),
      AUG,
      "2026-08-15",
    );
    // ₹50,000 remaining over Aug–Dec, five months.
    assert.equal(p.needed, rupees(10_000));
  });

  test("savings by date — asks for the whole remainder in the final month", () => {
    const p = targetProgress(
      {
        categoryId: "c",
        type: "by-date",
        amount: rupees(60_000),
        targetDate: "2026-08-31",
        period: null,
      },
      stateFor(52_000, 0),
      AUG,
      "2026-08-15",
    );
    assert.equal(p.needed, rupees(8_000));
  });

  test("spending target by period — pro-rates the elapsed period", () => {
    const weekly = {
      categoryId: "c",
      type: "spending-period" as const,
      amount: rupees(2_000),
      targetDate: null,
      period: "week" as const,
    };
    // 15th of August is in the third week.
    assert.equal(targetProgress(weekly, stateFor(0, 0), AUG, "2026-08-15").needed, rupees(6_000));
    assert.equal(targetProgress(weekly, stateFor(0, 0), AUG, "2026-08-01").needed, rupees(2_000));
  });

  test("schedule-linked — spreads the next occurrence over the months until due", () => {
    const p = targetProgress(
      {
        categoryId: "c",
        type: "schedule-linked",
        amount: null,
        targetDate: null,
        period: null,
        scheduleAmount: rupees(24_000),
        scheduleDue: "2026-11-10",
      },
      stateFor(0, 0),
      AUG,
      "2026-08-15",
    );
    // ₹24,000 over Aug, Sep, Oct, Nov.
    assert.equal(p.needed, rupees(6_000));
  });

  test("totals the global underfunded line", () => {
    const totals = totalUnderfunded([
      { categoryId: "a", needed: rupees(5_000), underfunded: rupees(5_000), state: "unfunded" },
      { categoryId: "b", needed: rupees(9_200), underfunded: rupees(9_200), state: "unfunded" },
      { categoryId: "c", needed: rupees(1_000), underfunded: 0, state: "funded" },
    ]);
    assert.equal(totals.amount, rupees(14_200));
    assert.equal(totals.categoryCount, 2);
    // "₹14,200 underfunded across 2 categories"
    assert.equal(formatPaise(totals.amount), "₹14,200");
  });

  test("marks an over-funded category distinctly from a funded one", () => {
    const t = { categoryId: "c", type: "monthly" as const, amount: rupees(5_000), targetDate: null, period: null };
    assert.equal(targetProgress(t, stateFor(0, 5_000), AUG, "2026-08-15").state, "funded");
    assert.equal(targetProgress(t, stateFor(0, 7_000), AUG, "2026-08-15").state, "over-funded");
    assert.equal(targetProgress(t, stateFor(0, 0), AUG, "2026-08-15").state, "unfunded");
  });
});

describe("R12 · Buffer and the fully-funded month", () => {
  test("reports whole days with a plain-language reading", () => {
    const state = computeBudget(
      new Scenario()
        .category("groceries")
        .category("rent")
        .income(AUG, 100_000)
        .assign(AUG, "groceries", 20_000)
        .assign(AUG, "rent", 27_000)
        .build(),
    ).get(AUG)!;

    const buffer = computeBuffer(
      state.categories,
      [
        { id: "groceries", name: "Groceries", groupId: "g", hidden: false, paymentAccountId: null },
        { id: "rent", name: "Rent", groupId: "g", hidden: false, paymentAccountId: null },
      ],
      rupees(1_000),
    );

    assert.equal(buffer.days, 47);
    assert.equal(buffer.reading, "You have 47 days of typical spending already assigned.");
  });

  test("excludes credit-card payment categories, which are committed to past debt", () => {
    const input = new Scenario()
      .category("groceries")
      .paymentCategory("pay-hdfc", "acct-card")
      .income(AUG, 100_000)
      .assign(AUG, "groceries", 10_000)
      .assign(AUG, "pay-hdfc", 30_000)
      .build();

    const state = computeBudget(input).get(AUG)!;
    const buffer = computeBuffer(state.categories, input.categories, rupees(1_000));
    assert.equal(buffer.days, 10, "the ₹30,000 card reserve does not extend the buffer");
  });

  test("says so plainly when there is not enough history", () => {
    const state = computeBudget(new Scenario().category("c").income(AUG, 10_000).build()).get(AUG)!;
    const buffer = computeBuffer(state.categories, [], 0);
    assert.equal(buffer.days, 0);
    assert.match(buffer.reading, /Not enough spending history/);
  });

  test("a fully-funded month needs every target met and RTA at zero", () => {
    const met = [{ categoryId: "a", needed: rupees(100), underfunded: 0, state: "funded" as const }];
    const short = [{ categoryId: "a", needed: rupees(100), underfunded: rupees(40), state: "partial" as const }];
    assert.equal(isFullyFunded(met, 0), true);
    assert.equal(isFullyFunded(met, rupees(500)), false, "money left to assign is not fully funded");
    assert.equal(isFullyFunded(short, 0), false);
  });
});

describe("R10 · Future months", () => {
  test("labels a future month as based on money held today", () => {
    assert.equal(futureMonthCaveat(SEP, AUG), "based on money you have today");
    assert.equal(futureMonthCaveat(AUG, AUG), null);
    assert.equal(futureMonthCaveat("2026-07", AUG), null);
  });

  test("shows a future month's projected opening balances", () => {
    const state = computeBudget(
      new Scenario()
        .category("travel")
        .income(AUG, 50_000)
        .assign(AUG, "travel", 10_000)
        .assign(SEP, "travel", 5_000)
        .build(),
    );
    assert.equal(cat(state.get(SEP)!, "travel").opening, rupees(10_000));
    assert.equal(cat(state.get(SEP)!, "travel").balance, rupees(15_000));
    assertIdentity(state);
  });
});

describe("R13 · Month rollover", () => {
  test("carries positives, resets overspends and releases held income in one step", () => {
    const state = computeBudget(
      new Scenario()
        .category("travel")
        .category("groceries")
        .category("shopping")
        .paymentCategory("pay-card", "acct-card")
        .income(AUG, 100_000)
        .assign(AUG, "travel", 8_000) // rolls forward
        .assign(AUG, "groceries", 10_000)
        .spendCash(AUG, "groceries", 11_500) // cash overspend
        .assign(AUG, "shopping", 1_000)
        .spendCard(AUG, "acct-card", "shopping", 3_000) // credit overspend
        .hold(AUG, 15_000)
        .month(SEP)
        .build(),
    );

    const sep = state.get(SEP)!;
    assert.equal(cat(sep, "travel").opening, rupees(8_000), "1. positives carry forward");
    assert.equal(cat(sep, "groceries").opening, 0, "2. cash overspend resets to zero");
    assert.equal(sep.cashOverspendCarriedIn, rupees(1_500), "   ...and reduces the new RTA");
    assert.equal(cat(sep, "shopping").opening, 0, "3. credit overspend resets to zero");
    assert.equal(sep.unfundedCreditAbsorbed, rupees(2_000), "   ...and stays flagged as unfunded");
    assert.equal(sep.heldForNextMonth, 0, "4. held income is released into RTA");
    assertIdentity(state);
  });

  test("keeps every prior month viewable in full", () => {
    const state = computeBudget(
      new Scenario()
        .category("groceries")
        .income("2026-06", 40_000)
        .assign("2026-06", "groceries", 9_000)
        .spendCash("2026-06", "groceries", 8_000)
        .month(AUG)
        .build(),
    );

    const june = state.get("2026-06")!;
    assert.equal(cat(june, "groceries").assigned, rupees(9_000));
    assert.equal(cat(june, "groceries").activity, rupees(-8_000));
    assert.ok(state.has("2026-07"), "the untouched month in between still exists");
  });
});

describe("the identity holds across a full household month", () => {
  test("survives income, cards, transfers, overspending and a rollover", () => {
    const state = computeBudget(
      new Scenario()
        .category("rent")
        .category("groceries")
        .category("eating-out")
        .category("fuel")
        .paymentCategory("pay-hdfc", "acct-hdfc")
        .paymentCategory("pay-axis", "acct-axis")
        .income(AUG, 145_000)
        .assign(AUG, "rent", 45_000)
        .assign(AUG, "groceries", 18_000)
        .assign(AUG, "eating-out", 6_000)
        .assign(AUG, "fuel", 5_000)
        .spendCash(AUG, "rent", 45_000)
        .spendCash(AUG, "groceries", 9_400)
        .spendCard(AUG, "acct-hdfc", "groceries", 6_200)
        .spendCard(AUG, "acct-hdfc", "eating-out", 4_800)
        .spendCard(AUG, "acct-axis", "fuel", 6_100) // overspends Fuel on credit
        .spendUncategorised(AUG, 2_000)
        .assign(AUG, "pay-hdfc", 5_000)
        .payCard(AUG, "acct-hdfc", 11_000)
        .hold(AUG, 20_000)
        .income(SEP, 145_000)
        .assign(SEP, "rent", 45_000)
        .spendCash(SEP, "rent", 45_000)
        .month(OCT)
        .build(),
    );

    assertIdentity(state);

    // Spot-check a couple of figures by hand.
    const aug = state.get(AUG)!;
    assert.equal(cat(aug, "eating-out").balance, rupees(1_200));
    assert.equal(cat(aug, "fuel").balance, rupees(-1_100));
    assert.equal(cat(aug, "fuel").creditOverspend, rupees(1_100));
    // pay-hdfc: +6,200 +4,800 from purchases, +5,000 assigned, −11,000 paid.
    assert.equal(cat(aug, "pay-hdfc").balance, rupees(5_000));
    // pay-axis: +6,100 from the fuel purchase, nothing assigned.
    assert.equal(cat(aug, "pay-axis").balance, rupees(6_100));
  });
});
