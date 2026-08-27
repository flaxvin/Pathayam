/**
 * The portfolio engine against the worked figures in `07`.
 *
 * `docs/verify_portfolio.py` pins the same figures from the document's side.
 * These pin them from the code's side — with one deliberate divergence,
 * documented at the top of holdings.ts and marked below.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees, formatPaise } from "../core/money.ts";
import {
  units, price, makeLot, totalUnits, costBasis, averageCost, marketValue,
  unrealisedGain, absoluteReturn, previewSale, xirr, holdingCashFlows,
  mustShowXirr, decomposeGain, applySplit, applyReturnOfCapital, valueOf,
  formatUnits, type Holding,
} from "./holdings.ts";

/** Whole rupees and paise, as `07` quotes them. */
const R2 = (paise: number) => (paise / 100).toFixed(2);

/** `07` §4 — three SIP instalments into one fund. */
function sipHolding(): Holding {
  return {
    lots: [
      makeLot({ id: "l1", tradeDate: "2026-01-05", amount: rupees(25_000), price: price(80.0) }),
      makeLot({ id: "l2", tradeDate: "2026-02-05", amount: rupees(25_000), price: price(82.5) }),
      makeLot({ id: "l3", tradeDate: "2026-03-05", amount: rupees(25_000), price: price(78.0) }),
    ],
  };
}

describe("R24 · units are the unit of record", () => {
  test("a SIP instalment derives its units from that day's NAV", () => {
    const holding = sipHolding();
    assert.equal(formatUnits(holding.lots[0]!.units), "312.500");
    assert.equal(formatUnits(holding.lots[1]!.units), "303.030");
    assert.equal(formatUnits(holding.lots[2]!.units), "320.513");
  });

  test("totals to 936.043 units for ₹75,000 invested", () => {
    const holding = sipHolding();
    assert.equal(formatUnits(totalUnits(holding)), "936.043");
    assert.equal(costBasis(holding), rupees(75_000));
  });

  test("average cost is ₹80.12 a unit", () => {
    assert.equal((averageCost(sipHolding()) / 1_000_000).toFixed(2), "80.12");
  });

  test("R24.4 — entering units derives the amount instead", () => {
    const lot = makeLot({
      id: "x", tradeDate: "2026-01-05", units: units(312.5), price: price(80.0),
    });
    assert.equal(lot.cost, rupees(25_000));
  });

  test("R24.5 — fees are capitalised into the basis by default", () => {
    const withFees = makeLot({
      id: "x", tradeDate: "2026-01-05", units: units(10), price: price(100),
      fees: rupees(20),
    });
    assert.equal(withFees.cost, rupees(1_020));

    const expensed = makeLot({
      id: "y", tradeDate: "2026-01-05", units: units(10), price: price(100),
      fees: rupees(20), capitaliseFees: false,
    });
    assert.equal(expensed.cost, rupees(1_000));
  });

  test("refuses a lot with no price", () => {
    assert.throws(
      () => makeLot({ id: "x", tradeDate: "2026-01-05", units: units(1), price: 0 }),
      RangeError,
    );
  });
});

describe("R26, R27 · valuation and return", () => {
  const holding = sipHolding();
  const nav = price(86.4);

  test("market value at NAV 86.40 — ₹80,874.12 (see E13)", () => {
    // `07` §4 says ₹80,874.13, computed from *unrounded* units. R24.3 is
    // normative and stores three decimals, which is what a registrar allots,
    // and 936.043 × 86.40 is ₹80,874.12. The rule wins over the illustration.
    assert.equal(R2(marketValue(holding, nav)), "80874.12");
    assert.equal(R2(unrealisedGain(holding, nav)), "5874.12");
  });

  test("absolute return is 7.83%", () => {
    assert.equal(absoluteReturn(holding, nav).toFixed(2), "7.83");
  });

  test("XIRR is 14.51%, and the gap from 7.83% is the whole argument", () => {
    const flows = holdingCashFlows(holding, nav, "2026-08-26");
    const rate = xirr(flows)!;
    assert.equal(rate.toFixed(2), "14.51");

    // Absolute return treats March's money as if invested since January.
    assert.ok(rate - absoluteReturn(holding, nav) > 6);
  });

  test("R27.2 — absolute return may not stand alone when they differ by 2pp", () => {
    assert.equal(mustShowXirr(7.83, 14.51), true);
    assert.equal(mustShowXirr(7.83, 8.5), false);
  });

  test("XIRR returns null rather than a wrong number when it cannot be solved", () => {
    assert.equal(xirr([{ date: "2026-01-01", amount: -100 }]), null);
    // All outflows and no inflow has no rate that balances it.
    assert.equal(
      xirr([
        { date: "2026-01-01", amount: -100 },
        { date: "2026-06-01", amount: -100 },
      ]),
      null,
    );
  });

  test("a single-lot holding's XIRR matches simple compounding", () => {
    // ₹1,00,000 → ₹1,10,000 over exactly one year is 10%.
    const rate = xirr([
      { date: "2025-08-26", amount: rupees(-100_000) },
      { date: "2026-08-26", amount: rupees(110_000) },
    ])!;
    assert.ok(Math.abs(rate - 10) < 0.05, `got ${rate}`);
  });
});

