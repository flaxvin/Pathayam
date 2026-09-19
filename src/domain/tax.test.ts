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
