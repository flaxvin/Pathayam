/**
 * ENG-7 · The employer's NPS contribution, section 80CCD(2), under both regimes.
 *
 * The new regime's allowsDeductions=false dropped everything Chapter VI-A,
 * including the one deduction section 115BAC keeps: the employer's contribution
 * to the employee's NPS account. An NPS employee was shown more new-regime tax
 * than they pay. It is now its own field, allowed under both regimes, outside
 * the 80C ceiling, and capped at a share of basic + DA:
 *
 *   new regime: 14% (Finance Act 2024, from FY 2024-25), any employer
 *   old regime: 10%, or 14% where the employer is a central or state government
 *
 * Hand checks, FY 2025-26, basic + DA ₹10,00,000, employer NPS ₹1,50,000:
 *   new, salary ₹20,75,000: 14% = ₹1,40,000 allowed. Taxable 18,60,000.
 *     Slabs 20,000 + 40,000 + 60,000 + 52,000 = 1,72,000; cess 6,880; 1,78,880.
 *   old, salary ₹20,50,000, private employer: 10% = ₹1,00,000. Taxable 19,00,000.
 *     12,500 + 1,00,000 + 2,70,000 = 3,82,500; cess 15,300; 3,97,800.
 *   old, government employer: ₹1,40,000. Taxable 18,60,000.
 *     12,500 + 1,00,000 + 2,58,000 = 3,70,500; cess 14,820; 3,85,320.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees, type Paise } from "../core/money.ts";
import { estimateUnder, getDeclaration, saveDeclaration, type Deductions, type Declaration } from "./tax.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const FY = 2025;
const hra = { received: 0 as Paise, rentPaid: 0 as Paise, basic: rupees(10_00_000), metro: false };
const nps = (x: Partial<Deductions> = {}): Deductions => ({
  s80c: 0 as Paise, s80d: 0 as Paise, s80dSenior: false, other: 0 as Paise, hra,
  s80ccd2: rupees(1_50_000), ...x,
});

describe("ENG-7 · employer NPS, 80CCD(2)", () => {
  test("the new regime allows it, up to 14% of basic + DA", () => {
    const e = estimateUnder(FY, "new", rupees(20_75_000), nps());
    assert.equal(e.employerNps, rupees(1_40_000));
    assert.equal(e.taxable, rupees(18_60_000));
    assert.equal(e.total, rupees(1_78_880));
  });

  test("the old regime allows 10% for a private employer", () => {
    const e = estimateUnder(FY, "old", rupees(20_50_000), nps());
    assert.equal(e.employerNps, rupees(1_00_000));
    assert.equal(e.total, rupees(3_97_800));
  });

  test("and 14% for a central or state government employer", () => {
    const e = estimateUnder(FY, "old", rupees(20_50_000), nps({ s80ccd2Government: true }));
    assert.equal(e.employerNps, rupees(1_40_000));
    assert.equal(e.total, rupees(3_85_320));
  });

  test("it sits outside the 80C ceiling", () => {
    const e = estimateUnder(FY, "old", rupees(20_50_000), nps({ s80c: rupees(1_50_000) }));
    assert.equal(e.chapterViA, rupees(1_50_000));
    assert.equal(e.employerNps, rupees(1_00_000));
  });

  test("is saved and read back, and refused without basic + DA to cap it", () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    const decl: Declaration = { ...nps({ s80ccd2Government: true }), gross: rupees(20_50_000) };
    saveDeclaration(db, "m", FY, decl);
    const back = getDeclaration(db, "m", FY);
    assert.equal(back.s80ccd2, rupees(1_50_000));
    assert.equal(back.s80ccd2Government, true);
    assert.throws(() => saveDeclaration(db, "m", FY, { ...decl, hra: null }), /Basic \+ DA/);
  });

  test("the page takes it and shows it as its own line under the new regime", async () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    const app = await startTestApp(db, { memberId: "m" });
    try {
      const r = await app.post("/tax", {
        fy: String(FY), gross: "2075000", s80c: "0", s80d: "0", other: "0",
        hra_basic: "1000000", s80ccd2: "150000",
      });
      assert.equal(r.status, 303);
      const page = await (await app.get(`/tax?fy=${FY}`)).text();
      assert.match(page, /id="s80ccd2" name="s80ccd2"[^>]*value="150000.00"/);
      assert.match(page, /Employer NPS, 80CCD\(2\)/);
      assert.match(page, /₹1,78,880/);
    } finally { await app.close(); }
  });
});
