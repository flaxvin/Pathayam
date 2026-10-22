/**
 * TAX-1..3 · Home loan interest in the estimate, tax already paid, and advance
 * tax measured against what was paid. Each figure is worked by hand.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees, type Paise } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import {
  estimateTax, estimateUnder, settle, advanceTaxSchedule, RULES, ADVANCE_TAX_RULES,
  addTaxPayment, deleteTaxPayment, listTaxPayments, taxPaid, saveDeclaration, getDeclaration,
  type Deductions,
} from "./tax.ts";

const none: Deductions = { s80c: 0 as Paise, s80d: 0 as Paise, s80dSenior: false, other: 0 as Paise, hra: null };

describe("TAX-1 · section 24(b) in the estimate", () => {
  test("old regime: capped at ₹2,00,000, its own line, off taxable income", () => {
    /*
     * ₹15,00,000 gross, ₹2,50,000 of interest on a house lived in.
     * Taxable: 15,00,000 − 50,000 standard − 2,00,000 (the cap) = 12,50,000.
     * Slabs: 12,500 + 1,00,000 + 30% of 2,50,000 = 1,87,500; cess 7,500 → ₹1,95,000.
     * Without it: taxable 14,50,000 → 2,47,500 + 9,900 cess = ₹2,57,400.
     */
    const withIt = estimateUnder(2025, "old", rupees(15_00_000), { ...none, s24b: rupees(2_50_000) });
    assert.equal(withIt.homeLoanInterest, rupees(2_00_000));
    assert.equal(withIt.taxable, rupees(12_50_000));
    assert.equal(withIt.total, rupees(1_95_000));
    assert.equal(estimateUnder(2025, "old", rupees(15_00_000), none).total, rupees(2_57_400));
  });

  test("new regime: none of it, under s115BAC", () => {
    // 15,00,000 − 75,000 = 14,25,000: 20,000 + 40,000 + 33,750 = 93,750, cess 3,750 → ₹97,500.
    const e = estimateUnder(2025, "new", rupees(15_00_000), { ...none, s24b: rupees(2_50_000) });
    assert.equal(e.homeLoanInterest, 0);
    assert.equal(e.total, rupees(97_500));
  });

  test("the cap is keyed by year with the slabs", () => {
    for (const fy of [2025, 2026]) {
      assert.equal(RULES[fy]!.old.s24bSelfOccupiedCap, rupees(2_00_000));
      assert.equal(RULES[fy]!.new.s24bSelfOccupiedCap, null);
    }
  });
});

describe("TAX-2 · tax already paid", () => {
  test("is netted under each regime, a refund reading as one", () => {
    const e = estimateTax(2025, rupees(15_00_000), { ...none, s24b: rupees(2_50_000) });
    const paid = { tds: rupees(1_50_000), advance: rupees(30_000), selfAssessment: 0 as Paise };
    // Old: 1,95,000 − 1,80,000 = ₹15,000 to pay. New: 97,500 − 1,80,000 = ₹82,500 back.
    assert.equal(settle(e.old, paid).balance, rupees(15_000));
    assert.equal(settle(e.new, paid).balance, -rupees(82_500));
  });

  test("payments are the member's own, and advance tax is dated inside its year", () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    seedMember(db, "p", "Priya");
    const mine = addTaxPayment(db, "m", { fy: 2025, kind: "advance", date: "2025-06-14", amount: rupees(15_000) });
    addTaxPayment(db, "m", { fy: 2025, kind: "self-assessment", date: "2026-07-20", amount: rupees(5_000) });
    saveDeclaration(db, "m", 2025, { gross: rupees(15_00_000), ...none, tds: rupees(1_50_000) });

    assert.deepEqual(taxPaid(db, "m", 2025), {
      tds: rupees(1_50_000), advance: rupees(15_000), selfAssessment: rupees(5_000),
    });
    assert.deepEqual(listTaxPayments(db, "p", 2025), []);
    assert.throws(() => deleteTaxPayment(db, "p", mine.id), Refusal);
    assert.equal(listTaxPayments(db, "m", 2025).length, 2);

    assert.throws(
      () => addTaxPayment(db, "m", { fy: 2025, kind: "advance", date: "2026-04-10", amount: rupees(1_000) }),
      /self-assessment/,
    );
    assert.throws(() => addTaxPayment(db, "m", { fy: 2025, kind: "advance", date: "2025-06-14", amount: 0 as Paise }), Refusal);
    deleteTaxPayment(db, "m", mine.id);
    assert.equal(taxPaid(db, "m", 2025).advance, 0);
  });

  test("a blank 24(b) override is stored as none, and ₹0 as ₹0", () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    saveDeclaration(db, "m", 2025, { gross: rupees(10_00_000), ...none, s24bOverride: null });
    assert.equal(getDeclaration(db, "m", 2025).s24bOverride, null);
    saveDeclaration(db, "m", 2025, { gross: rupees(10_00_000), ...none, s24bOverride: 0 as Paise });
    assert.equal(getDeclaration(db, "m", 2025).s24bOverride, 0);
  });
});

describe("TAX-3 · advance tax after TDS, against what was paid", () => {
  test("the threshold is ₹10,000, keyed by year", () => {
    assert.equal(ADVANCE_TAX_RULES[2026]!.threshold, rupees(10_000));
    assert.deepEqual(advanceTaxSchedule(2025, (rupees(10_000) - 1) as Paise), []);
    assert.equal(advanceTaxSchedule(2025, rupees(10_000)).length, 4);
  });

  test("each instalment shows what was paid by its date", () => {
    /*
     * ₹2,57,400 of tax less ₹1,50,000 TDS leaves ₹1,07,400.
     * Due by: 15 June 16,110 · 15 Sep 48,330 · 15 Dec 80,550 · 15 Mar 1,07,400.
     * Paid ₹15,000 on 14 June and ₹40,000 on 20 September.
     */
    const s = advanceTaxSchedule(2025, rupees(1_07_400), [
      { date: "2025-06-14", amount: rupees(15_000) },
      { date: "2025-09-20", amount: rupees(40_000) },
    ]);
    assert.deepEqual(s.map((i) => i.cumulativeAmount), [rupees(16_110), rupees(48_330), rupees(80_550), rupees(1_07_400)]);
    assert.deepEqual(s.map((i) => i.paidByThen), [rupees(15_000), rupees(15_000), rupees(55_000), rupees(55_000)]);
    assert.deepEqual(s.map((i) => i.shortBy), [rupees(1_110), rupees(33_330), rupees(25_550), rupees(52_400)]);
  });
});
