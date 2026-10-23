/**
 * TAX-FY25-1 · 2024-25, split on the date of sale.
 *
 * Finance (No. 2) Act 2024 changed the rates for sales on or after 23 July
 * 2024 (CBDT FAQs, checked 23 October 2026):
 *
 *   sold before 23 July 2024         sold on or after it
 *   s111A  15%                       20%
 *   s112A  10% above the exemption   12.5% above the exemption
 *   s112   20% with indexation       12.5% without
 *
 * The 112A exemption is ₹1.25 lakh for the whole year. Before the date a
 * listed unit other than equity, a fund unit and gold were long-term only
 * after 36 months. This app does not model the cost inflation index, so a
 * pre-23-July s112 gain is reported as not computed, never taxed on a guess.
 *
 * And a year whose rates are not here is refused: 2024-25 used to be taxed
 * at the newest year's rates, silently.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import { nowIST, type IsoDate } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount } from "./accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale, listHoldings,
  classifyInstrument, type AssetClass, type InstrumentKind,
} from "./assets.ts";
import { units, price } from "../portfolio/holdings.ts";
import {
  gainsBucketsForYear, capitalGainsTaxFor, taxOnGains, gainsRulesOn, GAINS_RATES_CHANGED_ON,
  type GainsBuckets,
} from "./capital-gains-tax.ts";
import { renderTax } from "../web/pages/tax.ts";

const actor: Actor = { memberId: "m", source: "ui" };

/** ₹1,00,000 in at ₹100, out at ₹150: a ₹50,000 gain. Returns the database. */
function sold(kind: InstrumentKind, cls: AssetClass, bought: IsoDate, on: IsoDate) {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`, "m", "f@e.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Savings", kind: "budget", subtype: "savings",
    openingDate: "2020-01-01", openingBalance: rupees(1_000_000),
  }).id;
  const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" }).id;
  const inst = findOrCreateInstrument(db, actor, { name: "Holding", kind, symbol: "X", provider: "manual" }).id;
  classifyInstrument(db, actor, inst, { assetClass: cls });
  recordPurchase(db, actor, {
    accountId: demat, instrumentId: inst, tradeDate: bought,
    price: price(100), units: units(1_000), fromAccountId: bank,
  });
  recordSale(db, actor, {
    holdingId: listHoldings(db, demat)[0]!.id, date: on,
    units: units(1_000), price: price(150), toAccountId: bank,
  });
  return db;
}

const zero = 0 as Paise;
function split2024(before: Partial<Record<"equityLong" | "equityShort" | "otherLong", Paise>>,
                   after: Partial<Record<"equityLong" | "equityShort" | "otherLong", Paise>>): GainsBuckets {
  const b = { equityLong: zero, equityShort: zero, otherLong: zero, ...before };
  const a = { equityLong: zero, equityShort: zero, otherLong: zero, ...after };
  return {
    equityLong: (b.equityLong + a.equityLong) as Paise,
    equityShort: (b.equityShort + a.equityShort) as Paise,
    otherLong: (b.otherLong + a.otherLong) as Paise,
    slabRated: zero, unclassified: zero, unclassifiedReasons: [],
    byPeriod: [
      { from: "2024-04-01", ...b },
      { from: GAINS_RATES_CHANGED_ON, ...a },
    ],
  };
}

describe("the rules are the sale date's", () => {
  test("22 July 2024 is under the old rates, 23 July under the new", () => {
    const before = gainsRulesOn("2024-07-22");
    assert.equal(before.equityShortBp, 1500);
    assert.equal(before.equityLongBp, 1000);
    assert.equal(before.otherLongBp, 2000);
    assert.equal(before.otherLongIndexed, true);
    assert.equal(before.equityLongExemption, rupees(125_000));

    const on = gainsRulesOn("2024-07-23");
    assert.equal(on.equityShortBp, 2000);
    assert.equal(on.equityLongBp, 1250);
    assert.equal(on.otherLongBp, 1250);
    assert.equal(on.otherLongIndexed, false);
    assert.equal(on.equityLongExemption, rupees(125_000));
  });
});

describe("short-term listed equity, s111A", () => {
  test("sold 22 July 2024, it is 15%", () => {
    const db = sold("equity", "equity", "2024-01-10", "2024-07-22");
    const t = capitalGainsTaxFor(db, 2024, "m");
    assert.equal(t.buckets.equityShort, rupees(50_000));
    assert.equal(t.equityShortTax, rupees(7_500));
  });

  test("sold on exactly 23 July 2024, it is 20%", () => {
    const db = sold("equity", "equity", "2024-01-10", "2024-07-23");
    const t = capitalGainsTaxFor(db, 2024, "m");
    assert.equal(t.buckets.equityShort, rupees(50_000));
    assert.equal(t.equityShortTax, rupees(10_000));
  });

  test("₹1,00,000 either side of the date is ₹15,000 and ₹20,000", () => {
    const t = taxOnGains(2024, split2024({ equityShort: rupees(100_000) }, { equityShort: rupees(100_000) }));
    assert.equal(t.equityShortTax, rupees(35_000));
  });
});

describe("long-term listed equity, s112A, with the year's one exemption", () => {
  test("sold 22 July 2024, ₹3,00,000 is ₹1,75,000 over the exemption at 10%", () => {
    const t = taxOnGains(2024, split2024({ equityLong: rupees(300_000) }, {}));
    assert.equal(t.exemptionUsed, rupees(125_000));
    assert.equal(t.equityLongTax, rupees(17_500));
  });

  test("sold on 23 July 2024, the same gain is at 12.5%", () => {
    const t = taxOnGains(2024, split2024({}, { equityLong: rupees(300_000) }));
    assert.equal(t.exemptionUsed, rupees(125_000));
    assert.equal(t.equityLongTax, rupees(21_875));
  });

  test("the exemption is used once across both sides, against the 12.5% gains first", () => {
    // ₹2,00,000 before and ₹1,00,000 after. ₹1,00,000 of the exemption clears
    // the 12.5% side; the other ₹25,000 comes off the 10% side, leaving
    // ₹1,75,000 at 10% = ₹17,500. Not ₹1,25,000 twice.
    const t = taxOnGains(2024, split2024({ equityLong: rupees(200_000) }, { equityLong: rupees(100_000) }));
    assert.equal(t.exemptionUsed, rupees(125_000));
    assert.equal(t.equityLongTax, rupees(17_500));
  });

  test("from a recorded sale either side of the date", () => {
    const before = capitalGainsTaxFor(sold("equity", "equity", "2022-01-10", "2024-07-22"), 2024, "m");
    assert.equal(before.buckets.equityLong, rupees(50_000));
    assert.equal(before.buckets.byPeriod![0]!.equityLong, rupees(50_000));
    assert.equal(before.exemptionUsed, rupees(50_000), "the gain sits inside the exemption");
    assert.equal(before.equityLongTax, 0);

    const on = capitalGainsTaxFor(sold("equity", "equity", "2022-01-10", "2024-07-23"), 2024, "m");
    assert.equal(on.buckets.byPeriod![1]!.equityLong, rupees(50_000));
    assert.equal(on.buckets.byPeriod![0]!.equityLong, 0);
  });
});

describe("s112 before 23 July 2024: 20% with indexation, not computed here", () => {
  test("a gold ETF held over 36 months and sold 22 July 2024 is reported, not taxed", () => {
    const b = gainsBucketsForYear(sold("etf", "gold", "2021-01-10", "2024-07-22"), 2024, "m");
    assert.equal(b.otherLong, 0, "an indexed gain was taxed on its unindexed cost");
    assert.equal(b.unclassified, rupees(50_000));
    assert.match(b.unclassifiedReasons[0]!.reason, /20% with indexation — not computed here/);
  });

  test("the same ETF sold on 23 July 2024 is 12.5% without indexation", () => {
    const t = capitalGainsTaxFor(sold("etf", "gold", "2021-01-10", "2024-07-23"), 2024, "m");
    assert.equal(t.buckets.otherLong, rupees(50_000));
    assert.equal(t.buckets.unclassified, 0);
    assert.equal(t.otherLongTax, rupees(6_250));
  });

  test("before the date a gold ETF needed 36 months, after it 12", () => {
    // Bought 10 January 2022: 30 months by July 2024.
    const before = gainsBucketsForYear(sold("etf", "gold", "2022-01-10", "2024-07-22"), 2024, "m");
    assert.equal(before.slabRated, rupees(50_000));
    const on = gainsBucketsForYear(sold("etf", "gold", "2022-01-10", "2024-07-23"), 2024, "m");
    assert.equal(on.otherLong, rupees(50_000));
  });

  test("taxOnGains will not tax an indexed s112 gain handed to it", () => {
    assert.throws(
      () => taxOnGains(2024, split2024({ otherLong: rupees(100_000) }, {})),
      (e: unknown) => e instanceof Refusal && /with indexation/.test(e.message),
    );
  });
});

describe("a year whose rates are not here is refused", () => {
  test("2023-24 refuses, with the reason", () => {
    const empty = split2024({}, {});
    delete empty.byPeriod;
    for (const call of [
      () => taxOnGains(2023, empty),
      () => gainsBucketsForYear(sold("equity", "equity", "2022-01-10", "2023-07-22"), 2023, "m"),
      () => gainsRulesOn("2023-07-22"),
    ]) {
      assert.throws(call, (e: unknown) =>
        e instanceof Refusal && /capital gains rates for 2023-24 are not in this app/.test(e.message));
    }
  });

  test("so does a year after the newest", () => {
    const empty = split2024({}, {});
    delete empty.byPeriod;
    assert.throws(() => taxOnGains(2027, empty), Refusal);
  });

  test("2024-25 without a split by date is refused, not given either side's rates", () => {
    const whole = split2024({ equityShort: rupees(100_000) }, {});
    delete whole.byPeriod;
    assert.throws(() => taxOnGains(2024, whole), /split by the date of each sale/);
  });

  test("2026-27 still computes", () => {
    const empty = split2024({}, {});
    delete empty.byPeriod;
    const t = taxOnGains(2026, { ...empty, equityShort: rupees(100_000) });
    assert.equal(t.equityShortTax, rupees(20_000));
    assert.ok(t.special, "a one-period year still hands the estimate its rates");
  });

  test("the tax page shows the refusal in place of the gains", () => {
    const html = renderTax({
      fy: 2023, gross: 0 as Paise, ledgerIncome: 0 as Paise,
      deductions: { s80c: 0 as Paise, s80d: 0 as Paise, s80dSenior: false, other: 0 as Paise, hra: null },
      estimate: null, advance: [], gains: null,
      gainsRefusal: "The capital gains rates for 2023-24 are not in this app.",
      staleWarning: null,
      ratesVerifiedOn: "2026-10-22", ratesSource: "https://incometaxindia.gov.in", availableYears: [2026, 2025],
      homeLoan: { lines: [], selfOccupied: 0 as Paise, letOut: 0 as Paise, estimated: false },
      s24bOverride: null, payments: [],
      paid: { tds: 0 as Paise, advance: 0 as Paise, selfAssessment: 0 as Paise },
      settlement: null, advanceThreshold: 10_000_00 as Paise,
    }).value;
    assert.match(html, /Capital gains not computed/);
    assert.match(html, /rates for 2023-24 are not in this app/);
  });

  test("a 2024-25 page names both rates where both sides had a gain", () => {
    const gains = taxOnGains(2024, split2024({ equityShort: rupees(10_000) }, { equityShort: rupees(10_000) }));
    const html = renderTax({
      fy: 2024, gross: 0 as Paise, ledgerIncome: 0 as Paise,
      deductions: { s80c: 0 as Paise, s80d: 0 as Paise, s80dSenior: false, other: 0 as Paise, hra: null },
      estimate: null, advance: [], gains, staleWarning: null,
      ratesVerifiedOn: "2026-10-22", ratesSource: "https://incometaxindia.gov.in", availableYears: [2026, 2025],
      homeLoan: { lines: [], selfOccupied: 0 as Paise, letOut: 0 as Paise, estimated: false },
      s24bOverride: null, payments: [],
      paid: { tds: 0 as Paise, advance: 0 as Paise, selfAssessment: 0 as Paise },
      settlement: null, advanceThreshold: 10_000_00 as Paise,
    }).value;
    assert.match(html, /s111A, 15% sold before .*, 20% sold from /);
  });
});
