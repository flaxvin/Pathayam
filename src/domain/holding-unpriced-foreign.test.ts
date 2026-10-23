/**
 * DEBUG-ASSETS-1 · A foreign holding with no price yet is worth what it cost,
 * not its cost multiplied by the exchange rate a second time.
 *
 * With no quote, viewHolding valued the units at their average *cost* — which
 * is already in rupees — and then converted that at the USD→INR rate. $1,000
 * of a US share bought at 83 (₹83,000) showed a market value of ₹68,89,000
 * on the holding page, in net worth and in the FIRE corpus, while the dated
 * net worth for the same holding (holdingValueOn) said ₹83,000.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordFxRate,
  listHoldings, viewHolding, holdingValueOn,
} from "./assets.ts";
import { netWorthStatement } from "./networth.ts";
import { price, units } from "../portfolio/holdings.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m", source: "ui" };

test("an unpriced foreign holding is carried at its rupee cost, once", () => {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  const demat = createAssetAccount(db, actor, { name: "US Demat", subtype: "investment" }).id;
  const inst = findOrCreateInstrument(db, actor, {
    name: "Fictional US Corp", kind: "equity", currency: "USD", provider: "manual",
  });
  recordFxRate(db, { base: "USD", quote: "INR", rate: 83, asOf: "2025-06-02", source: "t" });
  // No recordPrice: an import, or a merger into a new scheme, leaves none.
  recordPurchase(db, actor, {
    accountId: demat, instrumentId: inst.id, tradeDate: "2025-06-02",
    price: price(100), units: units(10), fxRate: 83,
  });
  const h = listHoldings(db, demat)[0]!;

  const view = viewHolding(db, h.id, "2025-06-03")!;
  assert.equal(view.quote, null);
  assert.equal(view.costBasis, rupees(83_000));
  assert.equal(view.marketValue, rupees(83_000), "₹83,000, not ₹83,000 × 83");
  assert.equal(view.unrealisedGain, 0);
  assert.equal(holdingValueOn(db, h.id, "2025-06-03")!.value, view.marketValue,
    "the live and dated valuations agree");

  const investments = netWorthStatement(db).assetGroups.find((g) => g.name === "Investments")!;
  assert.equal(investments.total, rupees(83_000));
});
