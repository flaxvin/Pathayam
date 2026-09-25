/**
 * A bonus issue is not a split.
 *
 * The defect: `recordSplit(kind: "bonus")` re-divided every lot exactly as a
 * split does — units doubled, per-unit cost halved, dates untouched. Under
 * section 55(2)(aa) bonus shares cost NIL and are acquired on the allotment
 * date; the originals keep their cost and date.
 *
 * The arithmetic, with a 1:1 bonus (ratio 2):
 *   bought 100 at ₹1,000 on 2023-01-02            cost ₹1,00,000
 *   bonus of 100 on 2025-06-02                     cost ₹0, held from 2025-06-02
 *   sell 100 at ₹600 on 2025-09-01 → FIFO takes the originals:
 *       60,000 − 1,00,000 = −₹40,000, long-term (held > 12 months)
 *   sell 100 at ₹600 on 2025-10-01 → the bonus lot:
 *       60,000 − 0 = +₹60,000, short-term (held 4 months)
 * The old code booked +₹10,000 long-term on each sale (60,000 − 50,000),
 * which is wrong in amount, in character, and in which year's rate applies.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale, recordSplit,
  listHoldings, classifyInstrument, lotsFor,
} from "./assets.ts";
import { units, price } from "../portfolio/holdings.ts";
import { gainsBucketsForYear } from "./capital-gains-tax.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2023-01-01", openingBalance: rupees(500_000),
  }).id;
  const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" }).id;
  const inst = findOrCreateInstrument(db, actor, {
    name: "Fictional Co", kind: "equity", symbol: "B", provider: "manual",
  }).id;
  classifyInstrument(db, actor, inst, { assetClass: "equity" });
  recordPurchase(db, actor, {
    accountId: demat, instrumentId: inst, tradeDate: "2023-01-02",
    price: price(1000), units: units(100), fromAccountId: bank,
  });
  const holdingId = listHoldings(db, demat)[0]!.id;
  return { db, bank, holdingId };
}

describe("a bonus issue", () => {
  test("adds a nil-cost lot dated on allotment and leaves the originals alone", () => {
    const { db, holdingId } = setup();
    recordSplit(db, actor, { holdingId, date: "2025-06-02", ratio: 2, kind: "bonus" });

    const lots = lotsFor(db, holdingId);
    assert.equal(lots.length, 2);
    const [orig, bonus] = lots;
    assert.equal(orig!.tradeDate, "2023-01-02");
    assert.equal(orig!.units, units(100), "the original lot was re-divided like a split");
    assert.equal(orig!.cost, rupees(100_000));
    assert.equal(bonus!.tradeDate, "2025-06-02");
    assert.equal(bonus!.units, units(100));
    assert.equal(bonus!.cost, 0);
  });

  test("selling afterwards realises the right gains in the right buckets", () => {
    const { db, bank, holdingId } = setup();
    recordSplit(db, actor, { holdingId, date: "2025-06-02", ratio: 2, kind: "bonus" });

    const s1 = recordSale(db, actor, {
      holdingId, date: "2025-09-01", units: units(100), price: price(600), toAccountId: bank,
    });
    const s2 = recordSale(db, actor, {
      holdingId, date: "2025-10-01", units: units(100), price: price(600), toAccountId: bank,
    });
    assert.equal(s1.realisedGain, -rupees(40_000), "the originals kept their ₹1,000 cost");
    assert.equal(s2.realisedGain, rupees(60_000), "bonus shares cost nothing");

    const b = gainsBucketsForYear(db, 2025, "m");
    assert.equal(b.equityLong, -rupees(40_000));
    assert.equal(b.equityShort, rupees(60_000), "bonus shares are held from allotment");
  });

  test("a split still re-divides the lots it has", () => {
    const { db, holdingId } = setup();
    recordSplit(db, actor, { holdingId, date: "2025-06-02", ratio: 2, kind: "split" });
    const lots = lotsFor(db, holdingId);
    assert.equal(lots.length, 1);
    assert.equal(lots[0]!.units, units(200));
    assert.equal(lots[0]!.cost, rupees(100_000));
    assert.equal(lots[0]!.tradeDate, "2023-01-02");
  });

  test("a bonus ratio that adds nothing is refused", () => {
    const { db, holdingId } = setup();
    assert.throws(
      () => recordSplit(db, actor, { holdingId, date: "2025-06-02", ratio: 1, kind: "bonus" }),
      Refusal,
    );
  });
});
