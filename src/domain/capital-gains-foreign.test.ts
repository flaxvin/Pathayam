/**
 * Foreign shares are not Indian listed equity.
 *
 * WEALTH-13 · 111A and 112A are for equity listed in India with STT paid. A US
 * share is long-term only after 24 months, then taxed under s112 at 12.5% with
 * no ₹1.25 lakh exemption, and at slab rates before that. The app records the
 * instrument as international and still filed its gain under 112A.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale, listHoldings,
  classifyInstrument,
} from "./assets.ts";
import { units, price } from "../portfolio/holdings.ts";
import { gainsBucketsForYear } from "./capital-gains-tax.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";

const ravi: Actor = { memberId: "m", source: "ui" };

/** 100 shares at $100 bought on `bought`, sold at $300 on 2025-09-01, both at ₹80 to the dollar. */
function usSale(bought: string, opts: { region?: "domestic" | "international" } = {}) {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  const bank = createAccount(db, ravi, {
    name: "Savings", kind: "budget", subtype: "savings",
    openingDate: "2020-01-01", openingBalance: rupees(5_000_000),
  }).id;
  const demat = createAssetAccount(db, ravi, { name: "Overseas broker", subtype: "investment" }).id;
  const stock = findOrCreateInstrument(db, ravi, {
    name: "Fictional US Corp", kind: "equity", symbol: "FUSC", currency: "USD", provider: "manual",
  }).id;
  if (opts.region) classifyInstrument(db, ravi, stock, { assetClass: "equity", region: opts.region });
  recordPurchase(db, ravi, {
    accountId: demat, instrumentId: stock, tradeDate: bought,
    price: price(100), units: units(100), fromAccountId: bank, fxRate: 80,
  });
  recordSale(db, ravi, {
    holdingId: listHoldings(db, demat)[0]!.id, date: "2025-09-01",
    units: units(100), price: price(300), toAccountId: bank, fxRate: 80,
  });
  return gainsBucketsForYear(db, 2025, "m");
}

describe("WEALTH-13 · a foreign share's gain", () => {
  // $20,000 of gain at ₹80 is ₹16,00,000.
  const gain = rupees(1_600_000);

  test("held 15 months is short-term, at slab rates — not 112A", () => {
    const b = usSale("2024-06-01");
    assert.equal(b.equityLong, 0, "filed under 112A with the ₹1.25 lakh exemption");
    assert.equal(b.equityShort, 0);
    assert.equal(b.slabRated, gain);
  });

  test("held over 24 months is s112, not 112A", () => {
    const b = usSale("2023-06-01");
    assert.equal(b.equityLong, 0);
    assert.equal(b.otherLong, gain);
  });

  test("an instrument marked domestic is still listed equity", () => {
    const b = usSale("2024-06-01", { region: "domestic" });
    assert.equal(b.equityLong, gain);
  });
});
