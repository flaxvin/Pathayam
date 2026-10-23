/**
 * DEBUG-TAX-3 · Holding periods for units: listed ETFs and older debt funds.
 *
 * Since 23 July 2024 every security listed in India, units included, is
 * long-term after 12 months (s2(42A); incometaxindia.gov.in "Tax on sale of
 * shares"). From AY 2026-27 a "specified mutual fund" under s50AA is one with
 * more than 65% in debt (Finance (No. 2) Act 2024), so a gold ETF is outside
 * it. And s50AA only ever caught fund units bought on or after 1 April 2023.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import { nowIST, type IsoDate } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale, listHoldings,
  classifyInstrument, type AssetClass, type InstrumentKind,
} from "./assets.ts";
import { units, price } from "../portfolio/holdings.ts";
import { gainsBucketsForYear } from "./capital-gains-tax.ts";

const actor: Actor = { memberId: "m", source: "ui" };

/** ₹1,00,000 in at ₹100, out at ₹150: a ₹50,000 gain. Returns the FY's buckets. */
function sell(kind: InstrumentKind, cls: AssetClass, bought: IsoDate, sold: IsoDate, fy: number) {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`, "m", "f@e.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Savings", kind: "budget", subtype: "savings",
    openingDate: "2020-01-01", openingBalance: rupees(1_000_000),
  }).id;
  const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" }).id;
  const inst = findOrCreateInstrument(db, actor, { name: "Fund", kind, symbol: "X", provider: "manual" }).id;
  classifyInstrument(db, actor, inst, { assetClass: cls });
  recordPurchase(db, actor, {
    accountId: demat, instrumentId: inst, tradeDate: bought,
    price: price(100), units: units(1_000), fromAccountId: bank,
  });
  recordSale(db, actor, {
    holdingId: listHoldings(db, demat)[0]!.id, date: sold,
    units: units(1_000), price: price(150), toAccountId: bank,
  });
  return gainsBucketsForYear(db, fy, "m");
}

describe("a gold ETF is a listed unit", () => {
  test("held 18 months and sold in 2025-26, it is long-term under s112", () => {
    const b = sell("etf", "gold", "2024-05-10", "2025-11-20", 2025);
    assert.equal(b.otherLong, rupees(50_000));
    assert.equal(b.slabRated, 0);
  });

  test("held exactly 12 months it is still short-term", () => {
    const b = sell("etf", "gold", "2024-11-20", "2025-11-20", 2025);
    assert.equal(b.slabRated, rupees(50_000));
  });

  test("bought after 1 April 2023 and sold before 1 April 2025 it was a specified fund", () => {
    const b = sell("etf", "gold", "2023-05-10", "2025-03-20", 2024);
    assert.equal(b.slabRated, rupees(50_000));
  });

  test("a gold fund of funds is not listed, so it still needs 24 months", () => {
    const b = sell("mutual-fund", "gold", "2024-05-10", "2025-11-20", 2025);
    assert.equal(b.slabRated, rupees(50_000));
  });
});

describe("a debt fund bought before 1 April 2023 is outside s50AA", () => {
  test("held over 24 months it is long-term under s112", () => {
    const b = sell("mutual-fund", "debt", "2021-06-01", "2025-08-01", 2025);
    assert.equal(b.otherLong, rupees(50_000));
    assert.equal(b.slabRated, 0);
  });

  test("bought from 1 April 2023 it is slab-rated however long it is held", () => {
    const b = sell("mutual-fund", "debt", "2023-04-01", "2026-08-01", 2026);
    assert.equal(b.slabRated, rupees(50_000));
  });

  test("a bond's listing is unknown, so it stays slab-rated", () => {
    const b = sell("bond", "debt", "2021-06-01", "2025-08-01", 2025);
    assert.equal(b.slabRated, rupees(50_000));
  });
});
