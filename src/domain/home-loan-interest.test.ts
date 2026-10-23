/**
 * TAX-1 · Home loan interest carried into the tax estimate, accrued.
 *
 * Every figure below is worked by hand. The loan interest report adds up
 * interest paid in the year; section 24(b) wants interest that accrued in it,
 * and an EMI paid on 5 April is mostly March's.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees, type Paise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { undoEvent } from "../core/events.ts";
import { queryOne } from "../db/db.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { createAccount } from "./accounts.ts";
import { createLoan, recordInstalment, setLoanPropertyUse, getLoan } from "./loans.ts";
import { accrueBetween, homeLoanInterestFor } from "./home-loan-interest.ts";

const ravi: Actor = { memberId: "m", source: "ui" };

function setup(opts: { holder?: string | null; members?: number; loanType?: "home" | "home-under-construction"; first?: string } = {}) {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  if ((opts.members ?? 1) > 1) seedMember(db, "p", "Priya");
  const bank = createAccount(db, ravi, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: rupees(50_00_000),
  }).id;
  const loan = createLoan(db, ravi, {
    holderMemberId: opts.holder === undefined ? "m" : opts.holder,
    lender: "Fictional Housing Finance", loanType: opts.loanType ?? "home",
    sanctioned: rupees(10_00_000), sanctionDate: "2025-03-01", interestModel: "reducing",
    annualRatePct: 9, tenureMonths: 240, currentOutstanding: rupees(10_00_000),
    repaymentAccountId: bank, firstInstalmentDate: opts.first ?? "2025-04-05",
  });
  return { db, bank, loan };
}

/**
 * Thirteen instalments from 5 April 2025 to 5 April 2026, each with the
 * lender's split: ₹3,100 of interest in the first (a broken period), ₹7,000
 * in every other.
 */
function payAYear(db: ReturnType<typeof freshDb>, loanId: string) {
  for (let k = 0; k < 13; k++) {
    const month = new Date(Date.UTC(2025, 3 + k, 5)).toISOString().slice(0, 10);
    const interest = k === 0 ? rupees(3_100) : rupees(7_000);
    recordInstalment(db, ravi, {
      loanId, date: month, amount: rupees(9_000), interest, principal: (rupees(9_000) - interest) as Paise,
    });
  }
}

describe("accrueBetween", () => {
  test("an instalment's interest is spread over the days it pays for", () => {
    // ₹3,100 for 6 March to 5 April: 26 of its 31 days are in FY 2025-26.
    const periods = [{ start: "2026-03-05", end: "2026-04-05", interest: rupees(3_100), estimated: false }];
    assert.equal(accrueBetween(periods, "2025-04-01", "2026-03-31").total, rupees(2_600));
    assert.equal(accrueBetween(periods, "2026-04-01", "2027-03-31").total, rupees(500));
  });

  test("a one-day period counts on its day, and the estimated part is kept apart", () => {
    const periods = [
      { start: "2025-10-01", end: "2025-10-01", interest: rupees(1_234), estimated: true },
      { start: "2025-09-05", end: "2025-10-05", interest: rupees(6_000), estimated: false },
    ];
    const r = accrueBetween(periods, "2025-04-01", "2026-03-31");
    assert.equal(r.total, rupees(7_234));
    assert.equal(r.estimated, rupees(1_234));
  });
});

