/**
 * WEALTH-4 · A split or bonus happens to the instrument, not to one holding.
 * WEALTH-5 · And only to what was held before its date.
 *
 * The lots of the holding it was recorded on were adjusted, but the price
 * history — the instrument's — was divided for every holding. The same shares
 * in two demats: recording a 2-for-1 split on one halved the other's value on
 * the spot, and recording it on the second too halved the prices again.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryAll } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import type { Actor } from "../core/events.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordPrice, recordSplit,
  listHoldings, viewHolding, lotsFor,
} from "./assets.ts";
import { units, price } from "../portfolio/holdings.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "p", "p@e.com", "Priya", nowIST());
  const inst = findOrCreateInstrument(db, actor, {
    name: "Fictional Co", kind: "equity", symbol: "Q", provider: "manual",
  }).id;
  return { db, inst };
}

describe("WEALTH-4 · a split is recorded once, for every holding of the instrument", () => {
  test("two demats with the same shares both keep their value", () => {
    const { db, inst } = setup();
    const ravis = createAssetAccount(db, actor, { name: "Ravi demat", subtype: "investment" }).id;
    const priyas = createAssetAccount(db, actor, {
      name: "Priya demat", subtype: "investment", holderMemberId: "p",
    }).id;
    for (const accountId of [ravis, priyas]) {
      recordPurchase(db, actor, {
        accountId, instrumentId: inst, tradeDate: "2025-06-01", price: price(1000), units: units(10),
      });
    }
    recordPrice(db, { instrumentId: inst, price: price(1000), asOf: "2025-08-01", source: "t" });
    const h1 = listHoldings(db, ravis)[0]!.id;
    const h2 = listHoldings(db, priyas)[0]!.id;

    recordSplit(db, actor, { holdingId: h1, date: "2025-08-15", ratio: 2 });

    for (const h of [h1, h2]) {
      const view = viewHolding(db, h, "2025-08-10")!;
      assert.equal(view.units, units(20));
      assert.equal(view.marketValue, rupees(10_000));
    }
    assert.equal(
      queryAll(db, `SELECT id FROM holding_events WHERE kind = 'split'`).length, 2,
      "each holding carries its own record of the split",
    );

    // The same split recorded from the other demat is not applied twice.
    assert.throws(
      () => recordSplit(db, actor, { holdingId: h2, date: "2025-08-15", ratio: 2 }),
      Refusal,
    );
    assert.equal(viewHolding(db, h2, "2025-08-10")!.marketValue, rupees(10_000));
    db.close();
  });
});

describe("WEALTH-5 · a split changes only the lots bought before its date", () => {
  test("a lot bought after a split is left in the units it was bought in", () => {
    const { db, inst } = setup();
    const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" }).id;
    recordPurchase(db, actor, {
      accountId: demat, instrumentId: inst, tradeDate: "2025-06-01", price: price(1000), units: units(10),
    });
    // Bought after the split, at the post-split price.
    recordPurchase(db, actor, {
      accountId: demat, instrumentId: inst, tradeDate: "2025-09-10", price: price(500), units: units(10),
    });
    const holdingId = listHoldings(db, demat)[0]!.id;
    recordSplit(db, actor, { holdingId, date: "2025-09-01", ratio: 2 });

    const lots = lotsFor(db, holdingId);
    assert.deepEqual(lots.map((l) => [l.tradeDate, l.units, l.price]), [
      ["2025-06-01", units(20), price(500)],
      ["2025-09-10", units(10), price(500)],
    ]);
    db.close();
  });

  test("a bonus is sized from the units held before its record date", () => {
    const { db, inst } = setup();
    const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" }).id;
    recordPurchase(db, actor, {
      accountId: demat, instrumentId: inst, tradeDate: "2025-06-01", price: price(1000), units: units(10),
    });
    recordPurchase(db, actor, {
      accountId: demat, instrumentId: inst, tradeDate: "2025-09-10", price: price(500), units: units(10),
    });
    const holdingId = listHoldings(db, demat)[0]!.id;
    recordSplit(db, actor, { holdingId, date: "2025-09-01", ratio: 2, kind: "bonus" });

    const bonus = lotsFor(db, holdingId).find((l) => l.cost === 0)!;
    assert.equal(bonus.units, units(10), "a 1:1 bonus on the 10 units held before it");
    db.close();
  });

  test("a split dated before anything was bought is refused", () => {
    const { db, inst } = setup();
    const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" }).id;
    recordPurchase(db, actor, {
      accountId: demat, instrumentId: inst, tradeDate: "2025-06-01", price: price(1000), units: units(10),
    });
    const holdingId = listHoldings(db, demat)[0]!.id;
    assert.throws(() => recordSplit(db, actor, { holdingId, date: "2025-01-01", ratio: 2 }), Refusal);
    db.close();
  });
});
