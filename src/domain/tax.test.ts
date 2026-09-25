/**
 * The tax estimate.
 *
 * Every figure here is checked against the arithmetic the Act describes rather
 * than against what the code happens to produce — a tax calculator that is
 * quietly wrong is worse than no calculator, because somebody plans around it.
 *
 * Reverses `02` N15, deliberately. See decisions log Q31.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees, formatPaise, type Paise } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import {
  estimateTax, estimateUnder, taxOnSlabs, hraExemption, advanceTaxSchedule,
  assertKnownYear, RULES, LIMITS, ADVANCE_TAX_THRESHOLD,
} from "./tax.ts";
import { taxOnGains } from "./capital-gains-tax.ts";

const FY = 2025;
const none = { s80c: 0 as Paise, s80d: 0 as Paise, s80dSenior: false, other: 0 as Paise, hra: null };

describe("slab arithmetic", () => {
  test("nothing below the first threshold", () => {
    assert.equal(taxOnSlabs(rupees(250_000), RULES[FY]!.old.slabs), 0);
  });

  test("only the part inside each slab is taxed", () => {
    // Old regime, ₹6,00,000 taxable:
    //   0 on the first 2.5L, 5% on 2.5L, 20% on the 1L above 5L
    //   = 12,500 + 20,000 = 32,500
    assert.equal(taxOnSlabs(rupees(600_000), RULES[FY]!.old.slabs), rupees(32_500));
  });

  test("the top slab has no ceiling", () => {
    // ₹15,00,000: 12,500 + 1,00,000 (20% of 5L) + 1,50,000 (30% of 5L) = 2,62,500
    assert.equal(taxOnSlabs(rupees(1_500_000), RULES[FY]!.old.slabs), rupees(262_500));
  });

  test("the new regime's widened slabs", () => {
    // ₹16,00,000: 0 + 5% of 4L (20,000) + 10% of 4L (40,000) + 15% of 4L (60,000)
    //   = 1,20,000
    assert.equal(taxOnSlabs(rupees(1_600_000), RULES[FY]!.new.slabs), rupees(120_000));
  });
});

describe("the 87A rebate", () => {
  test("a salary under the new regime's ceiling pays nothing", () => {
    // ₹12,00,000 gross, less the ₹75,000 standard deduction = 11,25,000 taxable,
    // which is under the 12L ceiling, so the rebate wipes it out.
    const e = estimateUnder(FY, "new", rupees(1_200_000), none);
    assert.equal(e.total, 0, `expected nil, got ${formatPaise(e.total)}`);
    assert.ok(e.rebate > 0, "the rebate was not applied");
  });

  test("a rupee over the ceiling and the rebate is gone entirely", () => {
    // The cliff is real and is what marginal relief exists to soften — which
    // this app does not model, and says so.
    const under = estimateUnder(FY, "new", rupees(1_275_000), none);
    const over = estimateUnder(FY, "new", rupees(1_276_000), none);
    assert.equal(under.rebate > 0, true);
    assert.equal(over.rebate, 0);
    assert.ok(over.total > under.total, "crossing the ceiling did not raise the tax");
  });

  test("the cap binds, not merely the ceiling", () => {
    const e = estimateUnder(FY, "old", rupees(500_000), none);
    // Taxable 4,50,000 → tax 10,000, under the ₹12,500 cap, so nil.
    assert.equal(e.total, 0);
  });
});

describe("cess and surcharge", () => {
  test("4% cess is added to the tax", () => {
    const e = estimateUnder(FY, "old", rupees(1_050_000), none);
    // Taxable 10,00,000 → 1,12,500 tax, no surcharge, cess 4% = 4,500.
    assert.equal(e.taxBeforeRebate, rupees(112_500));
    assert.equal(e.cess, rupees(4_500));
    assert.equal(e.total, rupees(117_000));
  });

  test("the payable figure is rounded to the nearest ten rupees (288B)", () => {
    // Taxable 18,59,290 under the new regime comes to ₹1,78,732.32 before
    // rounding — a figure nobody will ever pay.
    const e = estimateUnder(FY, "new", rupees(1_934_290), none);
    assert.equal(e.total % rupees(10), 0, `not rounded: ${formatPaise(e.total)}`);
    assert.equal(e.total, rupees(178_730));
  });

  test("rounding happens once, at the end", () => {
    // Rounding the slab tax and again after cess would compound; the
    // intermediate figures stay exact.
    const e = estimateUnder(FY, "old", rupees(1_050_000), none);
    assert.equal(e.cess, rupees(4_500), "cess was rounded before being added");
  });

  test("surcharge starts above fifty lakh of taxable income", () => {
    const below = estimateUnder(FY, "old", rupees(5_040_000), none);
    const above = estimateUnder(FY, "old", rupees(6_000_000), none);
    assert.equal(below.surcharge, 0, "surcharge applied below the band");
    assert.ok(above.surcharge > 0, "no surcharge above fifty lakh");
  });

  test("the new regime has no 37% band", () => {
    const top = RULES[FY]!.new.surcharge.map((b) => b.rateBp);
    assert.ok(!top.includes(3700), "the new regime must cap at 25%");
    assert.ok(RULES[FY]!.old.surcharge.some((b) => b.rateBp === 3700));
  });
});

describe("deductions apply only under the old regime", () => {
  test("80C reduces taxable income under the old regime", () => {
    const without = estimateUnder(FY, "old", rupees(1_200_000), none);
    const with80c = estimateUnder(FY, "old", rupees(1_200_000),
      { ...none, s80c: rupees(150_000) });
    assert.equal(with80c.chapterViA, rupees(150_000));
    assert.ok(with80c.total < without.total, "80C did not reduce the tax");
  });

  test("and does nothing under the new one", () => {
    const without = estimateUnder(FY, "new", rupees(1_200_000), none);
    const with80c = estimateUnder(FY, "new", rupees(1_200_000),
      { ...none, s80c: rupees(150_000) });
    assert.equal(with80c.chapterViA, 0);
    assert.equal(with80c.total, without.total);
  });

  test("80C is capped at one and a half lakh", () => {
    const e = estimateUnder(FY, "old", rupees(2_000_000), { ...none, s80c: rupees(400_000) });
    assert.equal(e.chapterViA, LIMITS.s80c, "the cap was not applied");
  });

  test("each head is capped separately, so 80D cannot absorb unused 80C room", () => {
    // ₹80,000 of health premium with no 80C at all: only ₹25,000 is allowed,
    // not ₹80,000 borrowed against the untouched 80C ceiling.
    const e = estimateUnder(FY, "old", rupees(2_000_000), { ...none, s80d: rupees(80_000) });
    assert.equal(e.chapterViA, LIMITS.s80dStandard);
  });

  test("a senior citizen raises the 80D ceiling", () => {
    const e = estimateUnder(FY, "old", rupees(2_000_000),
      { ...none, s80d: rupees(50_000), s80dSenior: true });
    assert.equal(e.chapterViA, LIMITS.s80dSenior);
  });
});

describe("the HRA exemption is the least of three", () => {
  const basic = rupees(600_000);

  test("rent well above 10% of basic, in a metro", () => {
    // received 2,40,000 · rent−10% = 3,00,000−60,000 = 2,40,000 · 50% = 3,00,000
    // least = 2,40,000
    assert.equal(
      hraExemption({ received: rupees(240_000), rentPaid: rupees(300_000), basic, metro: true }),
      rupees(240_000),
    );
  });

  test("a modest rent binds the exemption", () => {
    // rent−10% = 1,20,000−60,000 = 60,000, which is the least
    assert.equal(
      hraExemption({ received: rupees(240_000), rentPaid: rupees(120_000), basic, metro: true }),
      rupees(60_000),
    );
  });

  test("outside a metro the city share is 40%", () => {
    assert.equal(
      hraExemption({ received: rupees(400_000), rentPaid: rupees(500_000), basic, metro: false }),
      rupees(240_000),
    );
  });

  test("paying no rent exempts nothing, however much HRA was received", () => {
    assert.equal(
      hraExemption({ received: rupees(240_000), rentPaid: 0 as Paise, basic, metro: true }),
      0,
    );
  });

  test("and it is ignored entirely under the new regime", () => {
    const hra = { received: rupees(240_000), rentPaid: rupees(300_000), basic, metro: true };
    const e = estimateUnder(FY, "new", rupees(1_800_000), { ...none, hra });
    assert.equal(e.hraExempt, 0);
  });
});

describe("comparing the two", () => {
  test("a salary with no deductions favours the new regime", () => {
    const e = estimateTax(FY, rupees(1_500_000), none);
    assert.equal(e.better, "new");
    assert.ok(e.saves > 0);
  });

  test("the widened new slabs beat ordinary deductions", () => {
    /*
     * Worth stating as a fact rather than a surprise: since the 2025 slabs, the
     * old regime loses even with 80C, 80D and a substantial HRA claim. The
     * first version of this test assumed the opposite and was wrong.
     *   old: taxable 9,40,000 → ₹1,04,520
     *   new: taxable 14,25,000 → ₹97,500
     */
    const e = estimateTax(FY, rupees(1_500_000), {
      s80c: rupees(150_000), s80d: rupees(25_000), s80dSenior: false,
      other: rupees(50_000),
      hra: { received: rupees(300_000), rentPaid: rupees(360_000), basic: rupees(750_000), metro: true },
    });
    assert.equal(e.better, "new");
  });

  test("a home loan on top of them can still flip it", () => {
    // ₹2,00,000 of interest under section 24(b), entered as "other", is what
    // it takes at this income — which is the comparison the screen exists for.
    const e = estimateTax(FY, rupees(2_000_000), {
      s80c: rupees(150_000), s80d: rupees(25_000), s80dSenior: false,
      other: rupees(200_000),
      hra: { received: rupees(400_000), rentPaid: rupees(480_000), basic: rupees(1_000_000), metro: true },
    });
    assert.equal(e.better, "old", "with a home loan as well the old regime should win");
    assert.ok(e.saves > 0);
  });

  test("saves is the difference between them", () => {
    const e = estimateTax(FY, rupees(1_500_000), none);
    assert.equal(e.saves, Math.abs(e.old.total - e.new.total));
  });
});

