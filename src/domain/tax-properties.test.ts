/**
 * Property checks on the estimate, FY 2025-26 and 2026-27, both regimes.
 *
 *   - Tax never falls as salary rises. Surcharge marginal relief is not
 *     modelled (an open decision), which makes tax jump at the band edges but
 *     never fall, so the property holds with or without it.
 *   - New regime, 87A: tax before cess is never more than the income over
 *     ₹12,00,000 (marginal relief, TAX-4), and nothing is payable at or below it.
 *   - Adding a 111A or 112A gain never lowers the tax.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rupees, type Paise } from "../core/money.ts";
import { estimateUnder, type Deductions, type GainsContribution } from "./tax.ts";

const NONE: Deductions = { s80c: 0 as Paise, s80d: 0 as Paise, s80dSenior: false, other: 0 as Paise, hra: null };
const YEARS = [2025, 2026];
const STANDARD = { old: 50_000, new: 75_000 } as const;

function gains(s111a: number, s112a: number): GainsContribution {
  return {
    addToSlabIncome: 0 as Paise, specialRateTax: 0 as Paise,
    special: {
      s111a: rupees(s111a), s111aBp: 2000, s112a: rupees(s112a), s112aBp: 1250,
      s112aExemption: rupees(125_000), s112: 0 as Paise, s112Bp: 1250,
    },
  };
}

test("tax never falls as salary rises, ₹0 to ₹6 crore", () => {
  for (const fy of YEARS) {
    for (const regime of ["old", "new"] as const) {
      let prev = -1;
      for (let r = 0; r <= 6_00_00_000; r += r < 30_00_000 ? 1_000 : 25_000) {
        const t = estimateUnder(fy, regime, rupees(r), NONE).total;
        assert.ok(t >= prev, `${fy} ${regime}: ₹${r} pays ${t} < ${prev}`);
        prev = t;
      }
    }
  }
});

test("new regime: nothing up to ₹12,00,000 taxable; above it, tax before cess is at most the excess", () => {
  for (const fy of YEARS) {
    for (let taxable = 11_50_000; taxable <= 13_00_000; taxable += 250) {
      const e = estimateUnder(fy, "new", rupees(taxable + STANDARD.new), NONE);
      assert.equal(e.taxable, rupees(taxable));
      if (taxable <= 12_00_000) {
        assert.equal(e.total, 0, `${fy}: ₹${taxable} should pay nothing`);
      } else {
        const beforeCess = e.total - e.cess;
        // 288B rounds the total to ₹10, so allow ₹5 either side.
        assert.ok(
          beforeCess <= rupees(taxable - 12_00_000) + rupees(5),
          `${fy}: ₹${taxable} pays ${beforeCess} before cess, over the ₹${taxable - 12_00_000} excess`,
        );
      }
    }
  }
});

test("a short- or long-term equity gain never lowers the tax", () => {
  for (const fy of YEARS) {
    for (const regime of ["old", "new"] as const) {
      for (let salary = 0; salary <= 60_00_000; salary += 37_500) {
        const base = estimateUnder(fy, regime, rupees(salary), NONE).total;
        for (const [st, lt] of [[50_000, 0], [0, 2_00_000], [3_00_000, 4_00_000]] as const) {
          const withGain = estimateUnder(fy, regime, rupees(salary), NONE, gains(st, lt)).total;
          assert.ok(withGain >= base, `${fy} ${regime} ₹${salary} + (${st}, ${lt}): ${withGain} < ${base}`);
        }
      }
    }
  }
});
