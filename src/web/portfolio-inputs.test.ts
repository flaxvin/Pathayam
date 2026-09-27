/**
 * WEALTH-39 · The portfolio forms refuse what cannot be right.
 *
 * A price of −50 was saved and the holding counted −₹500 in net worth; 1e30
 * counted 1e31 rupees; "abc" and an unknown kind answered 500; and a purchase
 * filed into the bank was accepted and then never seen again, because only
 * tracking asset accounts are read for holdings.
 *
 * WEBUX-15 · And a price typed with grouping commas or a rupee sign is read,
 * as every amount field reads it — Number("1,250.50") was NaN, a 500.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryAll, queryOne } from "../db/db.ts";
import { rupees } from "../core/money.ts";
import { units, price, parseUnitPrice } from "../portfolio/holdings.ts";
import { createAccount } from "../domain/accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, listHoldings,
} from "../domain/assets.ts";
import { netWorthStatement } from "../domain/networth.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

async function setup() {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  const actor = { memberId: "m", source: "ui" as const };
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: rupees(100_000),
  }).id;
  const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" }).id;
  const inst = findOrCreateInstrument(db, actor, { name: "Fictional Fund", kind: "mutual-fund" }).id;
  recordPurchase(db, actor, {
    accountId: demat, instrumentId: inst, tradeDate: "2025-06-01", price: price(100), units: units(10),
  });
  const holdingId = listHoldings(db, demat)[0]!.id;
  const app = await startTestApp(db, { memberId: "m" });
  return { db, app, bank, demat, holdingId };
}

describe("WEALTH-39 · portfolio form inputs", () => {
  test("a price that is not a positive, sensible number is refused and nothing moves", async () => {
    const { db, app, holdingId } = await setup();
    try {
      const before = netWorthStatement(db).netWorth;
      for (const bad of ["abc", "-50", "0", "1e30"]) {
        const r = await app.post(`/portfolio/${holdingId}/price`, { price: bad, as_of: "2025-09-01" });
        assert.equal(r.status, 422, `price ${bad}`);
      }
      assert.equal(netWorthStatement(db).netWorth, before);
      const ok = await app.post(`/portfolio/${holdingId}/price`, { price: "120.5", as_of: "2025-09-01" });
      assert.equal(ok.status, 303);
    } finally {
      await app.close();
    }
  });

  test("an unknown kind is a sentence, not a 500", async () => {
    const { app, demat } = await setup();
    try {
      const r = await app.post("/portfolio/add", {
        name: "Fictional Thing", kind: "bogus", account_id: demat,
        unit_price: "10", units: "1", trade_date: "2025-06-01",
      });
      assert.equal(r.status, 422);
    } finally {
      await app.close();
    }
  });

  test("a purchase cannot be filed into a bank account", async () => {
    const { db, app, bank } = await setup();
    try {
      const r = await app.post("/portfolio/add", {
        name: "Fictional Other", kind: "equity", account_id: bank,
        unit_price: "10", units: "1", trade_date: "2025-06-01",
      });
      assert.equal(r.status, 422);
      assert.equal(queryAll(db, `SELECT id FROM holdings WHERE account_id = ?`, bank).length, 0);
    } finally {
      await app.close();
    }
  });
});

describe("WEBUX-15 · a unit price with grouping commas or ₹ is read", () => {
  test("parseUnitPrice reads the forms people type and nothing else", () => {
    assert.equal(parseUnitPrice("1,250.50"), 1250.5);
    assert.equal(parseUnitPrice("₹1,250"), 1250);
    assert.equal(parseUnitPrice("Rs. 86.4213"), 86.4213);
    assert.equal(parseUnitPrice("1,25,000"), 125000);
    assert.equal(parseUnitPrice("abc"), null);
    assert.equal(parseUnitPrice("1.2.3"), null);
  });

  test("the price form saves ₹1,250.50", async () => {
    const { db, app, holdingId } = await setup();
    try {
      for (const typed of ["1,250.50", "₹1,250.50"]) {
        const r = await app.post(`/portfolio/${holdingId}/price`, { price: typed, as_of: "2025-09-01" });
        assert.equal(r.status, 303, typed);
      }
      assert.deepEqual(app.failures, []);
      assert.equal(
        queryOne<{ price: number }>(db, `SELECT price FROM prices WHERE as_of = '2025-09-01'`)!.price,
        price(1250.5),
      );
    } finally {
      await app.close();
    }
  });
});