describe("capital gains joining the estimate", () => {
  const gains = (special: number, slab = 0) => ({
    addToSlabIncome: rupees(slab), specialRateTax: rupees(special),
  });

  test("the 87A rebate does not wipe out tax on gains", () => {
    /*
     * The mistake this guards: a modest salary that the rebate covers entirely,
     * plus a large equity gain. Fold the two together before the rebate and the
     * app tells somebody they owe nothing when they owe the whole of the gains
     * tax. Section 87A does not relieve 112A.
     */
    const withGains = estimateUnder(FY, "new", rupees(1_200_000), none, gains(50_000));
    const without = estimateUnder(FY, "new", rupees(1_200_000), none);

    assert.equal(without.total, 0, "the fixture no longer has the rebate covering the salary");
    assert.ok(withGains.total > 0, "the rebate swallowed the capital gains tax");
    assert.ok(
      withGains.total >= rupees(50_000),
      `expected at least the gains tax to survive, got ${formatPaise(withGains.total)}`,
    );
  });

  test("cess applies to the gains tax too", () => {
    const e = estimateUnder(FY, "new", rupees(1_200_000), none, gains(50_000));
    // Salary tax nil after rebate; ₹50,000 of gains tax plus 4% cess = ₹52,000.
    assert.equal(e.total, rupees(52_000));
  });

  test("slab-rated gains are taxed as income, not at a special rate", () => {
    const e = estimateUnder(FY, "new", rupees(1_200_000), none, gains(0, 500_000));
    assert.equal(e.gross, rupees(1_700_000), "the slab-rated gain did not join income");
    assert.ok(e.total > 0, "it should now be over the rebate ceiling");
  });

  test("deductions still reduce slab-rated gains under the old regime", () => {
    const without = estimateUnder(FY, "old", rupees(1_200_000), none, gains(0, 300_000));
    const with80c = estimateUnder(FY, "old", rupees(1_200_000),
      { ...none, s80c: rupees(150_000) }, gains(0, 300_000));
    assert.ok(with80c.total < without.total);
  });

  test("with no gains at all, nothing changes", () => {
    const a = estimateUnder(FY, "new", rupees(1_500_000), none);
    const b = estimateUnder(FY, "new", rupees(1_500_000), none, gains(0, 0));
    assert.equal(a.total, b.total);
  });
});

