/**
 * Grandfathering of listed equity bought before 1 February 2018.
 *
 * WEALTH-14 · Under s112A with s55(2)(ac) the cost of such a share is the
 * higher of what was paid and the lower of its value on 31 January 2018 and
 * the sale proceeds. The whole gain since purchase used to be taxed.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale, recordSplit, recordPrice,
  listHoldings,
} from "./assets.ts";
import { units, price } from "../portfolio/holdings.ts";
import { gainsBucketsForYear } from "./capital-gains-tax.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";

const ravi: Actor = { memberId: "m", source: "ui" };

/**
 * 1,000 shares bought 2016-01-04 at ₹100, sold 2025-09-01 at ₹300 (or ₹150
 * a share after a 2-for-1 split in 2020, the same money).
 */
function oldSale(opts: { fmv?: number; split?: boolean }) {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  const bank = createAccount(db, ravi, {
    name: "Savings", kind: "budget", subtype: "savings",
    openingDate: "2015-01-01", openingBalance: rupees(1_000_000),
  }).id;
  const demat = createAssetAccount(db, ravi, { name: "Demat", subtype: "investment" }).id;
  const stock = findOrCreateInstrument(db, ravi, {
    name: "Fictional Old Co", kind: "equity", symbol: "OLDCO", provider: "manual",
  }).id;
  recordPurchase(db, ravi, {
    accountId: demat, instrumentId: stock, tradeDate: "2016-01-04",
    price: price(100), units: units(1_000), fromAccountId: bank,
  });
  if (opts.fmv !== undefined) {
    recordPrice(db, { instrumentId: stock, price: price(opts.fmv), asOf: "2018-01-31", source: "manual" });
  }
  const holdingId = listHoldings(db, demat)[0]!.id;
  if (opts.split) recordSplit(db, ravi, { holdingId, date: "2020-06-01", ratio: 2 });
  recordSale(db, ravi, {
    holdingId, date: "2025-09-01",
    units: units(opts.split ? 2_000 : 1_000), price: price(opts.split ? 150 : 300), toAccountId: bank,
  });
  return gainsBucketsForYear(db, 2025, "m");
}

describe("WEALTH-14 · equity bought before 1 February 2018", () => {
  test("is taxed only on the gain since 31 January 2018", () => {
    // Cost is max(₹100, min(₹250, ₹300)) = ₹250 a share: ₹50,000, not ₹2,00,000.
    const b = oldSale({ fmv: 250 });
    assert.equal(b.equityLong, rupees(50_000));
    assert.equal(b.unclassified, 0);
  });

  test("a value on that day below the cost leaves the cost as it was", () => {
    const b = oldSale({ fmv: 80 });
    assert.equal(b.equityLong, rupees(200_000));
  });

  test("a value above the sale price takes the gain to nil, never to a loss", () => {
    const b = oldSale({ fmv: 400 });
    assert.equal(b.equityLong, 0);
  });

  test("a split after 2018 is allowed for", () => {
    // The price history is halved by the split and the units doubled.
    const b = oldSale({ fmv: 250, split: true });
    assert.equal(b.equityLong, rupees(50_000));
  });

  test("with no price for 31 January 2018 it is reported, not taxed in full", () => {
    const b = oldSale({});
    assert.equal(b.equityLong, 0);
    assert.equal(b.unclassified, rupees(200_000));
    assert.match(b.unclassifiedReasons[0]!.reason, /before 1 February 2018/);
  });
});
