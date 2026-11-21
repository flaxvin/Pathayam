/**
 * DECA-1 · "Use these figures" from the AIS no longer gives the salary
 * standard deduction on interest and dividends, and the old regime takes
 * 80TTA / 80TTB on the AIS's interest. Synthetic figures only.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Paise } from "../core/money.ts";
import { rupees } from "../core/money.ts";
import type { AisLine } from "../import/ais.ts";
import { setIdentity } from "../import/identity.ts";
import { replaceAis, aisSummary, aisIncomeSplit, seniorInYear, applyAisSuggestion } from "./ais.ts";
import { saveDeclaration, getDeclaration, estimateUnder } from "./tax.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { taxPageModel } from "../web/screen-data.ts";
import { renderTax } from "../web/pages/tax.ts";

type Kind = "salary" | "interest-savings" | "interest-deposit" | "dividend";

function withAis(fy: number, lines: [Kind, number][], opts: { gross?: number | "offer"; dob?: string } = {}) {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  if (opts.dob) setIdentity(db, { memberId: "m", source: "ui" }, { name: "Ravi", dob: opts.dob });
  const aisLines: AisLine[] = lines.map(([category, amount], i) => ({
    section: "tds", category, code: null, label: category, source: `Payer ${i}`,
    amount: rupees(amount), tds: 0 as Paise,
  }));
  replaceAis(db, "m", fy, { fy, pan: "ABCDE1234F", lines: aisLines, notRead: [] }, { panChecked: false, warnings: [] });
  const s = aisSummary(db, "m", fy)!;
  // "Use these figures", then Save: the form's gross is what gets saved.
  const gross = opts.gross === undefined || opts.gross === "offer"
    ? applyAisSuggestion({ gross: 0 as Paise, tds: 0 as Paise }, s).gross
    : rupees(opts.gross);
  saveDeclaration(db, "m", fy, { ...getDeclaration(db, "m", fy), gross });
  return { db, model: taxPageModel(db, "m", fy, false) };
}

describe("DECA-1 · standard deduction only on the AIS's salary", () => {
  test("regression: ₹12,50,000 of interest alone, FY 2026-27, new regime is ₹52,000, not ₹0", () => {
    const { model } = withAis(2026, [["interest-deposit", 12_50_000]]);
    const e = model.estimate!;
    assert.equal(e.new.standardDeduction, 0);
    assert.equal(e.new.taxable, rupees(12_50_000));
    // ₹67,500 on slabs, relieved to the ₹50,000 over ₹12,00,000, plus 4% cess.
    assert.equal(e.new.total, rupees(52_000));
    assert.equal(e.old.standardDeduction, 0);
    // Deposit interest, age not known: no 80TTA (savings only), no 80TTB.
    assert.equal(e.old.interestDeduction, 0);
    assert.equal(e.old.total, rupees(1_95_000));
  });

  test("salary below the standard deduction caps it at that salary", () => {
    const { model } = withAis(2025, [["salary", 40_000], ["interest-deposit", 5_00_000], ["dividend", 60_000]]);
    assert.equal(model.estimate!.new.standardDeduction, rupees(40_000));
    assert.equal(model.estimate!.old.standardDeduction, rupees(40_000));
    assert.deepEqual(model.aisSplit, { salary: rupees(40_000), other: rupees(5_60_000), senior: null });
  });

  test("a full salary keeps the full standard deduction", () => {
    const { model } = withAis(2025, [["salary", 10_00_000], ["interest-deposit", 50_000]]);
    assert.equal(model.estimate!.new.standardDeduction, rupees(75_000));
    assert.equal(model.estimate!.old.standardDeduction, rupees(50_000));
  });

  test("a gross typed above the AIS's figures is taken as salary the AIS does not know of", () => {
    const { model } = withAis(2025, [["interest-deposit", 3_00_000]], { gross: 3_40_000 });
    assert.equal(model.aisSplit!.salary, rupees(40_000));
    assert.equal(model.estimate!.new.standardDeduction, rupees(40_000));
  });

  test("without an AIS the whole gross is still salary", () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    saveDeclaration(db, "m", 2026, { ...getDeclaration(db, "m", 2026), gross: rupees(12_50_000) });
    const model = taxPageModel(db, "m", 2026, false);
    assert.equal(model.estimate!.new.standardDeduction, rupees(75_000));
    assert.equal(model.aisSplit, null);
  });

  test("the split never overstates the interest inside a gross that holds only part of it", () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    const lines: AisLine[] = [
      { section: "tds", category: "salary", code: null, label: "s", source: "Employer", amount: rupees(5_00_000), tds: 0 as Paise },
      { section: "tds", category: "interest-savings", code: null, label: "i", source: "Bank", amount: rupees(20_000), tds: 0 as Paise },
      { section: "tds", category: "dividend", code: null, label: "d", source: "Co", amount: rupees(30_000), tds: 0 as Paise },
    ];
    replaceAis(db, "m", 2025, { fy: 2025, pan: "ABCDE1234F", lines, notRead: [] }, { panChecked: false, warnings: [] });
    const s = aisSummary(db, "m", 2025)!;
    // Gross holds ₹35,000 over the salary: dividends first, then ₹5,000 of savings interest.
    assert.deepEqual(aisIncomeSplit(rupees(5_35_000), s), {
      salary: rupees(5_00_000), other: rupees(35_000), interestSavings: rupees(5_000), interestDeposits: 0,
    });
    // Gross below the AIS salary: all salary, no interest.
    assert.equal(aisIncomeSplit(rupees(4_00_000), s).other, 0);
  });
});

describe("DECA-1 · 80TTA and 80TTB, old regime only", () => {
  test("no date of birth: 80TTA on savings interest, capped at ₹10,000, and the page says why", () => {
    const { model } = withAis(2025, [["salary", 8_00_000], ["interest-savings", 30_000], ["interest-deposit", 70_000]]);
    assert.equal(model.estimate!.old.interestSection, "80TTA");
    assert.equal(model.estimate!.old.interestDeduction, rupees(10_000));
    assert.equal(model.estimate!.new.interestDeduction, 0);
    const html = renderTax(model).value;
    assert.match(html, /Savings interest, 80TTA/);
    assert.match(html, /No date of birth is saved in\s+Settings/);
    assert.match(html, /The new regime allows neither 80TTA nor 80TTB/);
  });

  test("a senior citizen by the saved date of birth takes 80TTB on all deposit interest, up to ₹50,000", () => {
    const { model } = withAis(2026, [["interest-savings", 20_000], ["interest-deposit", 45_000]], { dob: "15061960" });
    assert.equal(model.aisSplit!.senior, true);
    assert.equal(model.estimate!.old.interestSection, "80TTB");
    assert.equal(model.estimate!.old.interestDeduction, rupees(50_000));
    assert.equal(model.estimate!.new.interestDeduction, 0);
    assert.match(renderTax(model).value, /Deposit interest, 80TTB/);
  });

  test("someone under 60 by the saved date of birth gets 80TTA, and no age caveat", () => {
    const { model } = withAis(2025, [["salary", 8_00_000], ["interest-savings", 6_000]], { dob: "01011980" });
    assert.equal(model.aisSplit!.senior, false);
    assert.equal(model.estimate!.old.interestDeduction, rupees(6_000));
    assert.doesNotMatch(renderTax(model).value, /No date of birth is saved/);
  });

  test("senior in the year: 60 at any time up to 31 March", () => {
    assert.equal(seniorInYear("31031967", 2026), true);
    assert.equal(seniorInYear("01041967", 2026), false);
    assert.equal(seniorInYear(null, 2026), null);
    assert.equal(seniorInYear("bad", 2026), null);
  });

  test("the estimate without AIS figures is unchanged: no interest deduction", () => {
    const base = { s80c: 0 as Paise, s80d: 0 as Paise, s80dSenior: false, other: 0 as Paise, hra: null };
    const e = estimateUnder(2025, "old", rupees(8_00_000), base);
    assert.equal(e.interestDeduction, 0);
    assert.equal(e.interestSection, null);
    assert.equal(e.standardDeduction, rupees(50_000));
  });
});