describe("TAX-1 · home loan interest, accrued in the financial year", () => {
  test("is the year's days of each instalment, not the instalments paid in it", () => {
    const { db, loan } = setup();
    setLoanPropertyUse(db, ravi, loan.id, "self-occupied");
    payAYear(db, loan.id);

    /*
     * Cash paid in FY 2025-26 (April to March): ₹3,100 + 11 × ₹7,000 = ₹80,100.
     * Accrued: 5 of 31 days of the 5 April 2025 instalment (₹500), the eleven
     * from May to March whole (₹77,000), and 26 of 31 days of the 5 April
     * 2026 one (₹5,870.97) — ₹83,370.97.
     */
    const h = homeLoanInterestFor(db, 2025, "m");
    assert.equal(h.lines.length, 1);
    assert.equal(h.selfOccupied, 83_370_97);
    assert.equal(h.lines[0]!.estimatedPart, 0, "every split is the lender's own");
    assert.equal(h.estimated, false);
  });

  test("an instalment not recorded yet comes from the projection, and says it is estimated", () => {
    const { db, loan } = setup({ first: "2026-05-05" });
    setLoanPropertyUse(db, ravi, loan.id, "self-occupied");
    const h = homeLoanInterestFor(db, 2026, "m");
    assert.ok(h.selfOccupied > rupees(80_000) && h.selfOccupied < rupees(90_000),
      `about 9% of ₹10,00,000 for the eleven months from 5 April: ${h.selfOccupied}`);
    assert.equal(h.lines[0]!.estimatedPart, h.selfOccupied);
    assert.equal(h.estimated, true);
  });

  test("a let-out house is shown and not carried", () => {
    const { db, loan } = setup();
    setLoanPropertyUse(db, ravi, loan.id, "let-out");
    payAYear(db, loan.id);
    const h = homeLoanInterestFor(db, 2025, "m");
    assert.equal(h.selfOccupied, 0);
    assert.equal(h.letOut, 83_370_97);
    assert.equal(h.lines[0]!.carried, false);
  });

  test("a loan for a house still being built is not carried", () => {
    const { db, loan } = setup({ loanType: "home-under-construction" });
    setLoanPropertyUse(db, ravi, loan.id, "self-occupied");
    payAYear(db, loan.id);
    const h = homeLoanInterestFor(db, 2025, "m");
    assert.equal(h.selfOccupied, 0);
    assert.match(h.lines[0]!.reason ?? "", /five equal parts/);
  });

  test("a loan says nothing until it is marked", () => {
    const { db, loan } = setup();
    payAYear(db, loan.id);
    assert.equal(homeLoanInterestFor(db, 2025, "m").lines.length, 0);
  });

  test("follows the holder: Priya's loan is not in Ravi's estimate", () => {
    const { db, loan } = setup({ holder: "p", members: 2 });
    setLoanPropertyUse(db, ravi, loan.id, "self-occupied");
    payAYear(db, loan.id);
    assert.equal(homeLoanInterestFor(db, 2025, "m").lines.length, 0);
    assert.equal(homeLoanInterestFor(db, 2025, "p").selfOccupied, 83_370_97);
  });

  test("a loan with no holder is not guessed between two members", () => {
    const { db, loan } = setup({ holder: null, members: 2 });
    setLoanPropertyUse(db, ravi, loan.id, "self-occupied");
    payAYear(db, loan.id);
    const h = homeLoanInterestFor(db, 2025, "m");
    assert.equal(h.selfOccupied, 0);
    assert.match(h.lines[0]!.reason ?? "", /names no holder/);
  });

  test("a missed month is reported, not spread", () => {
    const { db, loan } = setup({ first: "2027-01-05" });
    setLoanPropertyUse(db, ravi, loan.id, "self-occupied");
    recordInstalment(db, ravi, { loanId: loan.id, date: "2025-05-05", amount: rupees(9_000), interest: rupees(7_000), principal: rupees(2_000) });
    recordInstalment(db, ravi, { loanId: loan.id, date: "2025-08-05", amount: rupees(9_000), interest: rupees(7_000), principal: rupees(2_000) });
    const line = homeLoanInterestFor(db, 2025, "m").lines[0]!;
    assert.equal(line.incomplete, true);
  });

  test("marking it is undoable", () => {
    const { db, loan } = setup();
    setLoanPropertyUse(db, ravi, loan.id, "self-occupied");
    const event = queryOne<{ id: string }>(
      db, `SELECT id FROM events WHERE entity = 'loan' AND action = 'property-use'`,
    )!;
    undoEvent(db, event.id, ravi);
    assert.equal(getLoan(db, loan.id)!.property_use, null);
  });
});
