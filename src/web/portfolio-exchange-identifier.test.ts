/**
 * PRICES-1 · A share's or ETF's ISIN and exchange symbol, asked on the
 * add-holding form and editable on its holding page, so the evening refresh
 * can price it from the exchanges' closing files without a key.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne } from "../db/db.ts";
import { rupees } from "../core/money.ts";
import { undoEvent } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createAssetAccount, listHoldings } from "../domain/assets.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

async function setup() {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  const actor = { memberId: "m", source: "ui" as const };
  createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2024-01-01", openingBalance: rupees(500_000),
  });
  const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" }).id;
  const app = await startTestApp(db, { memberId: "m" });
  return { db, app, demat, actor };
}

const buy = (demat: string, extra: Record<string, string>) => ({
  step: "create", account_id: demat, amount: "10000", unit_price: "100", trade_date: "2025-09-01", ...extra,
});

const idsOf = (db: ReturnType<typeof freshDb>, name: string) =>
  queryOne<{ isin: string | null; symbol: string | null; provider: string }>(
    db, `SELECT isin, symbol, provider FROM instruments WHERE name = ?`, name,
  )!;

describe("PRICES-1 · the add-holding form", () => {
  test("asks for an ISIN and an NSE symbol or BSE code, and stores them", async () => {
    const { db, app, demat } = await setup();
    try {
      const page = await (await app.get("/portfolio/add")).text();
      assert.match(page, /name="isin"/);
      assert.match(page, /NSE symbol or BSE code/);

      const r = await app.post("/portfolio/add", buy(demat, {
        name: "Reliance", kind: "equity", isin: " ine002a01018 ", symbol: "reliance",
      }));
      assert.equal(r.status, 303);
      assert.deepEqual({ ...idsOf(db, "Reliance") }, { isin: "INE002A01018", symbol: "RELIANCE", provider: "manual" });
    } finally {
      await app.close();
    }
  });

  test("an ISIN that is not one is refused before anything is made", async () => {
    const { db, app, demat } = await setup();
    try {
      const r = await app.post("/portfolio/add", buy(demat, { name: "Typo Co", kind: "equity", isin: "RELIANCE" }));
      assert.notEqual(r.status, 303);
      assert.match(await r.text(), /not an ISIN/);
      assert.equal(queryOne(db, `SELECT 1 FROM instruments WHERE name = 'Typo Co'`), null);
    } finally {
      await app.close();
    }
  });
});

describe("PRICES-1 · the holding page", () => {
  test("says where the price comes from, saves the identifiers, and the change can be undone", async () => {
    const { db, app, demat, actor } = await setup();
    try {
      await app.post("/portfolio/add", buy(demat, { name: "Nifty BeES", kind: "etf" }));
      const holding = listHoldings(db, demat)[0]!;
      const before = await (await app.get(`/portfolio/${holding.id}`)).text();
      assert.match(before, /Where its price comes from/);
      assert.match(before, /Add its ISIN or NSE symbol/);

      const r = await app.post(`/portfolio/instrument/${holding.instrument_id}/identifier`, {
        holding_id: holding.id, isin: "INF204KB14I2", symbol: "NSE:NIFTYBEES",
      });
      assert.equal(r.status, 303);
      assert.equal(idsOf(db, "Nifty BeES").isin, "INF204KB14I2");
      assert.equal(idsOf(db, "Nifty BeES").symbol, "NSE:NIFTYBEES");
      const after = await (await app.get(`/portfolio/${holding.id}`)).text();
      assert.match(after, /Priced each evening from NSE/);

      const event = queryOne<{ id: string }>(
        db, `SELECT id FROM events WHERE entity = 'instrument' AND action = 'identify'`,
      )!;
      assert.equal(undoEvent(db, event.id, actor, { force: true }).ok, true);
      assert.equal(idsOf(db, "Nifty BeES").isin, null);
    } finally {
      await app.close();
    }
  });

  test("a symbol that is not one, an ISIN another instrument has, and a fund are refused", async () => {
    const { db, app, demat } = await setup();
    try {
      await app.post("/portfolio/add", buy(demat, { name: "Reliance", kind: "equity", isin: "INE002A01018" }));
      await app.post("/portfolio/add", buy(demat, { name: "Other Co", kind: "equity" }));
      await app.post("/portfolio/add", buy(demat, { name: "A Fund", kind: "mutual-fund" }));
      const other = queryOne<{ id: string }>(db, `SELECT id FROM instruments WHERE name = 'Other Co'`)!.id;
      const fund = queryOne<{ id: string }>(db, `SELECT id FROM instruments WHERE name = 'A Fund'`)!.id;

      const bad = await app.post(`/portfolio/instrument/${other}/identifier`, { symbol: "not a symbol!" });
      assert.match(await bad.text(), /not an exchange symbol/);
      const taken = await app.post(`/portfolio/instrument/${other}/identifier`, { isin: "INE002A01018" });
      assert.match(await taken.text(), /Reliance already has that ISIN/);
      const notShare = await app.post(`/portfolio/instrument/${fund}/identifier`, { symbol: "RELIANCE" });
      assert.match(await notShare.text(), /Only a share or an ETF/);
      assert.equal(idsOf(db, "Other Co").isin, null);
    } finally {
      await app.close();
    }
  });
});
