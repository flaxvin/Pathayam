/**
 * ENG-16 · Section 80C(3)/(3A): a life policy's premium counts only up to a
 * share of the actual capital sum assured — 10% for a policy issued on or
 * after 1 April 2012, 20% for one issued before. A single-premium policy of
 * ₹1,00,000 with ₹5,00,000 of cover puts ₹50,000 into 80C, not ₹1,00,000.
 *
 * Synthetic policies only.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees, type Paise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { createPolicy, policyTaxSuggestion } from "./insurance.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi: Actor = { memberId: RAVI, source: "ui" };

function household() {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, PRIYA, "Priya");
  return db;
}

describe("ENG-16 · 80C counts a life premium only up to a share of the sum assured", () => {
  test("a single premium above 10% of the cover counts at 10% (issued from 1 April 2012)", () => {
    const db = household();
    createPolicy(db, ravi, {
      insurer: "Fictional Life", kind: "life", premium: rupees(1_00_000) as Paise,
      sumAssured: rupees(5_00_000) as Paise, frequency: "single",
      startDate: "2026-05-01", nextDue: "2026-05-01", taxGroup: "80c", holderMemberId: RAVI,
    });
    const s = policyTaxSuggestion(db, RAVI, 2026);
    assert.equal(s.s80c, rupees(50_000));
    assert.equal(s.lines[0]?.amount, rupees(50_000));
  });

  test("monthly premiums are capped on the year's total", () => {
    const db = household();
    createPolicy(db, ravi, {
      insurer: "Fictional Life", kind: "life", premium: rupees(6_000) as Paise,
      sumAssured: rupees(6_00_000) as Paise, frequency: "monthly",
      startDate: "2015-04-10", nextDue: "2026-04-10", endDate: "2035-04-10",
      taxGroup: "80c", holderMemberId: RAVI,
    });
    // 12 × ₹6,000 = ₹72,000 due; 10% of ₹6,00,000 is ₹60,000.
    assert.equal(policyTaxSuggestion(db, RAVI, 2026).s80c, rupees(60_000));
  });

  test("a policy issued before 1 April 2012 is capped at 20%", () => {
    const db = household();
    createPolicy(db, ravi, {
      insurer: "Fictional Life", kind: "life", premium: rupees(70_000) as Paise,
      sumAssured: rupees(3_00_000) as Paise, frequency: "yearly",
      startDate: "2010-06-01", nextDue: "2026-06-01", endDate: "2030-06-01",
      taxGroup: "80c", holderMemberId: RAVI,
    });
    assert.equal(policyTaxSuggestion(db, RAVI, 2026).s80c, rupees(60_000));
  });

  test("within the share, or with no sum assured recorded, the premium counts whole", () => {
    const db = household();
    createPolicy(db, ravi, {
      insurer: "Fictional Term", kind: "term-life", premium: rupees(18_000) as Paise,
      sumAssured: rupees(1_00_00_000) as Paise, frequency: "yearly",
      startDate: "2020-03-12", nextDue: "2027-03-12", endDate: "2050-03-12",
      taxGroup: "80c", holderMemberId: RAVI,
    });
    createPolicy(db, ravi, {
      insurer: "Unknown Cover Life", kind: "life", premium: rupees(20_000) as Paise,
      frequency: "yearly", startDate: "2020-06-01", nextDue: "2026-06-01", endDate: "2040-06-01",
      taxGroup: "80c", holderMemberId: RAVI,
    });
    assert.equal(policyTaxSuggestion(db, RAVI, 2026).s80c, rupees(38_000));
  });
});
