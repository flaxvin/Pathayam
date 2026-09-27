/**
 * "Add to it" and "Sell" are for assets valued by hand.
 *
 * WEALTH-27 · Both took any visible account. Adding ₹10,000 to a fixed deposit
 * stated its value as ₹10,000, overriding the ₹1,00,000 balance it is worth;
 * "Sell" on a demat closed it with its shares in it, and on the bank closed
 * the bank.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import { todayIST } from "../core/dates.ts";
import { createAccount, getAccount } from "../domain/accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, latestValuation,
} from "../domain/assets.ts";
import { units, price } from "../portfolio/holdings.ts";
import { netWorthStatement } from "../domain/networth.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

const ravi = { memberId: "m", source: "ui" as const };

async function setup() {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  const bank = createAccount(db, ravi, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: rupees(500_000),
  }).id;
  const fd = createAccount(db, ravi, {
    name: "Fictional FD", kind: "tracking", subtype: "fixed-deposit",
    openingDate: "2025-01-01", openingBalance: rupees(100_000),
  }).id;
  const demat = createAssetAccount(db, ravi, { name: "Demat", subtype: "investment" }).id;
  const stock = findOrCreateInstrument(db, ravi, { name: "Fictional Stock", kind: "equity" }).id;
  recordPurchase(db, ravi, {
    accountId: demat, instrumentId: stock, tradeDate: "2025-01-01", price: price(100), units: units(100),
  });
  const gold = createAssetAccount(db, ravi, {
    name: "Gold coins", subtype: "commodity", openingValue: rupees(50_000), asOf: "2025-01-01",
  }).id;
  const app = await startTestApp(db, { memberId: "m" });
  return { db, app, bank, fd, demat, gold };
}

describe("WEALTH-27 · add to / sell a hand-valued asset", () => {
  test("a fixed deposit is refused, and keeps its balance in net worth", async () => {
    const { db, app, bank, fd } = await setup();
    try {
      const before = netWorthStatement(db).netWorth;
      const r = await app.post(`/portfolio/asset/${fd}/add`, { spent: "10000", on: todayIST(), paid_from: bank });
      assert.equal(r.status, 422);
      assert.equal(latestValuation(db, fd), null);
      assert.equal(netWorthStatement(db).netWorth, before);
      assert.equal((await app.get(`/portfolio/asset/${fd}/add`)).status, 422);
    } finally {
      await app.close();
    }
  });

  test("a demat with shares in it, and the bank, cannot be sold and closed", async () => {
    const { db, app, bank, demat } = await setup();
    try {
      for (const id of [demat, bank]) {
        const r = await app.post(`/portfolio/asset/${id}/dispose`, { proceeds: "0", on: todayIST(), remaining: "" });
        assert.ok(r.status === 404 || r.status === 422, `status ${r.status}`);
        assert.equal(getAccount(db, id)?.closed_at, null);
      }
      assert.equal((await app.post(`/portfolio/asset/${bank}/dispose`, { proceeds: "0", on: todayIST() })).status, 404);
    } finally {
      await app.close();
    }
  });

  test("gold valued by hand can still be added to and sold", async () => {
    const { db, app, bank, gold } = await setup();
    try {
      const add = await app.post(`/portfolio/asset/${gold}/add`, { spent: "10000", on: todayIST(), paid_from: bank });
      assert.equal(add.status, 303);
      assert.equal(latestValuation(db, gold)?.value, rupees(60_000));
      const sell = await app.post(`/portfolio/asset/${gold}/dispose`, {
        proceeds: "60000", on: todayIST(), into_account: bank, remaining: "",
      });
      assert.equal(sell.status, 303);
      assert.notEqual(getAccount(db, gold)?.closed_at, null);
    } finally {
      await app.close();
    }
  });
});
