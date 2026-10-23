/**
 * DEPOSITS · The arithmetic of a deposit, against worked examples.
 *
 * Every figure below is worked by hand in its comment, so a change to the
 * rounding or the period rule shows up as a named example going wrong.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import {
  depositValueOn, maturity, checkTerms, grow, addMonthsToDate, roundPaise, type DepositTerms,
} from "./accrual.ts";

const fd: DepositTerms = {
  kind: "fd", principal: rupees(1_00_000), instalment: null, rateBp: 700, compounding: "quarterly",
  startDate: "2025-01-01", maturityDate: "2026-01-01", payout: "cumulative",
};

describe("DEPOSITS · a fixed deposit", () => {
  test("₹1,00,000 at 7% compounded quarterly for a year is ₹1,07,185.90 — ₹1,07,186 to the rupee", () => {
    // 1,00,000 × (1 + 0.07/4)^4 = 1,00,000 × 1.0717590… = 1,07,185.90
    const m = maturity(fd)!;
    assert.equal(m.date, "2026-01-01");
    assert.equal(m.amount, 1_07_18_590);
    assert.equal(Math.round(m.amount / 100), 1_07_186);
  });

  test("halfway, two whole quarters: 1,00,000 × 1.0175² = ₹1,03,530.63", () => {
    assert.equal(depositValueOn(fd, "2025-07-01"), 1_03_53_063);
  });

  test("a broken period earns simple interest for its days", () => {
    // Two quarters to 1 July (1,03,530.625), then 45 days at 7% on that:
    // 1,03,530.625 × (1 + 0.07 × 45/365) = 1,04,424.11
    assert.equal(depositValueOn(fd, "2025-08-15"), 1_04_42_411);
  });

  test("nothing before it starts; nothing more after it matures", () => {
    assert.equal(depositValueOn(fd, "2024-12-31"), 0);
    assert.equal(depositValueOn(fd, "2027-06-30"), maturity(fd)!.amount);
  });

  test("simple interest: 1,00,000 × (1 + 0.07 × 365/365) = ₹1,07,000", () => {
    assert.equal(depositValueOn({ ...fd, compounding: "simple" }, "2026-01-01"), rupees(1_07_000));
  });

  test("interest paid out leaves it worth its principal", () => {
    assert.equal(depositValueOn({ ...fd, payout: "periodic" }, "2025-10-01"), rupees(1_00_000));
    assert.equal(maturity({ ...fd, payout: "periodic" })!.amount, rupees(1_00_000));
  });

  test("monthly and yearly compounding", () => {
    // 1,00,000 × (1 + 0.07/12)^12 = 1,07,229.01; × 1.07 once = 1,07,000
    assert.equal(maturity({ ...fd, compounding: "monthly" })!.amount, 1_07_22_901);
    assert.equal(maturity({ ...fd, compounding: "yearly" })!.amount, rupees(1_07_000));
  });
});

describe("DEPOSITS · a recurring deposit", () => {
  const rd: DepositTerms = {
    kind: "rd", principal: 0, instalment: rupees(5_000), rateBp: 700, compounding: "quarterly",
    startDate: "2025-01-01", maturityDate: "2026-01-01", payout: "cumulative",
  };

  test("₹5,000 a month for a year at 7% quarterly matures at ₹62,315.00", () => {
    // Twelve instalments, each compounded quarterly from its own date to
    // 1 January 2026, the broken part of a quarter at simple interest for its
    // days. Paid in: ₹60,000; interest: ₹2,315.00.
    assert.equal(maturity(rd)!.amount, 62_31_500);
  });

  test("before maturity, only the instalments already due are in it", () => {
    // Six instalments (Jan–Jun) paid by 15 June, each grown to that day.
    const value = depositValueOn(rd, "2025-06-15");
    assert.ok(value > rupees(30_000) && value < rupees(30_600), `got ${value}`);
    assert.equal(value, 30_52_173);
  });

  test("an instalment falls on the last day of a shorter month", () => {
    assert.equal(addMonthsToDate("2025-01-31", 1), "2025-02-28");
    assert.equal(addMonthsToDate("2024-01-31", 1), "2024-02-29");
    assert.equal(addMonthsToDate("2025-01-31", 3), "2025-04-30");
  });
});

describe("DEPOSITS · PPF and EPF", () => {
  const ppf: DepositTerms = {
    kind: "ppf", principal: rupees(1_50_000), instalment: null, rateBp: 710, compounding: "yearly",
    startDate: "2025-04-01", maturityDate: null, payout: "cumulative",
  };

  test("₹1,50,000 in on 1 April at 7.1% is ₹1,60,650 on 31 March", () => {
    // 1,50,000 × 7.1% = 10,650, credited at the year's end.
    assert.equal(depositValueOn(ppf, "2026-03-31"), rupees(1_60_650));
  });

  test("the credited interest earns in the next year: April adds 1,60,650 × 7.1%/12 = ₹950.51", () => {
    assert.equal(depositValueOn(ppf, "2026-04-30"), 1_61_60_051);
  });

  test("a month still running has earned nothing yet", () => {
    assert.equal(depositValueOn(ppf, "2025-04-29"), rupees(1_50_000));
    // April complete: 1,50,000 × 7.1% / 12 = 887.50 accrued, not yet credited.
    assert.equal(depositValueOn(ppf, "2025-04-30"), 1_50_88_750);
  });

  test("money in after the 5th misses that month's interest", () => {
    const empty = { ...ppf, principal: 0 };
    const by5th = depositValueOn(empty, "2026-03-31", [{ date: "2025-04-05", amount: rupees(1_50_000) }]);
    const by6th = depositValueOn(empty, "2026-03-31", [{ date: "2025-04-06", amount: rupees(1_50_000) }]);
    assert.equal(by5th, rupees(1_60_650));
    // Eleven months, not twelve: 1,50,000 × 7.1% × 11/12 = 9,762.50
    assert.equal(by6th, 1_59_76_250);
  });

  test("an EPF contribution earns from the month after; ₹10,000 a month at 8.25% is ₹1,24,537.50 at the year's end", () => {
    const epf: DepositTerms = { ...ppf, kind: "epf", principal: 0, rateBp: 825 };
    const months = ["04", "05", "06", "07", "08", "09", "10", "11", "12", "01", "02", "03"];
    const contributions = months.map((m, i) => ({
      date: `${i < 9 ? 2025 : 2026}-${m}-15`, amount: rupees(10_000),
    }));
    // 10,000 × 8.25%/12 = 68.75 a month per contribution, earned for 11, 10,
    // … 1 months: 68.75 × 66 = 4,537.50.
    assert.equal(depositValueOn(epf, "2026-03-31", contributions), 1_24_53_750);
  });

  test("a withdrawal lowers the balance that month earns on", () => {
    const value = depositValueOn(ppf, "2026-03-31", [{ date: "2025-04-20", amount: -rupees(50_000) }]);
    // 1,00,000 for all twelve months: 7,100.
    assert.equal(value, rupees(1_07_100));
  });
});

describe("DEPOSITS · other deposits read the register", () => {
  test("each contribution grows from its own date", () => {
    const other: DepositTerms = {
      kind: "other", principal: rupees(1_00_000), instalment: null, rateBp: 700,
      compounding: "yearly", startDate: "2025-01-01", maturityDate: null, payout: "cumulative",
    };
    // 1,00,000 for a year at 7% = 1,07,000; 50,000 in on 1 July for 184 days
    // at 7% simple (the year not complete) = 51,764.38.
    assert.equal(
      depositValueOn(other, "2026-01-01", [{ date: "2025-07-01", amount: rupees(50_000) }]),
      rupees(1_07_000) + 51_76_438,
    );
    // An FD does not: its register is not what it is worth.
    assert.equal(
      depositValueOn({ ...other, kind: "fd" }, "2026-01-01", [{ date: "2025-07-01", amount: rupees(50_000) }]),
      rupees(1_07_000),
    );
  });
});

describe("DEPOSITS · rounding and checks", () => {
  test("a half paisa goes away from zero", () => {
    assert.equal(roundPaise(10.5), 11);
    assert.equal(roundPaise(-10.5), -11);
    assert.equal(roundPaise(10.49), 10);
  });

  test("growth at nil is the amount", () => {
    assert.equal(grow(12_345, "2025-01-01", "2030-01-01", 0, "quarterly"), 12_345);
  });

  test("terms that cannot be priced are refused with a sentence", () => {
    const base = { kind: "fd", principal: rupees(1_000), rateBp: 700, startDate: "2025-01-01" };
    assert.throws(() => checkTerms({ ...base, kind: "bond" }), Refusal);
    assert.throws(() => checkTerms({ ...base, rateBp: 10_001 }), Refusal);
    assert.throws(() => checkTerms({ ...base, rateBp: 7.5 }), Refusal);
    assert.throws(() => checkTerms({ ...base, principal: 0 }), /needs the sum/);
    assert.throws(() => checkTerms({ ...base, maturityDate: "2024-12-31" }), /matures after it starts/);
    assert.throws(() => checkTerms({ ...base, kind: "rd", principal: 0 }), /instalment/);
    assert.throws(() => checkTerms({ ...base, kind: "ppf", compounding: "quarterly" }), /yearly/);
    assert.throws(() => checkTerms({ ...base, kind: "ppf", payout: "periodic" }), /keeps its interest/);
    assert.throws(() => checkTerms({ ...base, payout: "periodic", compounding: "simple" }), Refusal);
  });

  test("the kind's own compounding is the default", () => {
    assert.equal(checkTerms({ kind: "fd", principal: 100, rateBp: 700, startDate: "2025-01-01" }).compounding, "quarterly");
    assert.equal(checkTerms({ kind: "ppf", rateBp: 710, startDate: "2025-04-01" }).compounding, "yearly");
  });
});