describe("a year it does not know", () => {
  test("is refused rather than guessed", () => {
    assert.throws(() => assertKnownYear(2019), Refusal);
    assert.throws(() => estimateTax(2040, rupees(1_000_000), none), Refusal);
  });

  test("the years it does know are the ones in the table", () => {
    assert.doesNotThrow(() => assertKnownYear(2025));
    assert.doesNotThrow(() => assertKnownYear(2026));
  });
});

describe("advance tax", () => {
  test("nothing is due below ten thousand", () => {
    assert.deepEqual(advanceTaxSchedule(FY, (ADVANCE_TAX_THRESHOLD - 1) as Paise), []);
  });

  test("four instalments, cumulative 15/45/75/100", () => {
    const s = advanceTaxSchedule(FY, rupees(100_000));
    assert.equal(s.length, 4);
    assert.deepEqual(s.map((i) => i.cumulativePct), [15, 45, 75, 100]);
    assert.deepEqual(
      s.map((i) => i.instalmentAmount),
      [rupees(15_000), rupees(30_000), rupees(30_000), rupees(25_000)],
    );
  });

  test("the instalments add up to the liability exactly", () => {
    // Rounding each cumulative figure and differencing must not lose a paisa.
    for (const amount of [rupees(10_000), rupees(33_333), rupees(1_234_567)]) {
      const s = advanceTaxSchedule(FY, amount as Paise);
      const sum = s.reduce((t, i) => t + i.instalmentAmount, 0);
      assert.equal(sum, amount, `instalments for ${formatPaise(amount as Paise)} summed to ${formatPaise(sum as Paise)}`);
    }
  });

  test("the March instalment falls in the next calendar year", () => {
    const s = advanceTaxSchedule(2025, rupees(100_000));
    assert.equal(s[0]!.date, "2025-06-15");
    assert.equal(s[3]!.date, "2026-03-15", "March of FY 2025-26 is March 2026");
  });
});

