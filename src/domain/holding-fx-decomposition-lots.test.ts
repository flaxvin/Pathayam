/**
 * DEBUG-ASSETS-5 · A foreign holding bought at several rates splits its gain
 * against what the lots actually cost.
 *
 * The FX/price decomposition took the *first* lot's rate for every unit. Ten
 * shares bought at ₹70 to the dollar and ten more at ₹90, all at $100 and
 * still at $100 with the rupee at 90, cost ₹1,60,000 and are worth ₹1,80,000:
 * a ₹20,000 gain, all of it the exchange rate. The holding page said
 * "₹40,000 from the exchange rate, totalling ₹40,000" beside an unrealised
 * gain of ₹20,000 — the second lot's cost was counted at the first's rate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordPrice, recordFxRate,
  listHoldings, viewHolding,
} from "./assets.ts";
import { price, units } from "../portfolio/holdings.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m", source: "ui" };

test("the decomposition's total is the holding's unrealised gain when lots were bought at different rates", () => {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  const demat = createAssetAccount(db, actor, { name: "US Demat", subtype: "investment" }).id;
  const inst = findOrCreateInstrument(db, actor, {
    name: "Fictional US Corp", kind: "equity", currency: "USD", provider: "manual",
  });
  recordPurchase(db, actor, {
    accountId: demat, instrumentId: inst.id, tradeDate: "2024-01-10",
    price: price(100), units: units(10), fxRate: 70,
  });
  recordPurchase(db, actor, {
    accountId: demat, instrumentId: inst.id, tradeDate: "2025-01-10",
    price: price(100), units: units(10), fxRate: 90,
  });
  recordPrice(db, { instrumentId: inst.id, price: price(100), asOf: "2025-06-02", source: "t" });
  recordFxRate(db, { base: "USD", quote: "INR", rate: 90, asOf: "2025-06-02", source: "t" });

  const view = viewHolding(db, listHoldings(db, demat)[0]!.id, "2025-06-02")!;
  assert.equal(view.costBasis, rupees(160_000));
  assert.equal(view.unrealisedGain, rupees(20_000));
  const d = view.decomposition!;
  assert.equal(d.costInBase, rupees(160_000), "what the lots cost, each at its own rate");
  assert.equal(d.totalGain, view.unrealisedGain);
  assert.equal(d.assetGain, 0, "the price never moved");
  assert.equal(d.fxGain, rupees(20_000));
});
