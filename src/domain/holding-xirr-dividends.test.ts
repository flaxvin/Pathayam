/**
 * A holding's XIRR, with its dividends in it.
 *
 * WEALTH-25 · A reinvested dividend counted as new money in and a cash one
 * never came back, so ₹10,000 that had paid ₹1,000 of dividends at an
 * unchanged price read "XIRR 0.00%" either way.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordDividend, recordPrice,
  recordSale, listHoldings, viewHolding,
} from "./assets.ts";
import { units, price } from "../portfolio/holdings.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";

const ravi: Actor = { memberId: "m", source: "ui" };

function setup(kind: "mutual-fund" | "equity") {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  const bank = createAccount(db, ravi, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2023-01-01", openingBalance: rupees(100_000),
  }).id;
  const demat = createAssetAccount(db, ravi, { name: "Demat", subtype: "investment" }).id;
  const instrument = findOrCreateInstrument(db, ravi, { name: "Fictional Income Fund", kind }).id;
  recordPurchase(db, ravi, {
    accountId: demat, instrumentId: instrument, tradeDate: "2023-06-01",
    price: price(100), units: units(100),
  });
  recordPrice(db, { instrumentId: instrument, price: price(100), asOf: "2025-06-01", source: "manual" });
  const holding = listHoldings(db, demat)[0]!.id;
  return { db, bank, holding };
}

describe("WEALTH-25 · dividends in a holding's XIRR", () => {
  test("a reinvested dividend is return, not new money", () => {
    const { db, holding } = setup("mutual-fund");
    recordDividend(db, ravi, { holdingId: holding, date: "2024-06-01", amount: rupees(1_000), reinvestAtPrice: price(100) });

    const view = viewHolding(db, holding, "2025-06-01")!;
    assert.equal(view.marketValue, rupees(11_000));
    // ₹10,000 became ₹11,000 in two years (one with a leap day): about √1.1 − 1.
    assert.equal(view.xirr!.toFixed(1), "4.9");
  });

  test("a cash dividend is money back", () => {
    const { db, bank, holding } = setup("equity");
    recordDividend(db, ravi, { holdingId: holding, date: "2024-06-01", amount: rupees(1_000), toAccountId: bank });

    const view = viewHolding(db, holding, "2025-06-01")!;
    assert.equal(view.marketValue, rupees(10_000));
    // ₹1,000 after a year and ₹10,000 after two, for ₹10,000.
    assert.equal(view.xirr!.toFixed(2), "5.12");
  });

  test("a reinvested lot sold since is not cancelled twice", () => {
    const { db, bank, holding } = setup("mutual-fund");
    recordDividend(db, ravi, { holdingId: holding, date: "2024-06-01", amount: rupees(1_000), reinvestAtPrice: price(100) });
    // FIFO sells the June 2023 lot whole: what is held is the ten reinvested
    // units, which cost nothing new — no money in, so no rate to solve.
    recordSale(db, ravi, { holdingId: holding, date: "2025-01-01", units: units(100), price: price(100), toAccountId: bank });

    const view = viewHolding(db, holding, "2025-06-01")!;
    assert.equal(view.marketValue, rupees(1_000));
    assert.equal(view.xirr, null);
  });
});
