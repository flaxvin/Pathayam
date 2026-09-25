/**
 * Buying and selling units refuses nonsense with a sentence, never a 500.
 *
 * What the auditor sent to POST /portfolio/:id/sell against a holding of 10
 * units bought 2025-06-01 at ₹100:
 *   11 units          → previewSale's RangeError, a 500
 *   −5 units          → a "sale" that ADDED five units
 *   0 units           → a sale of nothing, recorded
 *   dated 2025-05-01  → a sale a month before the purchase, negative holding period
 *   price −100        → negative proceeds booked as a sale
 *   charges ₹500 on a ₹1 sale → −₹499 of "proceeds" into the bank
 * and to POST /portfolio/add, 0 or −5 units → an empty lot, or a negative
 * one whose negative cost paid money INTO the bank account.
 * Each is now a 422 with a sentence, and nothing is written.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryAll } from "../db/db.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, listHoldings,
} from "../domain/assets.ts";
import { price, units } from "../portfolio/holdings.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

const actor: Actor = { memberId: "m", source: "ui" };

async function setup() {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(500_000),
  }).id;
  const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" }).id;
  const inst = findOrCreateInstrument(db, actor, {
    name: "Fictional Co", kind: "equity", symbol: "Q", provider: "manual",
  }).id;
  recordPurchase(db, actor, {
    accountId: demat, instrumentId: inst, tradeDate: "2025-06-01",
    price: price(100), units: units(10), fromAccountId: bank,
  });
  const holdingId = listHoldings(db, demat)[0]!.id;
  const app = await startTestApp(db, { memberId: "m" });
  return { db, app, bank, demat, holdingId };
}

describe("portfolio input", () => {
  test("impossible sales are refused, and none is recorded", async () => {
    const { db, app, holdingId } = await setup();
    try {
      const cases: [string, Record<string, string>][] = [
        ["more than is held", { units: "11", price: "100", date: "2025-07-01" }],
        ["negative units", { units: "-5", price: "100", date: "2025-07-01" }],
        ["zero units", { units: "0", price: "100", date: "2025-07-01" }],
        ["before the purchase", { units: "1", price: "100", date: "2025-05-01" }],
        ["a negative price", { units: "1", price: "-100", date: "2025-07-02" }],
        ["charges above the sale", { units: "1", price: "1", date: "2025-07-03", charges: "500" }],
      ];
      for (const [label, body] of cases) {
        const r = await app.post(`/portfolio/${holdingId}/sell`, body);
        await r.text();
        assert.equal(r.status, 422, `${label}: expected a refusal, got ${r.status}`);
      }
      assert.deepEqual(app.failures, [], "a 500 was raised");
      assert.equal(
        queryAll(db, `SELECT 1 FROM holding_events WHERE kind = 'sale'`).length, 0,
        "a refused sale was recorded anyway",
      );
      const lots = queryAll<{ units: number }>(db, `SELECT units FROM lots WHERE closed_at IS NULL`);
      assert.equal(lots.reduce((t, l) => t + l.units, 0), units(10), "the holding changed");
    } finally {
      await app.close();
    }
  });

  test("a purchase of zero or negative units is refused", async () => {
    const { db, app, bank, demat } = await setup();
    try {
      for (const u of ["0", "-5"]) {
        const r = await app.post("/portfolio/add", {
          name: "Fictional Co", kind: "equity", symbol: "Q",
          account_id: demat, trade_date: "2025-06-02", unit_price: "100", units: u,
          from_account_id: bank,
        });
        await r.text();
        assert.equal(r.status, 422, `${u} units: expected a refusal, got ${r.status}`);
      }
      assert.deepEqual(app.failures, []);
      assert.equal(queryAll(db, `SELECT 1 FROM lots`).length, 1, "a refused purchase made a lot");
    } finally {
      await app.close();
    }
  });
});
