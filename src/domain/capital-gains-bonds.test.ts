/**
 * BONDS-1 · A bond is taxed by whether it is listed.
 *
 * A bond listed on an exchange is a listed security: long-term after 12
 * months, then s112 at 12.5% without indexation. Since 23 July 2024 s50AA
 * slab-rates unlisted bonds and debentures whatever the holding period. The
 * listing was never recorded, so every bond gain was slab-rated; a bond whose
 * listing is still not recorded stays there.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne } from "../db/db.ts";
import { nowIST, type IsoDate } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount } from "./accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale, listHoldings,
  setInstrumentListed, getInstrument,
} from "./assets.ts";
import { units, price } from "../portfolio/holdings.ts";
import { gainsBucketsForYear, taxOnGains } from "./capital-gains-tax.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`, "m", "f@e.com", "Ravi", nowIST());
  return db;
}

/** ₹1,00,000 of a bond in at ₹100, out at ₹150: a ₹50,000 gain. Returns the FY's buckets. */
function sellBond(listed: boolean | null | undefined, bought: IsoDate, sold: IsoDate, fy: number) {
  const db = setup();
  const bank = createAccount(db, actor, {
    name: "Savings", kind: "budget", subtype: "savings",
    openingDate: "2020-01-01", openingBalance: rupees(1_000_000),
  }).id;
  const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" }).id;
  const bond = findOrCreateInstrument(db, actor, {
    name: "Fictional 7.5% NCD 2030", kind: "bond", symbol: "NCD", provider: "manual", listed,
  }).id;
  recordPurchase(db, actor, {
    accountId: demat, instrumentId: bond, tradeDate: bought,
    price: price(100), units: units(1_000), fromAccountId: bank,
  });
  recordSale(db, actor, {
    holdingId: listHoldings(db, demat)[0]!.id, date: sold,
    units: units(1_000), price: price(150), toAccountId: bank,
  });
  return gainsBucketsForYear(db, fy, "m");
}

describe("BONDS-1 · a listed bond", () => {
  test("held over 12 months is long-term under s112, at 12.5% with no indexation", () => {
    const b = sellBond(true, "2024-05-10", "2025-08-20", 2025);
    assert.equal(b.otherLong, rupees(50_000));
    assert.equal(b.slabRated, 0);
    const tax = taxOnGains(2025, b);
    assert.equal(tax.otherLongTax, rupees(6_250));
    assert.equal(tax.special.s112, rupees(50_000));
  });

  test("held long and sold before 23 July 2024, it is reported, not taxed at the new rate", () => {
    const b = sellBond(true, "2022-05-10", "2024-06-20", 2024);
    assert.equal(b.otherLong, 0);
    assert.equal(b.unclassified, rupees(50_000));
    assert.match(b.unclassifiedReasons[0]!.reason, /before 23 July 2024/);
  });

  test("held long and sold from 23 July 2024, it is taxed at 12.5% in that period", () => {
    const b = sellBond(true, "2022-05-10", "2024-09-20", 2024);
    const tax = taxOnGains(2024, b);
    assert.equal(tax.otherLongTax, rupees(6_250));
  });

  test("held exactly 12 months is still short-term, at slab", () => {
    const b = sellBond(true, "2024-08-20", "2025-08-20", 2025);
    assert.equal(b.slabRated, rupees(50_000));
    assert.equal(b.otherLong, 0);
  });

  test("held under 12 months is slab-rated", () => {
    const b = sellBond(true, "2025-01-10", "2025-08-20", 2025);
    assert.equal(b.slabRated, rupees(50_000));
  });
});

describe("BONDS-1 · an unlisted bond, or one whose listing is unknown", () => {
  test("unlisted, it is slab-rated however long it is held (s50AA)", () => {
    const b = sellBond(false, "2020-05-10", "2025-08-20", 2025);
    assert.equal(b.slabRated, rupees(50_000));
    assert.equal(b.otherLong, 0);
  });

  test("not recorded, it stays at slab", () => {
    const b = sellBond(undefined, "2020-05-10", "2025-08-20", 2025);
    assert.equal(b.slabRated, rupees(50_000));
    assert.equal(b.otherLong, 0);
  });
});

describe("BONDS-1 · recording the listing", () => {
  test("a new bond stores it; another kind never does", () => {
    const db = setup();
    const unknown = findOrCreateInstrument(db, actor, { name: "B1", kind: "bond", symbol: "B1" });
    const yes = findOrCreateInstrument(db, actor, { name: "B2", kind: "bond", symbol: "B2", listed: true });
    const no = findOrCreateInstrument(db, actor, { name: "B3", kind: "bond", symbol: "B3", listed: false });
    const fund = findOrCreateInstrument(db, actor, { name: "F", kind: "mutual-fund", symbol: "F", listed: true });
    assert.equal(unknown.listed, null);
    assert.equal(yes.listed, 1);
    assert.equal(no.listed, 0);
    assert.equal(fund.listed, null);
  });

  test("set on an existing bond, logged, and undone to what it was", () => {
    const db = setup();
    const bond = findOrCreateInstrument(db, actor, { name: "B", kind: "bond", symbol: "B" }).id;
    setInstrumentListed(db, actor, bond, true);
    assert.equal(getInstrument(db, bond)!.listed, 1);

    const ev = queryOne<{ id: string }>(
      db, `SELECT id FROM events WHERE entity = 'instrument' AND entity_id = ? AND action = 'listed'`, bond,
    )!;
    assert.ok(undoEvent(db, ev.id, actor).ok);
    assert.equal(getInstrument(db, bond)!.listed, null);
  });

  test("refused for anything but a bond", () => {
    const db = setup();
    const fund = findOrCreateInstrument(db, actor, { name: "F", kind: "mutual-fund", symbol: "F" }).id;
    assert.throws(() => setInstrumentListed(db, actor, fund, true), Refusal);
  });

  test("the column refuses anything but 0, 1 or nothing", () => {
    const db = setup();
    const bond = findOrCreateInstrument(db, actor, { name: "B", kind: "bond", symbol: "B" }).id;
    assert.throws(() => execute(db, `UPDATE instruments SET listed = 2 WHERE id = ?`, bond));
  });
});
