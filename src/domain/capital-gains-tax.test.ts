/**
 * Taxing capital gains at the rates that apply to them.
 *
 * The rules being asserted, because they are the ones that make a gains
 * calculator wrong when it is wrong:
 *
 *   - the rate depends on the asset class, not just the holding period;
 *   - the long-term threshold is 12 months for listed equity and 24 for the
 *     rest, so one flat number misfiles half of them;
 *   - the ₹1.25 lakh exemption is annual and applies only to 112A;
 *   - anything the app cannot place is excluded and reported, never guessed
 *     into a bucket.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees, formatPaise, type Paise } from "../core/money.ts";
import { taxOnGains, GAINS_RULES } from "./capital-gains-tax.ts";

const FY = 2025;

function buckets(over: Partial<Parameters<typeof taxOnGains>[1]> = {}) {
  return {
    equityLong: 0 as Paise, equityShort: 0 as Paise, otherLong: 0 as Paise,
    slabRated: 0 as Paise, unclassified: 0 as Paise, unclassifiedReasons: [],
    ...over,
  };
}

describe("the 112A exemption", () => {
  test("a long-term equity gain inside it is untaxed", () => {
    const t = taxOnGains(FY, buckets({ equityLong: rupees(100_000) }));
    assert.equal(t.equityLongTax, 0);
    assert.equal(t.exemptionUsed, rupees(100_000), "more exemption was consumed than gain existed");
  });

  test("only the excess is taxed, at 12.5%", () => {
    // ₹2,25,000 − ₹1,25,000 = ₹1,00,000 at 12.5% = ₹12,500
    const t = taxOnGains(FY, buckets({ equityLong: rupees(225_000) }));
    assert.equal(t.exemptionUsed, rupees(125_000));
    assert.equal(t.equityLongTax, rupees(12_500));
  });

  test("it does not spill onto short-term equity", () => {
    // 111A has no exemption: ₹1,00,000 at 20% is ₹20,000 even with the
    // long-term allowance entirely unused.
    const t = taxOnGains(FY, buckets({ equityShort: rupees(100_000) }));
    assert.equal(t.exemptionUsed, 0);
    assert.equal(t.equityShortTax, rupees(20_000));
  });

  test("nor onto other long-term assets", () => {
    // s112 gold or property: 12.5% from the first rupee.
    const t = taxOnGains(FY, buckets({ otherLong: rupees(100_000) }));
    assert.equal(t.exemptionUsed, 0);
    assert.equal(t.otherLongTax, rupees(12_500));
  });
});

describe("the rates themselves", () => {
  test("short-term equity is 20%, long-term 12.5%", () => {
    assert.equal(GAINS_RULES[FY]!.equityShortBp, 2000);
    assert.equal(GAINS_RULES[FY]!.equityLongBp, 1250);
    assert.equal(GAINS_RULES[FY]!.otherLongBp, 1250);
  });

  test("the exemption is ₹1,25,000", () => {
    assert.equal(GAINS_RULES[FY]!.equityLongExemption, rupees(125_000));
  });

  test("special-rate tax is the three added together", () => {
    const t = taxOnGains(FY, buckets({
      equityLong: rupees(325_000), equityShort: rupees(50_000), otherLong: rupees(200_000),
    }));
    assert.equal(
      t.specialRateTax,
      t.equityLongTax + t.equityShortTax + t.otherLongTax,
      `${formatPaise(t.specialRateTax)} is not the sum of its parts`,
    );
    // 12.5% of 2,00,000 + 20% of 50,000 + 12.5% of 2,00,000 = 25,000 + 10,000 + 25,000
    assert.equal(t.specialRateTax, rupees(60_000));
  });
});

describe("slab-rated gains rejoin ordinary income", () => {
  test("they are reported for adding, not taxed here", () => {
    const t = taxOnGains(FY, buckets({ slabRated: rupees(80_000) }));
    assert.equal(t.specialRateTax, 0, "a slab-rated gain was taxed at a special rate");
    assert.equal(t.addToSlabIncome, rupees(80_000));
  });
});

describe("losses", () => {
  test("a loss in one bucket does not reduce another", () => {
    /*
     * Set-off between heads has its own rules — a long-term loss can only go
     * against a long-term gain — and applying them loosely understates the
     * tax. Buckets are floored rather than netted.
     */
    const t = taxOnGains(FY, buckets({
      equityLong: -rupees(500_000) as Paise, equityShort: rupees(100_000),
    }));
    assert.equal(t.equityShortTax, rupees(20_000), "a long-term loss wiped out short-term tax");
  });

  test("a loss alone produces no tax and no negative", () => {
    const t = taxOnGains(FY, buckets({ equityLong: -rupees(50_000) as Paise }));
    assert.equal(t.equityLongTax, 0);
    assert.equal(t.specialRateTax, 0);
  });
});

describe("what it will not place", () => {
  test("unclassified gains are carried through untaxed, with their reasons", () => {
    const t = taxOnGains(FY, buckets({
      unclassified: rupees(90_000),
      unclassifiedReasons: [{ instrument: "Some Fund", gain: rupees(90_000), reason: "no asset class" }],
    }));
    assert.equal(t.specialRateTax, 0, "an unplaceable gain was taxed anyway");
    assert.equal(t.addToSlabIncome, 0, "an unplaceable gain was quietly added to income");
    assert.equal(t.buckets.unclassifiedReasons.length, 1, "the reason was dropped");
  });
});
