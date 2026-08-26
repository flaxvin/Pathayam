/**
 * The amortisation engine against every worked figure in `06`.
 *
 * `docs/verify_amortisation.py` pins the same 33 figures from the document's
 * side. This pins them from the code's side, so the two cannot drift apart
 * without one of them failing — which is the point of `05` §8 putting the
 * engine first.
 *
 * Figures are asserted in **whole rupees**, as `06` quotes them.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import {
  emiFor, buildSchedule, flatRateLoan, equivalentReducingRate, moratorium,
  preEmi, comparePrepayment, compareExtraMonthly, rateResetOptions,
  lifetimeMetrics, drift, NegativeAmortisation,
} from "./amortisation.ts";

/** Whole rupees, the unit `06` quotes. */
const R = (paise: number) => Math.round(paise / 100);

// The ₹50,00,000 loan at 8.5% over 240 months that most of `06` is built on.
const HOME = { principal: rupees(50_00_000), annualRatePct: 8.5, months: 240 };

describe("R17 · the home loan schedule", () => {
  test("EMI ₹43,391, lifetime interest ₹54,13,879, total repaid ₹1,04,13,879", () => {
    const schedule = buildSchedule(HOME);
    assert.equal(R(emiFor(HOME.principal, HOME.annualRatePct, HOME.months)), 43_391);
    assert.equal(R(schedule.totalInterest), 54_13_879);
    assert.equal(R(schedule.totalRepaid), 1_04_13_879);
    assert.equal(schedule.months, 240);
  });

  test("you repay slightly more than double", () => {
    const schedule = buildSchedule(HOME);
    assert.ok(schedule.totalRepaid > HOME.principal * 2);
    assert.ok(schedule.totalRepaid < HOME.principal * 2.1);
  });

  test("every instalment carries the columns R17 requires", () => {
    const first = buildSchedule(HOME).instalments[0]!;
    assert.equal(first.number, 1);
    assert.equal(R(first.opening), 50_00_000);
    // Month one is almost all interest — 8.5%/12 of ₹50L is ₹35,416.67.
    assert.equal(first.interest, 35_41_667);
    // ₹7,974.50, not ₹43,391 − ₹35,417. Subtracting the *rounded* figures
    // gives ₹7,974 and is wrong by a rupee, which is exactly the error 06 §12
    // keeps out of the lifetime total by rounding only at the edge.
    assert.equal(first.principal, 7_97_450);
    assert.equal(first.estimated, true, "R18.3 — a projected split is marked");
  });

  test("closes exactly, with the balance reaching zero", () => {
    const schedule = buildSchedule(HOME);
    assert.equal(schedule.instalments.at(-1)!.closing, 0);
    assert.equal(schedule.instalments.length, 240);
  });

  test("balance at month 24 is ₹47,92,181", () => {
    const schedule = buildSchedule(HOME);
    assert.equal(R(schedule.instalments[23]!.closing), 47_92_181);
  });

  test("anchors due dates when given a first instalment date", () => {
    const schedule = buildSchedule({ ...HOME, firstInstalmentDate: "2026-09-05" });
    assert.equal(schedule.instalments[0]!.dueDate, "2026-09-05");
    assert.equal(schedule.instalments[1]!.dueDate, "2026-10-05");
    assert.equal(schedule.closesOn, "2046-08-05");
  });

  test("R17.4 — refuses a configuration that cannot amortise, and says why", () => {
    // ₹30,000 against ₹35,417 of monthly interest: the balance would grow.
    assert.throws(
      () => buildSchedule({ ...HOME, emi: rupees(30_000) }),
      (err: unknown) =>
        err instanceof NegativeAmortisation && /never close/.test(err.message),
    );
  });
});

describe("R19 · prepayment — the decision this module exists for", () => {
  const comparison = comparePrepayment({
    ...HOME, prepayment: rupees(5_00_000), atMonth: 24,
  });

  test("reduce tenure — 195 months, interest ₹39,56,578, saved ₹14,57,301", () => {
    assert.equal(comparison.reduceTenure.months, 195);
    assert.equal(comparison.reduceTenure.emisSaved, 45);
    assert.equal(R(comparison.reduceTenure.lifetimeInterest), 39_56_578);
    assert.equal(R(comparison.reduceTenure.interestSaved), 14_57_301);
    assert.equal(R(comparison.reduceTenure.emiAfter), 43_391, "the EMI is unchanged");
  });

  test("reduce EMI — ₹38,864, interest ₹49,35,985, saved ₹4,77,894", () => {
    assert.equal(R(comparison.reduceEmi.emiAfter), 38_864);
    assert.equal(R(comparison.reduceEmi.lifetimeInterest), 49_35_985);
    assert.equal(R(comparison.reduceEmi.interestSaved), 4_77_894);
    assert.equal(comparison.reduceEmi.months, 240, "the tenure is unchanged");
  });

  test("tenure reduction saves ₹9,79,407 more — the whole reason for this module", () => {
    assert.equal(R(comparison.tenureAdvantage), 9_79_407);
    // R19.3: the reason, in one line, with the household's own numbers.
    assert.match(comparison.recommendation, /Reducing the tenure saves ₹9,79,407 more/);
    assert.match(comparison.recommendation, /45 instalments early/);
  });

  test("R19.5 — a prepayment charge comes out of the net saving", () => {
    const charged = comparePrepayment({
      ...HOME, prepayment: rupees(5_00_000), atMonth: 24,
      prepaymentCharge: rupees(10_000),
    });
    assert.equal(
      charged.reduceTenure.interestSaved,
      comparison.reduceTenure.interestSaved - rupees(10_000),
    );
  });

  test("R19.7 — the what-if calculator models without recording anything", () => {
    // Same function, no side effects: nothing here touches a database.
    const whatIf = comparePrepayment({ ...HOME, prepayment: rupees(2_00_000), atMonth: 36 });
    assert.ok(whatIf.reduceTenure.interestSaved > 0);
    assert.ok(whatIf.tenureAdvantage > 0);
  });
});

