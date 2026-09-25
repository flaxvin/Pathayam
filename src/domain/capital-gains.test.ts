/**
 * B88 · Realised gains, by financial year and holding period.
 *
 * The FIFO engine has always computed a per-parcel holding period — R25.5 says
 * it is "exposed so long-term versus short-term is visible to the user" — and
 * `recordSale` then wrote a single aggregate gain and dropped the rest. By the
 * time anyone asked, the lots had been closed and rewritten, so the answer was
 * not merely missing, it was unrecoverable.
 *
 * A sale of units accumulated over four years is one number with four different
 * answers inside it. These tests are about keeping them apart.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale, listHoldings,
} from "./assets.ts";
import { units as toUnits, price as toPrice } from "../portfolio/holdings.ts";
import { capitalGainsByYear } from "./reports.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function portfolio() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2020-01-01", openingBalance: rupees(1000000),
  }).id;
  const demat = createAssetAccount(db, actor, { name: "Zerodha", subtype: "investment" });
  const fund = findOrCreateInstrument(db, actor, {
    name: "Nifty Index", kind: "mutual-fund", symbol: "1", provider: "manual",
  });
  return { db, bank, demat: demat.id, fund: fund.id };
}

describe("B88 · a sale keeps what it consumed", () => {
  test("parcels bought years apart are reported separately, not as one gain", () => {
    const { db, bank, demat, fund } = portfolio();

    // Two purchases: one long before the sale, one weeks before it.
    recordPurchase(db, actor, {
      accountId: demat, instrumentId: fund, tradeDate: "2023-04-10",
      price: toPrice(100), units: toUnits(100), fromAccountId: bank,
    });
    recordPurchase(db, actor, {
      accountId: demat, instrumentId: fund, tradeDate: "2025-11-01",
      price: toPrice(200), units: toUnits(100), fromAccountId: bank,
    });

    const holding = listHoldings(db, demat)[0]!;
    // FIFO takes the 2023 parcel first, then part of the 2025 one.
    recordSale(db, actor, {
      holdingId: holding.id, date: "2025-12-01",
      units: toUnits(150), price: toPrice(250), toAccountId: bank,
    });

    const years = capitalGainsByYear(db);
    assert.equal(years.length, 1);
    const year = years[0]!;

    assert.equal(year.parcels.length, 2, "both parcels are accounted for");
    assert.equal(year.unknownPeriod, 0, "nothing fell through to unknown");

    const long = year.parcels.find((p) => p.acquiredOn === "2023-04-10")!;
    const short = year.parcels.find((p) => p.acquiredOn === "2025-11-01")!;
    assert.equal(long.longTerm, true, "held over two years");
    assert.equal(short.longTerm, false, "held one month");
    assert.ok(long.holdingPeriodDays > 365 && short.holdingPeriodDays < 365);

    // And the split is not a relabelling of one aggregate.
    assert.ok(year.longTerm > 0 && year.shortTerm > 0);
    assert.equal(
      year.longTerm + year.shortTerm,
      year.parcels.reduce((sum, p) => sum + p.gain, 0),
    );
    db.close();
  });

  test("sales land in the Indian financial year, not the calendar year", () => {
    const { db, bank, demat, fund } = portfolio();
    recordPurchase(db, actor, {
      accountId: demat, instrumentId: fund, tradeDate: "2022-01-10",
      price: toPrice(100), units: toUnits(200), fromAccountId: bank,
    });
    const holding = listHoldings(db, demat)[0]!;

    // 20 March and 20 April are one month apart and in different FYs.
    recordSale(db, actor, {
      holdingId: holding.id, date: "2025-03-20", units: toUnits(50),
      price: toPrice(150), toAccountId: bank,
    });
    recordSale(db, actor, {
      holdingId: holding.id, date: "2025-04-20", units: toUnits(50),
      price: toPrice(160), toAccountId: bank,
    });

    const years = capitalGainsByYear(db);
    assert.deepEqual(years.map((y) => y.fy).sort(), [2024, 2025]);
    db.close();
  });

  test("a loss is reported as a loss, not dropped", () => {
    const { db, bank, demat, fund } = portfolio();
    recordPurchase(db, actor, {
      accountId: demat, instrumentId: fund, tradeDate: "2025-06-01",
      price: toPrice(300), units: toUnits(100), fromAccountId: bank,
    });
    const holding = listHoldings(db, demat)[0]!;
    recordSale(db, actor, {
      holdingId: holding.id, date: "2025-09-01", units: toUnits(100),
      price: toPrice(200), toAccountId: bank,
    });

    const year = capitalGainsByYear(db)[0]!;
    assert.ok(year.shortTerm < 0, `expected a loss, got ${year.shortTerm}`);
    db.close();
  });

  test("a sale recorded before parcels were kept is flagged, not guessed", () => {
    const { db, bank, demat, fund } = portfolio();
    recordPurchase(db, actor, {
      accountId: demat, instrumentId: fund, tradeDate: "2025-06-01",
      price: toPrice(100), units: toUnits(100), fromAccountId: bank,
    });
    const holding = listHoldings(db, demat)[0]!;
    recordSale(db, actor, {
      holdingId: holding.id, date: "2025-09-01", units: toUnits(50),
      price: toPrice(150), toAccountId: bank,
    });
    // What an older row looks like: a gain, and no breakdown.
    execute(db, `UPDATE holding_events SET detail_json = NULL WHERE kind = 'sale'`);

    const year = capitalGainsByYear(db)[0]!;
    assert.equal(year.parcels.length, 0);
    assert.ok(year.unknownPeriod > 0, "the gain is still reported, under unknown");
    assert.equal(year.shortTerm, 0, "and never assumed into a bucket");
    db.close();
  });

  /*
   * Per-parcel proceeds must add up to the sale.
   *
   * Three 1-unit purchases, sold together at ₹10 with ₹0.01 of charges:
   * proceeds = 3 × ₹10 − ₹0.01 = ₹29.99 = 2,999 paise. Each parcel's share was
   * rounded on its own — 2,999 / 3 = 999.67 → 1,000 paise, three times — so the
   * stored parcels said ₹30.00 was received, one paisa more than the money
   * that landed, and the gains statement's gain was a paisa larger than the
   * sale's. Now: 999 + 999 + 1,001 = 2,999, the remainder on the last parcel.
   */
  test("parcel proceeds sum exactly to the sale's proceeds", () => {
    const { db, bank, demat, fund } = portfolio();
    for (const day of ["2024-01-10", "2024-02-10", "2024-03-10"]) {
      recordPurchase(db, actor, {
        accountId: demat, instrumentId: fund, tradeDate: day,
        price: toPrice(8), units: toUnits(1), fromAccountId: bank,
      });
    }
    const holding = listHoldings(db, demat)[0]!;
    const sale = recordSale(db, actor, {
      holdingId: holding.id, date: "2025-06-01", units: toUnits(3),
      price: toPrice(10), charges: 1, toAccountId: bank,
    });
    assert.equal(sale.proceeds, 2999);

    const row = db.prepare(
      `SELECT amount, realised_gain, detail_json FROM holding_events WHERE kind = 'sale'`,
    ).get() as { amount: number; realised_gain: number; detail_json: string };
    const parcels = JSON.parse(row.detail_json).parcels as { proceeds: number; cost: number }[];
    assert.equal(parcels.length, 3);
    assert.equal(parcels.reduce((s, p) => s + p.proceeds, 0), row.amount, "parcels sum to the sale");
    assert.deepEqual(parcels.map((p) => p.proceeds), [999, 999, 1001]);

    const year = capitalGainsByYear(db)[0]!;
    assert.equal(
      year.parcels.reduce((s, p) => s + p.gain, 0), row.realised_gain,
      "the statement's gain is the sale's gain, to the paisa",
    );
    db.close();
  });

  test("no sales, no report", () => {
    const { db } = portfolio();
    assert.deepEqual(capitalGainsByYear(db), []);
    db.close();
  });
});
