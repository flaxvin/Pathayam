/**
 * DEBUG-ASSETS-6 · The net worth change's "from the exchange rate" counts the
 * rate's move on what was held, not on units bought after it moved.
 *
 * The FX movement was the holding's FX gain at the end less its FX gain at
 * the start — but both were worked out on today's lots. Ten US shares held
 * since January at ₹80 to the dollar, ten more bought in March at ₹85, the
 * rupee at 85 by April: the rate moved ₹5 on the first ten ($1,000), so
 * ₹5,000 came from the exchange rate. The start figure priced the March lot
 * as though held in February at 80, a "loss" of ₹5,000 that then reversed,
 * and the page said ₹10,000 came from the rupee — taking it from the market.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordPrice, recordFxRate,
} from "./assets.ts";
import { snapshotNetWorth, netWorthChange } from "./networth.ts";
import { price, units } from "../portfolio/holdings.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m", source: "ui" };

test("a purchase inside the window adds no exchange-rate movement of its own", () => {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  const demat = createAssetAccount(db, actor, { name: "US Demat", subtype: "investment", asOf: "2025-01-01" }).id;
  const inst = findOrCreateInstrument(db, actor, {
    name: "Fictional US Corp", kind: "equity", currency: "USD", provider: "manual",
  });
  recordFxRate(db, { base: "USD", quote: "INR", rate: 80, asOf: "2025-01-10", source: "t" });
  recordFxRate(db, { base: "USD", quote: "INR", rate: 85, asOf: "2025-03-01", source: "t" });
  recordPrice(db, { instrumentId: inst.id, price: price(100), asOf: "2025-01-10", source: "t" });
  recordPrice(db, { instrumentId: inst.id, price: price(100), asOf: "2025-03-01", source: "t" });
  recordPurchase(db, actor, {
    accountId: demat, instrumentId: inst.id, tradeDate: "2025-01-10",
    price: price(100), units: units(10), fxRate: 80,
  });
  snapshotNetWorth(db, actor, "2025-02-01");
  recordPurchase(db, actor, {
    accountId: demat, instrumentId: inst.id, tradeDate: "2025-03-01",
    price: price(100), units: units(10), fxRate: 85,
  });
  snapshotNetWorth(db, actor, "2025-04-01");

  const change = netWorthChange(db, "2025-02-01", "2025-04-01")!;
  assert.equal(change.total, rupees(85_000 + 5_000), "₹85,000 put in, ₹5,000 from the rupee");
  assert.equal(change.fxMovement, rupees(5_000));
  assert.equal(change.marketMovement, 0, "the price never moved");
});

test("a holding first bought inside the window counts the rate's move since its purchase", () => {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  const demat = createAssetAccount(db, actor, { name: "US Demat", subtype: "investment", asOf: "2025-01-01" }).id;
  const inst = findOrCreateInstrument(db, actor, {
    name: "Fictional US Corp", kind: "equity", currency: "USD", provider: "manual",
  });
  recordFxRate(db, { base: "USD", quote: "INR", rate: 80, asOf: "2025-03-01", source: "t" });
  recordFxRate(db, { base: "USD", quote: "INR", rate: 85, asOf: "2025-03-20", source: "t" });
  recordPrice(db, { instrumentId: inst.id, price: price(100), asOf: "2025-03-01", source: "t" });
  snapshotNetWorth(db, actor, "2025-02-01");
  recordPurchase(db, actor, {
    accountId: demat, instrumentId: inst.id, tradeDate: "2025-03-01",
    price: price(100), units: units(10), fxRate: 80,
  });
  snapshotNetWorth(db, actor, "2025-04-01");

  const change = netWorthChange(db, "2025-02-01", "2025-04-01")!;
  assert.equal(change.fxMovement, rupees(5_000), "$1,000 bought at 80, now at 85");
  assert.equal(change.marketMovement, 0);
});