describe("special-rate gains measured against the rest of the income", () => {
  /*
   * The estimate used to be handed a finished figure of gains tax and add it
   * on. Three things the Act does with 111A, 112A and 112 gains depend on the
   * person's other income, which only the estimate knows, so all three were
   * wrong: the 87A ceiling and the surcharge band were tested on slab income
   * alone, and the unused basic exemption was never set against the gains.
   * Each case below is the arithmetic done by hand; all but the last failed
   * before the fix (the last guards what must not change).
   */
  const g = (over: Partial<Parameters<typeof taxOnGains>[1]>) => taxOnGains(FY, {
    equityLong: 0 as Paise, equityShort: 0 as Paise, otherLong: 0 as Paise,
    slabRated: 0 as Paise, unclassified: 0 as Paise, unclassifiedReasons: [], ...over,
  });

  test("87A: total income over ₹12 lakh takes no rebate, whatever the slab income", () => {
    /*
     * New regime, taxable salary ₹11,00,000 (₹11,75,000 gross) plus a
     * ₹6,25,000 112A gain. Total income ₹17,25,000 > ₹12,00,000: no rebate.
     *   slabs: 4–8L at 5% = 20,000; 8–11L at 10% = 30,000 → 50,000
     *   112A: (6,25,000 − 1,25,000) × 12.5% = 62,500
     *   (50,000 + 62,500) × 1.04 = ₹1,17,000.
     * The old code saw ₹11,00,000 under the ceiling, rebated the ₹50,000 and
     * showed ₹65,000.
     */
    const e = estimateUnder(FY, "new", rupees(1_175_000), none, g({ equityLong: rupees(625_000) }));
    assert.equal(e.totalIncome, rupees(1_725_000));
    assert.equal(e.rebate, 0, "the rebate was given on slab income alone");
    assert.equal(e.total, rupees(117_000));
  });

  test("87A under the old regime: the ₹5 lakh ceiling counts the gains too", () => {
    /*
     * Old regime, taxable ₹4,00,000 (₹4,50,000 gross) plus ₹2,00,000 of 111A.
     * Total income ₹6,00,000 > ₹5,00,000: no rebate.
     *   slabs: 2.5–4L at 5% = 7,500; 111A: 2,00,000 × 20% = 40,000
     *   47,500 × 1.04 = ₹49,400. The old code rebated the 7,500: ₹41,600.
     */
    const e = estimateUnder(FY, "old", rupees(450_000), none, g({ equityShort: rupees(200_000) }));
    assert.equal(e.rebate, 0);
    assert.equal(e.total, rupees(49_400));
  });

  test("surcharge band is chosen on total income", () => {
    /*
     * New regime, taxable salary ₹45,00,000 plus ₹20,00,000 of 111A. Total
     * ₹65,00,000 > ₹50,00,000: 10% band.
     *   slabs: 20,000 + 40,000 + 60,000 + 80,000 + 1,00,000 + 21L × 30%
     *          (6,30,000) = 9,30,000;  111A: 20L × 20% = 4,00,000
     *   13,30,000 + 10% (1,33,000) = 14,63,000; × 1.04 = ₹15,21,520.
     * The old code saw ₹45,00,000, no band: ₹13,83,200.
     */
    const e = estimateUnder(FY, "new", rupees(4_575_000), none, g({ equityShort: rupees(2_000_000) }));
    assert.equal(e.surcharge, rupees(133_000));
    assert.equal(e.total, rupees(1_521_520));
  });

  test("surcharge on special-rate tax stops at 15%", () => {
    /*
     * New regime, taxable ₹2,50,00,000 plus a ₹1,00,00,000 112A gain: the 25%
     * band. Slab tax 3,00,000 + 2,26,00,000 × 30% = 70,80,000; 112A tax
     * 98,75,000 × 12.5% = 12,34,375.
     *   surcharge 70,80,000 × 25% + 12,34,375 × 15% = 17,70,000 + 1,85,156.25
     *   (70,80,000 + 12,34,375 + 19,55,156.25) × 1.04 = 1,06,80,312.50
     *   → ₹1,06,80,310 after 288B. At 25% on both it was ₹1,08,08,690.
     */
    const e = estimateUnder(FY, "new", rupees(25_075_000), none, g({ equityLong: rupees(10_000_000) }));
    assert.equal(e.surcharge, 195_515_625);
    assert.equal(e.total, rupees(10_680_310));
  });

  test("the unused basic exemption is set against a 112A gain (new regime)", () => {
    /*
     * A retiree with no salary and a ₹4,00,000 long-term equity gain. The new
     * regime's nil slab is ₹4,00,000, all of it unused, so the gain is reduced
     * to nil before the ₹1,25,000 exemption is even reached: ₹0 payable.
     * The old code taxed (4,00,000 − 1,25,000) × 12.5% × 1.04 = ₹35,750.
     */
    const e = estimateUnder(FY, "new", 0 as Paise, none, g({ equityLong: rupees(400_000) }));
    assert.equal(e.basicExemptionAgainstGains, rupees(400_000));
    assert.equal(e.total, 0);
  });

  test("old regime: basic exemption shortfall, then 87A, relieve a 111A gain", () => {
    /*
     * Slab income ₹1,00,000 (₹1,50,000 gross) plus ₹3,00,000 of 111A.
     *   shortfall 2,50,000 − 1,00,000 = 1,50,000 → 111A taxed on 1,50,000
     *   1,50,000 × 20% = 30,000; total income 4,00,000 ≤ 5,00,000, so 87A
     *   (which the old regime allows against 111A) takes 12,500 → 17,500
     *   17,500 × 1.04 = ₹18,200. The old code: 3,00,000 × 20% × 1.04 = ₹62,400.
     */
    const e = estimateUnder(FY, "old", rupees(150_000), none, g({ equityShort: rupees(300_000) }));
    assert.equal(e.rebate, rupees(12_500));
    assert.equal(e.total, rupees(18_200));
  });

  test("old regime: 87A never relieves 112A, even under the ceiling", () => {
    /*
     * Slab income ₹1,00,000 plus a ₹4,00,000 112A gain. Shortfall 1,50,000
     * leaves 2,50,000; less the 1,25,000 exemption, 1,25,000 × 12.5% = 15,625.
     * Total income 5,00,000 is within the ceiling but 87A does not reach 112A.
     *   15,625 × 1.04 = ₹16,250. The old code: ₹35,750.
     */
    const e = estimateUnder(FY, "old", rupees(150_000), none, g({ equityLong: rupees(400_000) }));
    assert.equal(e.rebate, 0);
    assert.equal(e.total, rupees(16_250));
  });

  test("new regime: 87A relieves slab tax only, not 111A", () => {
    // Taxable ₹5,00,000 + 111A ₹2,00,000: rebate 5,000 (all slab tax);
    // 111A 40,000 stays. 40,000 × 1.04 = ₹41,600. Unchanged by the fix.
    const e = estimateUnder(FY, "new", rupees(575_000), none, g({ equityShort: rupees(200_000) }));
    assert.equal(e.rebate, rupees(5_000));
    assert.equal(e.total, rupees(41_600));
  });
});
