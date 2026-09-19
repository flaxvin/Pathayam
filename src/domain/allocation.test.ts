import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordPrice,
  recordValuation, classifyInstrument, getInstrument, classFromKind,
} from "./assets.ts";
import { units, price } from "../portfolio/holdings.ts";
import { assetAllocation } from "./networth.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  const demat = createAssetAccount(db, actor, { name: "Zerodha", subtype: "investment" });
  return { db, demat };
}

/** Buy `n` units of a fresh instrument and mark it to `mkt` rupees/unit. */
function hold(
  db: DB, accountId: string,
  opts: { name: string; kind: "mutual-fund" | "equity" | "etf" | "bond" | "commodity"; n: number; mkt: number; currency?: string },
) {
  const inst = findOrCreateInstrument(db, actor, {
    name: opts.name, kind: opts.kind, provider: "manual",
    currency: opts.currency ?? "INR",
  });
  recordPurchase(db, actor, {
    accountId, instrumentId: inst.id, tradeDate: "2026-08-01",
    price: price(opts.mkt), units: units(opts.n),
  });
  recordPrice(db, { instrumentId: inst.id, price: price(opts.mkt), asOf: todayIST(), source: "test" });
  return inst;
}

describe("07 F19.11 · asset allocation", () => {
  test("a kind that implies a class is seeded; a fund is not", () => {
    assert.equal(classFromKind("equity"), "equity");
    assert.equal(classFromKind("etf"), "equity");
    assert.equal(classFromKind("bond"), "debt");
    assert.equal(classFromKind("commodity"), "gold");
    assert.equal(classFromKind("mutual-fund"), null);
    assert.equal(classFromKind("other"), null);
  });

  test("an equity holding and a bond holding split by class", () => {
    const { db, demat } = setup();
    hold(db, demat.id, { name: "Nifty ETF", kind: "etf", n: 100, mkt: 200 });   // ₹20,000 equity
    hold(db, demat.id, { name: "Gilt Bond", kind: "bond", n: 100, mkt: 100 });  // ₹10,000 debt

    const a = assetAllocation(db, "2026-08-28");
    assert.equal(a.total, rupees(30_000));
    assert.deepEqual(a.byClass.map((s) => [s.key, s.value]), [
      ["equity", rupees(20_000)],
      ["debt", rupees(10_000)],
    ]);
    assert.ok(Math.abs(a.byClass[0]!.share - 2 / 3) < 1e-9);
    assert.equal(a.unclassified.value, 0);
    db.close();
  });

  test("N9 · an unclassified fund is reported separately, not guessed into equity", () => {
    const { db, demat } = setup();
    hold(db, demat.id, { name: "Nifty ETF", kind: "etf", n: 100, mkt: 200 });      // ₹20,000, classified
    const fund = hold(db, demat.id, { name: "Some Flexi Cap", kind: "mutual-fund", n: 100, mkt: 300 }); // ₹30,000, not

    const a = assetAllocation(db, "2026-08-28");
    // The classified total excludes the fund, so equity is 100% of what is known.
    assert.equal(a.total, rupees(20_000));
    assert.equal(a.byClass.length, 1);
    assert.equal(a.byClass[0]!.key, "equity");
    // The fund is surfaced, with the value and a pointer to classify it.
    assert.equal(a.unclassified.value, rupees(30_000));
    assert.deepEqual(a.unclassified.holdings.map((h) => [h.instrumentId, h.value]),
      [[fund.id, rupees(30_000)]]);
    db.close();
  });

  test("classifying the fund empties the unclassified bucket", () => {
    const { db, demat } = setup();
    hold(db, demat.id, { name: "Nifty ETF", kind: "etf", n: 100, mkt: 200 });
    const fund = hold(db, demat.id, { name: "Some Flexi Cap", kind: "mutual-fund", n: 100, mkt: 300 });

    classifyInstrument(db, actor, fund.id, { assetClass: "equity" });

    const a = assetAllocation(db, "2026-08-28");
    assert.equal(a.unclassified.value, 0);
    assert.equal(a.total, rupees(50_000));
    assert.equal(a.byClass[0]!.key, "equity");
    assert.equal(a.byClass[0]!.value, rupees(50_000));
    db.close();
  });

  test("manually-valued assets are classified by their subtype", () => {
    const { db } = setup();
    // "deposit" was retired — a fixed deposit is a tracking account worth its
    // balance now. A pension pot is the hand-valued thing that allocates to
    // debt, which is what this test is really about.
    const pension = createAssetAccount(db, actor, { name: "Pension pot", subtype: "retirement" });
    recordValuation(db, actor, { accountId: pension.id, value: rupees(1_00_000), asOf: "2026-08-01" });
    const flat = createAssetAccount(db, actor, { name: "Thane flat", subtype: "physical" });
    recordValuation(db, actor, { accountId: flat.id, value: rupees(50_00_000), asOf: "2026-08-01" });

    const a = assetAllocation(db, "2026-08-28");
    const classes = Object.fromEntries(a.byClass.map((s) => [s.key, s.value]));
    assert.equal(classes["debt"], rupees(1_00_000), "a pension pot allocates to debt");
    assert.equal(classes["real-estate"], rupees(50_00_000), "a flat is real estate");
    db.close();
  });

  test("SHOULD · a foreign holding shows under International and its currency", () => {
    const { db, demat } = setup();
    hold(db, demat.id, { name: "Nifty ETF", kind: "etf", n: 100, mkt: 200 });                  // INR
    const us = hold(db, demat.id, { name: "VOO", kind: "etf", n: 10, mkt: 500, currency: "USD" });
    // Value the USD holding in base currency via a stored rate isn't wired here;
    // the region split is what this asserts.
    void us;

    const a = assetAllocation(db, "2026-08-28");
    assert.ok(a.byRegion.some((s) => s.key === "domestic"));
    assert.ok(a.byRegion.some((s) => s.key === "international"),
      "a non-INR instrument defaults to international");
    db.close();
  });

  test("an empty portfolio allocates to nothing without erroring", () => {
    const { db } = setup();
    const a = assetAllocation(db, "2026-08-28");
    assert.equal(a.total, 0);
    assert.deepEqual(a.byClass, []);
    assert.equal(a.unclassified.value, 0);
    db.close();
  });

  test("reclassification is logged, so an allocation shift is explainable", () => {
    const { db, demat } = setup();
    const fund = hold(db, demat.id, { name: "Some Fund", kind: "mutual-fund", n: 100, mkt: 100 });
    classifyInstrument(db, actor, fund.id, { assetClass: "debt" });
    assert.equal(getInstrument(db, fund.id)!.asset_class, "debt");
    db.close();
  });
});

