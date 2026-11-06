/**
 * ENG-15 · An Indian share not listed on a recognised stock exchange.
 *
 * s111A and s112A are for listed equity sold with STT paid. An unlisted
 * share is long-term only after 24 months (s2(42A)), then s112 at 12.5% with
 * no indexation for a transfer from 23 July 2024 (20% with indexation before,
 * which this reports rather than computes), with no ₹1.25 lakh exemption; and
 * slab-rated when held shorter. Every share was taxed as listed. A share whose
 * listing was never recorded is still taxed as listed — every stock row
 * before this — so nothing changes for one.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import { nowIST, type IsoDate } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
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

/** 1,000 shares in at ₹100, out at ₹150: a ₹50,000 gain. Returns the FY's buckets. */
function sellShare(listed: boolean | null | undefined, bought: IsoDate, sold: IsoDate, fy: number) {
  const db = setup();
  const bank = createAccount(db, actor, {
    name: "Savings", kind: "budget", subtype: "savings",
    openingDate: "2015-01-01", openingBalance: rupees(1_000_000),
  }).id;
  const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" }).id;
  const share = findOrCreateInstrument(db, actor, {
    name: "Fictional Pvt Ltd", kind: "equity", symbol: "FICT", provider: "manual", listed,
  }).id;
  recordPurchase(db, actor, {
    accountId: demat, instrumentId: share, tradeDate: bought,
    price: price(100), units: units(1_000), fromAccountId: bank,
  });
  recordSale(db, actor, {
    holdingId: listHoldings(db, demat)[0]!.id, date: sold,
    units: units(1_000), price: price(150), toAccountId: bank,
  });
  return gainsBucketsForYear(db, fy, "m");
}

describe("ENG-15 · an unlisted Indian share", () => {
  test("held 18 months is short-term, at slab — not s112A", () => {
    const b = sellShare(false, "2024-02-10", "2025-08-20", 2025);
    assert.equal(b.equityLong, 0);
    assert.equal(b.equityShort, 0);
    assert.equal(b.slabRated, rupees(50_000));
  });

  test("held 6 months is slab-rated, not s111A", () => {
    const b = sellShare(false, "2025-02-10", "2025-08-20", 2025);
    assert.equal(b.equityShort, 0);
    assert.equal(b.slabRated, rupees(50_000));
  });

  test("held over 24 months is s112 at 12.5%, with no ₹1.25 lakh exemption", () => {
    const b = sellShare(false, "2022-05-10", "2025-08-20", 2025);
    assert.equal(b.equityLong, 0);
    assert.equal(b.otherLong, rupees(50_000));
    const tax = taxOnGains(2025, b);
    assert.equal(tax.exemptionUsed, 0);
    assert.equal(tax.otherLongTax, rupees(6_250));
  });

  test("held exactly 24 months is still short-term", () => {
    const b = sellShare(false, "2023-08-20", "2025-08-20", 2025);
    assert.equal(b.slabRated, rupees(50_000));
    assert.equal(b.otherLong, 0);
  });

  test("held long and sold before 23 July 2024, it is reported (20% with indexation), not taxed", () => {
    const b = sellShare(false, "2021-05-10", "2024-06-20", 2024);
    assert.equal(b.otherLong, 0);
    assert.equal(b.equityLong, 0);
    assert.equal(b.unclassified, rupees(50_000));
    assert.match(b.unclassifiedReasons[0]!.reason, /indexation/);
  });

  test("bought before 1 February 2018, it is not grandfathered — that is for listed equity", () => {
    const b = sellShare(false, "2017-05-10", "2025-08-20", 2025);
    assert.equal(b.otherLong, rupees(50_000));
    assert.equal(b.unclassified, 0);
  });
});

describe("ENG-15 · a share recorded as listed, or with nothing recorded", () => {
  for (const listed of [true, undefined]) {
    test(`listed = ${listed}: held 18 months is s112A, inside the exemption`, () => {
      const b = sellShare(listed, "2024-02-10", "2025-08-20", 2025);
      assert.equal(b.equityLong, rupees(50_000));
      assert.equal(b.slabRated, 0);
      assert.equal(taxOnGains(2025, b).equityLongTax, 0);
    });
  }
});

describe("ENG-15 · recording a share's listing", () => {
  test("a new share stores it; nothing said leaves it unrecorded (taxed as listed)", () => {
    const db = setup();
    const unknown = findOrCreateInstrument(db, actor, { name: "S1", kind: "equity", symbol: "S1" });
    const yes = findOrCreateInstrument(db, actor, { name: "S2", kind: "equity", symbol: "S2", listed: true });
    const no = findOrCreateInstrument(db, actor, { name: "S3", kind: "equity", symbol: "S3", listed: false });
    assert.equal(unknown.listed, null);
    assert.equal(yes.listed, 1);
    assert.equal(no.listed, 0);
  });

  test("set on an existing share", () => {
    const db = setup();
    const share = findOrCreateInstrument(db, actor, { name: "S", kind: "equity", symbol: "S" }).id;
    setInstrumentListed(db, actor, share, false);
    assert.equal(getInstrument(db, share)!.listed, 0);
    setInstrumentListed(db, actor, share, true);
    assert.equal(getInstrument(db, share)!.listed, 1);
  });
});
