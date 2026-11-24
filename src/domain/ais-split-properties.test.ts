/**
 * Property checks on DECA-1's AIS split (aisIncomeSplit) and what the estimate
 * does with it, FY 2025-26 and 2026-27, both regimes, random AIS figures.
 *
 *   - The split adds up: salary + other is the gross; the 80TTA/80TTB bases
 *     never exceed what the AIS reports, nor the non-salary part of gross.
 *   - The standard deduction is never more than the salary part.
 *   - With the AIS fixed, a higher gross never lowers the tax (each extra
 *     rupee is salary or interest, and neither deduction grows faster than it).
 *   - New regime: the split can only raise the tax over the old whole-gross
 *     reading (it only ever takes a deduction away).
 *   - Old regime: the interest deduction is at most ₹10,000 (80TTA) or
 *     ₹50,000 (80TTB, senior known), and 80TTA is on savings interest alone.
 *   - seniorInYear: 60 by 31 March of the year's last day; 1 April is not.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rupees, type Paise } from "../core/money.ts";
import { estimateUnder, type Deductions } from "./tax.ts";
import { aisIncomeSplit, seniorInYear, type AisSummary } from "./ais.ts";

const NONE: Deductions = { s80c: 0 as Paise, s80d: 0 as Paise, s80dSenior: false, other: 0 as Paise, hra: null };
const YEARS = [2025, 2026];
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 300);

/** Deterministic PRNG (mulberry32), so a failure names a seed that repeats. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ais(r: () => number): AisSummary {
  // Zero often, small often, sometimes large: the edges are where it breaks.
  const pick = (max: number) => {
    const u = r();
    if (u < 0.3) return 0 as Paise;
    if (u < 0.6) return Math.floor(r() * 1_00_000_00) as Paise; // up to ₹1L
    return Math.floor(r() * max) as Paise;
  };
  const salary = pick(40_00_000_00);
  const interestSavings = pick(2_00_000_00);
  const interestDeposit = pick(15_00_000_00);
  const interestOther = pick(1_00_000_00);
  const dividends = pick(5_00_000_00);
  return {
    fy: 2025, importedAt: "", panChecked: true, notRead: [], tdsBySource: [], tdsTotal: 0 as Paise,
    salary, interestSavings, interestDeposit, interestOther, dividends,
    securitiesSold: 0 as Paise, appSaleProceeds: 0 as Paise, unread: [],
    incomeOffer: (salary + interestSavings + interestDeposit + interestOther + dividends) as Paise,
  };
}

function withSplit(gross: Paise, s: AisSummary, senior: boolean | null): Deductions {
  const split = aisIncomeSplit(gross, s);
  return {
    ...NONE, salary: split.salary, interestSavings: split.interestSavings,
    interestDeposits: split.interestDeposits, senior,
  };
}

test("the AIS split adds up and never overstates an interest base", () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const s = ais(r);
    for (const gross of [0, s.salary, s.incomeOffer, Math.floor(r() * s.incomeOffer * 1.5), s.incomeOffer + rupees(1)]) {
      const split = aisIncomeSplit(gross as Paise, s);
      const at = `seed ${seed}, gross ${gross}`;
      assert.equal(split.salary + split.other, Math.max(0, gross), at);
      assert.ok(split.salary >= 0 && split.other >= 0, at);
      assert.ok(split.interestSavings <= s.interestSavings, at);
      assert.ok(split.interestDeposits <= s.interestDeposit, at);
      assert.ok(split.interestSavings + split.interestDeposits <= split.other, at);
      // The AIS's salary is salary whenever gross reaches it.
      assert.ok(split.salary >= Math.min(gross, s.salary), at);
    }
  }
});

test("with the AIS fixed, a higher gross never lowers the tax; deductions stay inside their caps", () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed);
    const s = ais(r);
    const fy = YEARS[seed % 2]!;
    const senior = ([true, false, null] as const)[seed % 3]!;
    const top = Math.max(rupees(1_00_000), Math.floor(s.incomeOffer * 1.3));
    for (const regime of ["old", "new"] as const) {
      let prev = -1;
      for (let i = 0; i <= 60; i++) {
        const gross = Math.floor((top * i) / 60) as Paise;
        const d = withSplit(gross, s, senior);
        const e = estimateUnder(fy, regime, gross, d);
        const at = `seed ${seed} ${fy} ${regime} senior=${senior} gross ${gross}`;
        assert.ok(e.total >= prev, `${at}: ${e.total} < ${prev}`);
        prev = e.total;
        assert.ok(e.standardDeduction <= (d.salary ?? gross), `${at}: standard deduction over salary`);
        if (regime === "new") {
          assert.equal(e.interestDeduction, 0, at);
          const whole = estimateUnder(fy, regime, gross, NONE).total;
          assert.ok(e.total >= whole, `${at}: the split lowered new-regime tax (${e.total} < ${whole})`);
        } else if (senior === true) {
          assert.ok(e.interestDeduction <= rupees(50_000), at);
          assert.ok(e.interestDeduction <= (d.interestSavings ?? 0) + (d.interestDeposits ?? 0), at);
        } else {
          assert.ok(e.interestDeduction <= rupees(10_000), at);
          assert.ok(e.interestDeduction <= (d.interestSavings ?? 0), at);
        }
      }
    }
  }
});

test("seniorInYear: 60 by 31 March of the year's last day", () => {
  // FY 2026-27 ends 31-03-2027: born on or before 31-03-1967.
  assert.equal(seniorInYear("31031967", 2026), true);
  assert.equal(seniorInYear("01041967", 2026), false);
  assert.equal(seniorInYear("29021964", 2025), true); // a leap-day birthday, well inside
  assert.equal(seniorInYear("31-03-1966", 2025), true); // separators are ignored
  assert.equal(seniorInYear("01041966", 2025), false);
  assert.equal(seniorInYear("", 2025), null);
  assert.equal(seniorInYear(null, 2025), null);
  assert.equal(seniorInYear("1966", 2025), null);
});