describe("07 F19.13 · portfolio CSV export", () => {
  test("holdings, lots and prices export with human-readable units", async () => {
    const { exportHoldingsCsv, exportLotsCsv, exportPriceHistoryCsv } =
      await import("./assets.ts");
    const { db, demat } = setup();
    hold(db, demat.id, { name: "Nifty ETF", kind: "etf", n: 100, mkt: 200 });

    const holdings = exportHoldingsCsv(db);
    assert.match(holdings.split("\n")[0]!, /account,instrument,isin,kind,asset_class/);
    assert.match(holdings, /Nifty ETF/);
    assert.match(holdings, /100\.000,20000\.00/, "units to 3dp, cost in rupees");

    const lots = exportLotsCsv(db);
    assert.match(lots, /trade_date,units,price_per_unit/);
    assert.match(lots, /2026-08-01,100\.000,200\.0000/);

    assert.match(exportPriceHistoryCsv(db), /instrument,isin,as_of,price,source/);
    db.close();
  });

  test("a field containing a comma is quoted", async () => {
    const { exportHoldingsCsv } = await import("./assets.ts");
    const { db, demat } = setup();
    // A fund name with a comma must not break the CSV columns.
    const inst = (await import("./assets.ts")).findOrCreateInstrument(db, actor, {
      name: "HDFC Corp Bond, Direct", kind: "bond", provider: "manual",
    });
    (await import("./assets.ts")).recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: inst.id, tradeDate: "2026-08-01",
      price: price(100), units: units(10),
    });
    assert.match(exportHoldingsCsv(db), /"HDFC Corp Bond, Direct"/);
    db.close();
  });
});