describe("R25 · FIFO", () => {
  test("selling 400 units at 86.40 takes the two oldest lots", () => {
    const preview = previewSale(sipHolding(), units(400), price(86.4), {
      saleDate: "2026-08-26",
    });

    assert.equal(preview.consumed.length, 2);
    assert.equal(formatUnits(preview.consumed[0]!.units), "312.500");
    assert.equal(preview.consumed[0]!.tradeDate, "2026-01-05");
    assert.equal(formatUnits(preview.consumed[1]!.units), "87.500");
    assert.equal(preview.consumed[1]!.tradeDate, "2026-02-05");

    assert.equal(R2(preview.proceeds), "34560.00");
    // `07` §4 says ₹32,218.75, from 87.5 × 82.50. But ₹25,000 at NAV 82.50
    // buys 303.030 units, not 303.0303… (R24.3), so those units cost
    // fractionally more than the NAV each. Pro-rata of what was actually paid
    // gives ₹32,218.76 — and keeps the invariant asserted below. Same root
    // cause as E13.
    assert.equal(R2(preview.costOfUnitsSold), "32218.76");
    assert.equal(R2(preview.realisedGain), "2341.24");
    assert.equal(formatUnits(preview.unitsRemaining), "536.043");
  });

  test("R25.4 — a partial sale keeps the residual at its original price and date", () => {
    const preview = previewSale(sipHolding(), units(400), price(86.4));
    const [partial, untouched] = preview.remainingLots;

    assert.equal(partial!.tradeDate, "2026-02-05", "the split lot keeps its date");
    assert.equal(partial!.price, price(82.5), "and its price");
    assert.equal(formatUnits(partial!.units), "215.530");
    assert.equal(untouched!.tradeDate, "2026-03-05");
  });

  test("R25.5 — each consumed lot exposes its holding period", () => {
    const preview = previewSale(sipHolding(), units(400), price(86.4), {
      saleDate: "2026-08-26",
    });
    assert.equal(preview.consumed[0]!.holdingPeriodDays, 233);
    // J18's sentence, stated before the sale is confirmed.
    assert.match(preview.description, /FIFO takes 312\.500 units from 2026-01-05/);
    assert.match(preview.description, /All lots held under 12 months/);
  });

  test("distinguishes long-held lots in the same sentence", () => {
    const preview = previewSale(sipHolding(), units(400), price(86.4), {
      saleDate: "2027-06-01",
    });
    assert.match(preview.description, /All lots held over 12 months/);
  });

  test("charges reduce the proceeds", () => {
    const preview = previewSale(sipHolding(), units(400), price(86.4), {
      charges: rupees(50),
    });
    assert.equal(R2(preview.proceeds), "34510.00");
    assert.equal(R2(preview.realisedGain), "2291.24");
  });

  test("refuses to sell more units than are held", () => {
    assert.throws(
      () => previewSale(sipHolding(), units(2_000), price(86.4)),
      /only 936\.043 are held/,
    );
  });

  test("selling everything leaves nothing behind", () => {
    const preview = previewSale(sipHolding(), units(936.043), price(86.4));
    assert.equal(preview.unitsRemaining, 0);
    assert.deepEqual(preview.remainingLots, []);
  });

  test("selling everything costs exactly the cost basis", () => {
    // The invariant that decides the convention above: a full sale's realised
    // gain must equal the unrealised gain the moment before it, or the two
    // figures contradict each other on screen.
    const holding = sipHolding();
    const preview = previewSale(holding, totalUnits(holding), price(86.4));
    assert.equal(preview.costOfUnitsSold, costBasis(holding));
    assert.equal(preview.realisedGain, unrealisedGain(holding, price(86.4)));
  });

  test("selling in two goes costs the same as selling in one", () => {
    const holding = sipHolding();
    const first = previewSale(holding, units(400), price(86.4));
    const second = previewSale({ lots: first.remainingLots }, units(536.043), price(86.4));
    assert.equal(first.costOfUnitsSold + second.costOfUnitsSold, costBasis(holding));
  });
});