describe("R19 · a recurring extra payment", () => {
  test("₹5,000 a month closes it in 187 months, saving ₹13,89,250", () => {
    const outcome = compareExtraMonthly({ ...HOME, extraMonthly: rupees(5_000) });
    assert.equal(outcome.withExtra.months, 187);
    assert.equal(R(outcome.withExtra.totalInterest), 40_24_629);
    assert.equal(R(outcome.interestSaved), 13_89_250);
    assert.equal(outcome.emisSaved, 53, "4 years 5 months early");
  });
});

describe("R16 M2 · flat rate, and what it really costs", () => {
  test("₹8,00,000 at 9% flat over 60 months is 15.71% reducing", () => {
    const loan = flatRateLoan(rupees(8_00_000), 9, 60);
    assert.equal(R(loan.totalInterest), 3_60_000);
    assert.equal(R(loan.emi), 19_333);
    // The headline "9%" is 15.71% in the only sense that matters.
    assert.equal(Math.round(loan.equivalentReducingRatePct * 100) / 100, 15.71);
  });

  test("the equivalent rate inverts the EMI formula correctly", () => {
    // Round-trip: a known reducing loan must report back its own rate.
    const emi = emiFor(rupees(50_00_000), 8.5, 240);
    const recovered = equivalentReducingRate(rupees(50_00_000), emi, 240);
    assert.ok(Math.abs(recovered - 8.5) < 0.01, `got ${recovered}`);
  });

  test("reports zero when the payments never exceed the principal", () => {
    assert.equal(equivalentReducingRate(rupees(1_00_000), rupees(1_000), 60), 0);
  });
});

describe("R16 M3, M4 · moratorium", () => {
  const EDUCATION = {
    principal: rupees(15_00_000),
    annualRatePct: 10.5,
    moratoriumMonths: 48,
    repaymentMonths: 120,
  };

  test("serviced — ₹13,125 a month, ₹6,30,000 total, then an EMI of ₹20,240", () => {
    const outcome = moratorium({ ...EDUCATION, capitalise: false });
    assert.equal(R(outcome.monthlyInterest), 13_125);
    assert.equal(R(outcome.totalServiced), 6_30_000);
    assert.equal(R(outcome.balanceAtRepaymentStart), 15_00_000, "principal is untouched");
    assert.equal(R(outcome.emiAfter), 20_240);
  });

  test("capitalised — ₹7,78,776 added, balance ₹22,78,776, EMI ₹30,749", () => {
    const outcome = moratorium({ ...EDUCATION, capitalise: true });
    assert.equal(R(outcome.capitalisedInterest), 7_78_776);
    assert.equal(R(outcome.balanceAtRepaymentStart), 22_78_776);
    assert.equal(R(outcome.emiAfter), 30_749);
  });

  test("not servicing costs ₹10,508 a month, for ten years", () => {
    const serviced = moratorium({ ...EDUCATION, capitalise: false });
    const capitalised = moratorium({ ...EDUCATION, capitalise: true });
    // R16 M4: the app must warn about this AND quantify it.
    assert.equal(R(capitalised.emiAfter - serviced.emiAfter), 10_508);
  });
});

describe("R15 · pre-EMI on what has been drawn", () => {
  test("interest accrues on disbursed principal only, never on the sanction", () => {
    // ₹50L sanctioned, but only ₹10L drawn.
    assert.equal(R(preEmi(rupees(10_00_000), 8.5)), 7_083);
    assert.equal(R(preEmi(rupees(25_00_000), 8.5)), 17_708);
  });
});

