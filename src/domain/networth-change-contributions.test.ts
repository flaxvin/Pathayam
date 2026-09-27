/**
 * The net-worth change, with money put into holdings taken out of "the market".
 *
 * WEALTH-26 · Moving ₹1,00,000 from the bank into a fund whose price never
 * moved read "−₹1,00,000 saved, ₹1,00,000 from the market" — every SIP month
 * reported its SIP as market gain and as dis-saving, and a redemption into the
 * bank as a market loss.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale, recordPrice, listHoldings,
} from "./assets.ts";
import { snapshotNetWorth, netWorthChange } from "./networth.ts";
import { units, price } from "../portfolio/holdings.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";

const ravi: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  const bank = createAccount(db, ravi, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: rupees(500_000),
  }).id;
  const demat = createAssetAccount(db, ravi, { name: "Demat", subtype: "investment" }).id;
  const fund = findOrCreateInstrument(db, ravi, { name: "Fictional Index Fund", kind: "mutual-fund" }).id;
  return { db, bank, demat, fund };
}

describe("WEALTH-26 · money moved into and out of holdings", () => {
  test("a purchase at an unchanged price is neither saving lost nor market gain", () => {
    const { db, bank, demat, fund } = setup();
    snapshotNetWorth(db, ravi, "2025-03-01");
    recordPurchase(db, ravi, {
      accountId: demat, instrumentId: fund, tradeDate: "2025-03-10",
      price: price(100), units: units(1_000), fromAccountId: bank,
    });
    recordPrice(db, { instrumentId: fund, price: price(100), asOf: "2025-03-31", source: "manual" });
    snapshotNetWorth(db, ravi, "2025-03-31");

    const c = netWorthChange(db, "2025-03-01", "2025-03-31")!;
    assert.equal(c.total, 0);
    assert.equal(c.moneySaved, 0);
    assert.equal(c.marketMovement, 0);
    assert.doesNotMatch(c.reading, /from the market/);
  });

  test("a rise in price is the market; the money put in is not", () => {
    const { db, bank, demat, fund } = setup();
    snapshotNetWorth(db, ravi, "2025-03-01");
    recordPurchase(db, ravi, {
      accountId: demat, instrumentId: fund, tradeDate: "2025-03-10",
      price: price(100), units: units(1_000), fromAccountId: bank,
    });
    recordPrice(db, { instrumentId: fund, price: price(110), asOf: "2025-03-31", source: "manual" });
    snapshotNetWorth(db, ravi, "2025-03-31");

    const c = netWorthChange(db, "2025-03-01", "2025-03-31")!;
    assert.equal(c.marketMovement, rupees(10_000));
    assert.equal(c.moneySaved, 0);
  });

  test("a redemption into the bank, part and whole, is not a market loss", () => {
    const { db, bank, demat, fund } = setup();
    recordPurchase(db, ravi, {
      accountId: demat, instrumentId: fund, tradeDate: "2025-02-10",
      price: price(100), units: units(1_000), fromAccountId: bank,
    });
    recordPurchase(db, ravi, {
      accountId: demat, instrumentId: fund, tradeDate: "2025-03-10",
      price: price(100), units: units(500), fromAccountId: bank,
    });
    recordPrice(db, { instrumentId: fund, price: price(100), asOf: "2025-02-28", source: "manual" });
    snapshotNetWorth(db, ravi, "2025-03-01");

    // Sells all of the February lot and part of the one bought inside the window.
    recordSale(db, ravi, {
      holdingId: listHoldings(db, demat)[0]!.id, date: "2025-03-20",
      units: units(1_200), price: price(100), toAccountId: bank,
    });
    recordPrice(db, { instrumentId: fund, price: price(100), asOf: "2025-03-31", source: "manual" });
    snapshotNetWorth(db, ravi, "2025-03-31");

    const c = netWorthChange(db, "2025-03-01", "2025-03-31")!;
    assert.equal(c.total, 0);
    assert.equal(c.marketMovement, 0);
    assert.equal(c.moneySaved, 0);
  });
});