describe("R34 · asset gain versus FX gain", () => {
  // 10 shares bought at USD 150 when USD/INR was 83.00; now USD 180 at 95.51.
  const decomposition = decomposeGain({
    quantity: units(10),
    priceAtPurchase: price(150),
    priceNow: price(180),
    fxAtPurchase: 83.0,
    fxNow: 95.51,
  });

  test("reproduces the worked example exactly", () => {
    assert.equal(R2(decomposition.costInBase), "124500.00");
    assert.equal(R2(decomposition.valueInBase), "171918.00");
    assert.equal(R2(decomposition.assetGain), "24900.00");
    assert.equal(R2(decomposition.fxGain), "22518.00");
    assert.equal(R2(decomposition.totalGain), "47418.00");
    assert.equal(R2(decomposition.gainInForeignCurrency), "300.00");
  });

  test("R34.3 — the residual is exactly zero, not a tolerance", () => {
    assert.equal(decomposition.residual, 0);
  });

  test("R34.1 — says so in words when FX is more than 20% of the gain", () => {
    assert.equal(Math.round(decomposition.fxSharePercent), 47);
    assert.equal(
      decomposition.sentence,
      "47% of your gain came from the rupee weakening, not the investment.",
    );
  });

  test("stays quiet when the exchange rate barely moved", () => {
    const steady = decomposeGain({
      quantity: units(10), priceAtPurchase: price(150), priceNow: price(180),
      fxAtPurchase: 83.0, fxNow: 83.2,
    });
    assert.equal(steady.sentence, null);
    assert.equal(steady.residual, 0);
  });

  test("names a strengthening rupee correctly when it eats the gain", () => {
    const strengthened = decomposeGain({
      quantity: units(10), priceAtPurchase: price(150), priceNow: price(180),
      fxAtPurchase: 95.0, fxNow: 83.0,
    });
    assert.match(strengthened.sentence!, /rupee strengthening/);
    assert.equal(strengthened.residual, 0);
  });

  test("the decomposition sums exactly across a range of inputs", () => {
    // R34.3 makes this a correctness property, not a rounding hope.
    for (const p1 of [120, 150, 180, 233.75]) {
      for (const fx1 of [70.5, 83.0, 95.51, 101.2]) {
        const d = decomposeGain({
          quantity: units(7.5), priceAtPurchase: price(150), priceNow: price(p1),
          fxAtPurchase: 83.0, fxNow: fx1,
        });
        assert.equal(d.residual, 0, `residual for p1=${p1} fx1=${fx1}`);
        assert.equal(d.assetGain + d.fxGain, d.totalGain);
      }
    }
  });
});

describe("R28 · corporate actions", () => {
  test("a split multiplies units and leaves the cost basis untouched", () => {
    const before = sipHolding();
    const after = applySplit(before, 2);

    assert.equal(totalUnits(after), totalUnits(before) * 2);
    assert.equal(costBasis(after), costBasis(before), "nothing was bought and nothing gained");
    assert.equal(after.lots[0]!.price, price(40), "per-unit cost halves");
  });

  test("a split does not change what the holding is worth", () => {
    const before = sipHolding();
    const valueBefore = marketValue(before, price(86.4));
    // Post-split the price halves too.
    const valueAfter = marketValue(applySplit(before, 2), price(43.2));
    assert.ok(Math.abs(valueBefore - valueAfter) <= 1, "within a paisa of rounding");
  });

  test("a return of capital reduces the basis rather than creating a gain", () => {
    const before = sipHolding();
    const after = applyReturnOfCapital(before, rupees(5_000));
    assert.equal(costBasis(after), rupees(70_000));
    assert.equal(totalUnits(after), totalUnits(before), "units are unchanged");
  });

  test("refuses a nonsensical split ratio", () => {
    assert.throws(() => applySplit(sipHolding(), 0), RangeError);
  });
});

describe("precision", () => {
  test("valueOf rounds once, at the end", () => {
    // 936.043 units × 86.40 = 80,874.1152 → 80,874.12
    assert.equal(valueOf(units(936.043), price(86.4)), 8_087_412);
  });

  test("units keep three decimals through a round trip", () => {
    assert.equal(formatUnits(units(320.5128205)), "320.513");
    assert.equal(formatUnits(units(0.001)), "0.001");
  });

  test("an empty holding reports zero rather than NaN", () => {
    const empty: Holding = { lots: [] };
    assert.equal(totalUnits(empty), 0);
    assert.equal(costBasis(empty), 0);
    assert.equal(averageCost(empty), 0);
    assert.equal(absoluteReturn(empty, price(100)), 0);
    assert.equal(formatPaise(marketValue(empty, price(100))), "₹0");
  });
});
