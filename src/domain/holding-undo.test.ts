/**
 * Undoing a change to a holding either reverses it or says it cannot.
 *
 * WEALTH-2 · The holding undo handler knew one action, "purchase"; every other
 * one — sale, split, bonus, dividend, return of capital, merger — answered
 * "Reversed a change to the holding" and changed nothing. The event was marked
 * undone (so it could never be undone again), while the lots, the realised gain
 * and the bank credit all stayed where they were.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne } from "../db/db.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale, recordSplit,
  recordDividend, recordReturnOfCapital, listHoldings,
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

const eventOf = (db: ReturnType<typeof freshDb>, action: string) =>
  queryOne<{ id: string }>(db, `SELECT id FROM events WHERE entity = 'holding' AND action = ?`, action)!.id;

const held = (db: ReturnType<typeof freshDb>, holdingId: string) =>
  queryOne<{ u: number }>(db, `SELECT SUM(units) AS u FROM lots WHERE closed_at IS NULL AND holding_id = ?`, holdingId)!.u;

describe("WEALTH-2 · holding undo", () => {
  test("undoing a sale is refused, and the sale is not marked undone", async () => {
    const { db, app, bank, holdingId } = await setup();
    try {
      recordSale(db, actor, {
        holdingId, units: units(4), price: price(150), date: "2025-08-01", toAccountId: bank,
      });
      const id = eventOf(db, "sale");
      const r = await app.post(`/activity/${id}/undo`, {});
      assert.equal(r.status, 422);
      assert.match(await r.text(), /A sale cannot be undone/);
      assert.equal(
        queryOne<{ u: string | null }>(db, `SELECT undone_by_event_id AS u FROM events WHERE id = ?`, id)!.u, null,
        "the log does not claim an undo that did not happen",
      );
      assert.equal(held(db, holdingId), units(6));
    } finally { await app.close(); }
  });

  test("split, bonus, dividend and return of capital are refused the same way", async () => {
    const { db, app, bank, holdingId } = await setup();
    try {
      recordSplit(db, actor, { holdingId, date: "2025-09-01", ratio: 2 });
      recordSplit(db, actor, { holdingId, date: "2025-09-02", ratio: 2, kind: "bonus" });
      recordDividend(db, actor, { holdingId, date: "2025-09-03", amount: rupees(100), toAccountId: bank });
      recordReturnOfCapital(db, actor, { holdingId, date: "2025-09-04", amount: rupees(10) });
      // A bonus is logged as a "split", so there are two of those.
      const events = db.prepare(
        `SELECT id, action FROM events WHERE entity = 'holding' AND action <> 'purchase' ORDER BY seq`,
      ).all() as { id: string; action: string }[];
      assert.deepEqual(events.map((e) => e.action), ["split", "split", "dividend", "return-of-capital"]);
      for (const ev of events) {
        const r = await app.post(`/activity/${ev.id}/undo`, { force: "1" });
        assert.equal(r.status, 422, `${ev.action} undo is refused`);
      }
      assert.equal(held(db, holdingId), units(40), "10 → 20 by the split → 40 by the bonus, untouched");
    } finally { await app.close(); }
  });
});

/*
 * WEALTH-3 · Undoing a purchase deleted the lot and left the bank debit the
 * same call made — the bank ₹1,000 short with nothing to show for it — and,
 * forced past a later sale, deleted the surviving units while the sale stayed.
 */
describe("WEALTH-3 · purchase undo", () => {
  test("takes the payment with it", async () => {
    const { db, app, bank } = await setup();
    try {
      const r = await app.post(`/activity/${eventOf(db, "purchase")}/undo`, {});
      assert.equal(r.status, 303);
      assert.equal(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM lots`)!.n, 0);
      const live = queryOne<{ s: number | null }>(
        db, `SELECT SUM(amount) AS s FROM transactions WHERE account_id = ? AND deleted_at IS NULL`, bank,
      )!.s;
      assert.equal(live ?? 0, 0, "the ₹1,000 debit is gone with the lot");
    } finally { await app.close(); }
  });

  test("is refused once a sale has taken units from the lot, even forced", async () => {
    const { db, app, holdingId } = await setup();
    try {
      recordSale(db, actor, { holdingId, units: units(4), price: price(150), date: "2025-08-01" });
      const r = await app.post(`/activity/${eventOf(db, "purchase")}/undo`, { force: "1" });
      assert.equal(r.status, 422);
      assert.equal(held(db, holdingId), units(6), "the surviving units stay");
    } finally { await app.close(); }
  });
});
