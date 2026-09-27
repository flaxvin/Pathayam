/**
 * EXTRA-6 · Section 80D has two ceilings: yourself and family, and parents.
 *
 * One figure against one ceiling (₹25,000, or ₹50,000 with a senior covered)
 * was the rule for a household insuring only itself. The Act gives parents a
 * second deduction with its own ceiling, and a ₹5,000 preventive check-up
 * inside them. ₹25,000 for yourself and ₹50,000 for a senior parent is
 * ₹75,000 allowed; the one box allowed ₹50,000.
 *
 *   self/family < 60: ₹25,000     parents < 60: ₹25,000
 *   self/family senior: ₹50,000   parents senior: ₹50,000
 *   check-ups: ₹5,000 in all, inside those; old regime only.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees, type Paise } from "../core/money.ts";
import { estimateUnder, deduction80D, getDeclaration, NEWEST_KNOWN_FY, type Deductions } from "./tax.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const FY = NEWEST_KNOWN_FY;
const none: Deductions = { s80c: 0 as Paise, s80d: 0 as Paise, s80dSenior: false, other: 0 as Paise, hra: null };
const d = (x: Partial<Deductions>): Deductions => ({ ...none, ...x });

describe("EXTRA-6 · the 80D ceilings", () => {
  test("each group has its own ceiling", () => {
    const cases: [string, Deductions, number][] = [
      ["self 25k", d({ s80d: rupees(30_000) }), 25_000],
      ["senior self", d({ s80d: rupees(60_000), s80dSenior: true }), 50_000],
      ["self 25k + parents 25k", d({ s80d: rupees(25_000), s80dParents: rupees(25_000) }), 50_000],
      ["self 25k + senior parents", d({ s80d: rupees(25_000), s80dParents: rupees(60_000), s80dParentsSenior: true }), 75_000],
      ["senior self + senior parents",
        d({ s80d: rupees(50_000), s80dSenior: true, s80dParents: rupees(50_000), s80dParentsSenior: true }), 100_000],
      ["a senior self does not raise the parents' ceiling",
        d({ s80d: rupees(50_000), s80dSenior: true, s80dParents: rupees(50_000) }), 75_000],
    ];
    for (const [label, input, allowed] of cases) {
      assert.equal(deduction80D(input), rupees(allowed), label);
    }
  });

  test("check-ups count up to ₹5,000 in all, and only inside a group's room", () => {
    assert.equal(deduction80D(d({ s80d: rupees(10_000), s80dCheckup: rupees(8_000) })), rupees(15_000));
    assert.equal(deduction80D(d({ s80dCheckup: rupees(3_000), s80dParentsCheckup: rupees(3_000) })), rupees(5_000));
    // Premiums already at the ceiling leave no room for the check-up.
    assert.equal(deduction80D(d({ s80d: rupees(25_000), s80dCheckup: rupees(5_000) })), rupees(25_000));
    // Parents' room is the parents' check-up's, not the family's.
    assert.equal(deduction80D(d({ s80d: rupees(25_000), s80dCheckup: rupees(5_000), s80dParents: 0 as Paise })),
      rupees(25_000));
    assert.equal(deduction80D(d({ s80d: rupees(25_000), s80dParentsCheckup: rupees(5_000) })), rupees(30_000));
  });

  test("the old regime takes it; the new regime does not", () => {
    const decl = d({ s80d: rupees(25_000), s80dParents: rupees(50_000), s80dParentsSenior: true });
    assert.equal(estimateUnder(FY, "old", rupees(2_000_000), decl).chapterViA, rupees(75_000));
    assert.equal(estimateUnder(FY, "new", rupees(2_000_000), decl).chapterViA, 0);
  });

  test("the /tax form saves the parents' figures and reads them back", async () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    const app = await startTestApp(db, { memberId: "m" });
    try {
      const res = await app.post("/tax", {
        fy: String(FY), gross: "2000000", s80c: "0", s80d: "25000", other: "0",
        s80d_parents: "60000", s80d_parents_senior: "1", s80d_checkup: "2000", s80d_parents_checkup: "0",
      });
      assert.equal(res.status, 303);
      const saved = getDeclaration(db, "m", FY);
      assert.equal(saved.s80dParents, rupees(60_000));
      assert.equal(saved.s80dParentsSenior, true);
      assert.equal(saved.s80dCheckup, rupees(2_000));
      assert.equal(deduction80D(saved), rupees(75_000));
      const page = await (await app.get(`/tax?fy=${FY}`)).text();
      assert.match(page, /id="s80d_parents" name="s80d_parents"[^>]*value="60000.00"/);
      assert.match(page, /name="s80d_parents_senior" value="1" checked/);
    } finally {
      await app.close();
    }
  });
});