describe("R20 · rate reset", () => {
  test("8.5% → 9.0% at month 24: keep the EMI, or keep the tenure", () => {
    const options = rateResetOptions({
      outstanding: rupees(47_92_181),
      currentEmi: rupees(43_391),
      remainingMonths: 216,
      oldRatePct: 8.5,
      newRatePct: 9.0,
    });

    assert.equal(options.keepEmi.months, 236, "tenure extends by 20 months");
    assert.equal(options.keepEmi.monthsDelta, 20);
    assert.equal(R(options.keepTenure.emi), 44_876);
    assert.equal(R(options.keepTenure.emiDelta), 1_485, "₹1,485 more per month");
  });

  test("R20.3 — refuses an option that would not amortise", () => {
    assert.throws(
      () =>
        rateResetOptions({
          outstanding: rupees(50_00_000),
          currentEmi: rupees(20_000),
          remainingMonths: 240,
          oldRatePct: 8.5,
          newRatePct: 24,
        }),
      NegativeAmortisation,
    );
  });
});

describe("R22 · lifetime metrics", () => {
  test("separates what was actually paid from what is projected", () => {
    const metrics = lifetimeMetrics({
      disbursed: rupees(50_00_000),
      actualInterestPaid: rupees(8_40_000),
      actualPrincipalRepaid: rupees(2_07_819),
      projectedRemainingInterest: rupees(31_16_578),
      baselineInterest: rupees(54_13_879),
      baselineMonths: 240,
      projectedMonths: 195,
    });

    assert.equal(R(metrics.interestPaid), 8_40_000, "never includes projected interest");
    assert.equal(R(metrics.interestProjected), 39_56_578);
    assert.equal(R(metrics.interestSaved), 14_57_301);
    assert.equal(metrics.emisSaved, 45);
    assert.ok(metrics.progressPercent > 4 && metrics.progressPercent < 5);
  });

  test("R22.4 — a rate cut is reported separately, not as the household's doing", () => {
    const metrics = lifetimeMetrics({
      disbursed: rupees(50_00_000),
      actualInterestPaid: rupees(8_40_000),
      actualPrincipalRepaid: rupees(2_07_819),
      projectedRemainingInterest: rupees(31_16_578),
      baselineInterest: rupees(54_13_879),
      baselineMonths: 240,
      projectedMonths: 195,
      rateMovementEffect: rupees(3_00_000),
    });

    assert.equal(R(metrics.savedByRateMovement), 3_00_000);
    assert.equal(R(metrics.savedByAction), 14_57_301 - 3_00_000);
  });

  test("includes fees in the total cost of borrowing", () => {
    const metrics = lifetimeMetrics({
      disbursed: rupees(8_00_000),
      actualInterestPaid: 0,
      actualPrincipalRepaid: 0,
      projectedRemainingInterest: rupees(3_60_000),
      baselineInterest: rupees(3_60_000),
      baselineMonths: 60,
      projectedMonths: 60,
      fees: rupees(12_000),
    });
    assert.equal(R(metrics.totalCostOfBorrowing), 3_72_000);
  });

  test("R22.3 — labels lifetime figures when history predates the app", () => {
    const metrics = lifetimeMetrics({
      disbursed: rupees(5_00_000), actualInterestPaid: 0, actualPrincipalRepaid: 0,
      projectedRemainingInterest: 0, baselineInterest: 0,
      baselineMonths: 60, projectedMonths: 60,
      fromDate: "2026-08-14",
    });
    assert.equal(metrics.fromDate, "2026-08-14");
  });
});

describe("R18 · drift", () => {
  test("stays quiet below the threshold", () => {
    const result = drift(rupees(47_92_181), rupees(47_92_000));
    assert.equal(result.material, false, "₹181 is not worth interrupting anyone");
  });

  test("raises a review item beyond ₹500 or 0.1%, whichever is larger", () => {
    // 0.1% of ₹47.9L is ₹4,792, so that is the binding threshold here.
    assert.equal(drift(rupees(47_92_181), rupees(47_90_000)).material, false);
    assert.equal(drift(rupees(47_92_181), rupees(47_80_000)).material, true);

    // On a small balance ₹500 binds instead.
    assert.equal(drift(rupees(20_000), rupees(19_400)).material, true);
    assert.equal(drift(rupees(20_000), rupees(19_600)).material, false);
  });

  test("reports direction, so an overpayment reads differently from a shortfall", () => {
    assert.ok(drift(rupees(1_00_000), rupees(90_000)).amount > 0);
    assert.ok(drift(rupees(90_000), rupees(1_00_000)).amount < 0);
  });
});

describe("rounding is display-only (06 §12)", () => {
  test("240 instalments do not accumulate error into the lifetime figure", () => {
    const schedule = buildSchedule(HOME);
    // Summing the rounded per-instalment interest must land within a rupee or
    // two of the unrounded total — if the engine rounded as it went, this
    // would drift by hundreds over 240 months.
    const summed = schedule.instalments.reduce((total, i) => total + i.interest, 0);
    assert.ok(
      Math.abs(summed - schedule.totalInterest) < rupees(2),
      `rounded sum ${summed} vs exact ${schedule.totalInterest}`,
    );
  });

  test("a zero-interest loan amortises evenly", () => {
    const schedule = buildSchedule({ principal: rupees(1_20_000), annualRatePct: 0, months: 12 });
    assert.equal(schedule.months, 12);
    assert.equal(schedule.totalInterest, 0);
    assert.equal(R(schedule.instalments[0]!.payment), 10_000);
  });
});
