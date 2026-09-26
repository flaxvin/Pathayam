/**
 * WEALTH-1 · A foreign trade converts at the trade-date rate, or is refused.
 *
 * Both portfolio forms offered "$ US dollar" and never asked for a rate, and
 * nothing looked one up: $1,000 of a US stock (10 units at $100) went into the
 * books — and out of the bank — as ₹1,000, and selling half of it credited
 * ₹500. The holding page then valued the same units at today's rate and showed
 * an ₹82,000 unrealised gain that never happened.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryAll, queryOne } from "../db/db.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordFxRate,
  listHoldings, viewHolding,
} from "./assets.ts";
import { price, units } from "../portfolio/holdings.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m", source: "ui" };

async function setup() {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(500_000),
  }).id;
  const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" }).id;
  const app = await startTestApp(db, { memberId: "m" });
  return { db, app, bank, demat };
}

const buy = (demat: string, bank: string, extra: Record<string, string> = {}) => ({
  step: "create", name: "Fictional US Corp", kind: "equity", currency: "USD",
  account_id: demat, amount: "1000", unit_price: "100", trade_date: "2025-06-02",
  from_account_id: bank, ...extra,
});

describe("WEALTH-1 · foreign trades", () => {
  test("with no rate given and none stored, the purchase is refused, not booked at 1", async () => {
    const { db, app, bank, demat } = await setup();
    try {
      const r = await app.post("/portfolio/add", buy(demat, bank));
      assert.equal(r.status, 422);
      assert.match(await r.text(), /no USD→INR rate/);
      assert.deepEqual(queryAll(db, `SELECT id FROM lots`), []);
      assert.deepEqual(queryAll(db, `SELECT id FROM transactions WHERE account_id = ?`, bank), []);
    } finally { await app.close(); }
  });

  test("the stored trade-date rate converts the cost and the bank debit; the sale's proceeds likewise", async () => {
    const { db, app, bank, demat } = await setup();
    try {
      recordFxRate(db, { base: "USD", quote: "INR", rate: 83, asOf: "2025-06-02", source: "t" });
      const r = await app.post("/portfolio/add", buy(demat, bank));
      assert.equal(r.status, 303);
      const lot = queryOne<{ cost: number; fx_rate: number }>(db, `SELECT cost, fx_rate FROM lots`)!;
      assert.equal(lot.cost, rupees(83_000));
      assert.equal(lot.fx_rate, 83);
      const paid = queryOne<{ amount: number }>(db, `SELECT amount FROM transactions WHERE account_id = ?`, bank)!;
      assert.equal(paid.amount, -rupees(83_000), "₹83,000 left the bank, not ₹1,000");

      const h = listHoldings(db, demat)[0]!;
      const v = viewHolding(db, h.id, "2025-06-03")!;
      assert.equal(v.unrealisedGain, 0, "no gain appears from the exchange rate alone");

      // Sold at the same $100 with the rupee at 84: ₹42,000 in, ₹41,500 of cost.
      const s = await app.post(`/portfolio/${h.id}/sell`, {
        units: "5", price: "100", date: "2025-06-03", to_account_id: bank, fx_rate: "84",
      });
      assert.equal(s.status, 303);
      const sale = queryOne<{ amount: number; realised_gain: number }>(
        db, `SELECT amount, realised_gain FROM holding_events WHERE kind = 'sale'`,
      )!;
      assert.equal(sale.amount, rupees(42_000));
      assert.equal(sale.realised_gain, rupees(500));
    } finally { await app.close(); }
  });

  test("the rate typed on the form wins over the stored one; a nonsense rate is refused", async () => {
    const { db, app, bank, demat } = await setup();
    try {
      recordFxRate(db, { base: "USD", quote: "INR", rate: 83, asOf: "2025-06-02", source: "t" });
      assert.equal((await app.post("/portfolio/add", buy(demat, bank, { fx_rate: "-2" }))).status, 422);
      assert.equal((await app.post("/portfolio/add", buy(demat, bank, { fx_rate: "85.5" }))).status, 303);
      assert.equal(queryOne<{ cost: number }>(db, `SELECT cost FROM lots`)!.cost, rupees(85_500));
    } finally { await app.close(); }
  });

  test("the sale preview says a rate is missing instead of failing", async () => {
    const { db, app, demat } = await setup();
    try {
      const inst = findOrCreateInstrument(db, actor, {
        name: "Fictional US Corp", kind: "equity", currency: "USD", provider: "manual",
      });
      recordPurchase(db, actor, {
        accountId: demat, instrumentId: inst.id, tradeDate: "2025-06-02",
        price: price(100), units: units(10), fxRate: 83,
      });
      const h = listHoldings(db, demat)[0]!;
      const r = await app.get(`/portfolio/${h.id}/sell?units=1&price=100`);
      assert.equal(r.status, 200);
      const body = await r.text();
      assert.match(body, /Rupees per USD/);
      assert.match(body, /no USD→INR rate/);
    } finally { await app.close(); }
  });

  test("a rupee instrument is untouched: no rate asked for, none needed", async () => {
    const { db, app, bank, demat } = await setup();
    try {
      const r = await app.post("/portfolio/add", buy(demat, bank, { currency: "INR" }));
      assert.equal(r.status, 303);
      assert.equal(queryOne<{ cost: number }>(db, `SELECT cost FROM lots`)!.cost, rupees(1_000));
    } finally { await app.close(); }
  });
});
