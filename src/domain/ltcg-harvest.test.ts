/**
 * HARVEST-1 · The s112A exemption still unused this year, and what could be
 * sold, FIFO, to use it without crossing it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import type { DB } from "../db/db.ts";
import { createAccount } from "./accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale, recordPrice,
  listHoldings, classifyInstrument,
} from "./assets.ts";
import { units, price } from "../portfolio/holdings.ts";
import { ltcgHarvestHint } from "./ltcg-harvest.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";

const TODAY = "2026-11-14";
const ravi: Actor = { memberId: "m", source: "ui" };

function household(members: [string, string][] = [["m", "Ravi"]]) {
  const db = freshDb();
  for (const [id, name] of members) seedMember(db, id, name);
  const bank = createAccount(db, ravi, {
    name: "Savings", kind: "budget", subtype: "savings",
    openingDate: "2015-01-01", openingBalance: rupees(100_000_000),
  }).id;
  return { db, bank };
}

function demat(db: DB, name = "Demat", holder: string | null = "m"): string {
  return createAssetAccount(db, ravi, {
    name, subtype: "investment", holderMemberId: holder, visibility: "household",
  }).id;
}

function stock(
  db: DB, name: string,
  opts: { kind?: "equity" | "etf" | "mutual-fund"; listed?: boolean; cls?: "equity" | "hybrid" | "debt"; region?: "international" } = {},
): string {
  const id = findOrCreateInstrument(db, ravi, {
    name, kind: opts.kind ?? "equity", symbol: name.toUpperCase().replace(/\W/g, ""), provider: "manual",
    ...(opts.listed !== undefined ? { listed: opts.listed } : {}),
  }).id;
  if (opts.cls || opts.kind === "mutual-fund" || opts.region) {
    classifyInstrument(db, ravi, id, { assetClass: opts.cls ?? "equity", ...(opts.region ? { region: opts.region } : {}) });
  }
  return id;
}

function buy(db: DB, bank: string, account: string, instrumentId: string, date: string, qty: number, at: number) {
  recordPurchase(db, ravi, {
    accountId: account, instrumentId, tradeDate: date, price: price(at), units: units(qty), fromAccountId: bank,
  });
}

function priced(db: DB, instrumentId: string, at: number, asOf = "2026-11-13") {
  recordPrice(db, { instrumentId, price: price(at), asOf, source: "manual" });
}

/** A long-term gain of `gain` rupees realised this year in `account`. */
function realise(db: DB, bank: string, account: string, gain: number) {
  const id = stock(db, `Sold Co ${account}`);
  buy(db, bank, account, id, "2024-01-02", 1_000, 100);
  const holding = listHoldings(db, account).find((h) => h.instrument_id === id)!;
  recordSale(db, ravi, { holdingId: holding.id, date: "2026-06-01", units: units(1_000), price: price(100 + gain / 1_000), toAccountId: bank });
}

describe("HARVEST-1 · tax-free long-term gains", () => {
  test("nothing realised: the whole ₹1,25,000 is unused, and the days to 31 March are counted", () => {
    const { db } = household();
    const h = ltcgHarvestHint(db, "m", TODAY);
    assert.equal(h.fy, 2026);
    assert.equal(h.exemption, rupees(125_000));
    assert.equal(h.realised, 0);
    assert.equal(h.unused, rupees(125_000));
    assert.equal(h.fyEnd, "2027-03-31");
    assert.equal(h.daysLeft, 137);
    assert.equal(h.lines.length, 0);
  });

  test("exemption used up: nothing is suggested", () => {
    const { db, bank } = household();
    const d = demat(db);
    realise(db, bank, d, 150_000);
    const s = stock(db, "Held Co");
    buy(db, bank, d, s, "2024-01-01", 1_000, 100);
    priced(db, s, 300);

    const h = ltcgHarvestHint(db, "m", TODAY);
    assert.equal(h.realised, rupees(150_000));
    assert.equal(h.unused, 0);
    const line = h.lines.find((l) => l.instrument === "Held Co")!;
    assert.equal(line.longTermGain, rupees(200_000));
    assert.equal(line.suggestUnits, 0);
    assert.equal(h.suggestedGain, 0);
  });

  test("partly used: suggests whole shares up to, never over, what is left", () => {
    const { db, bank } = household();
    const d = demat(db);
    realise(db, bank, d, 25_000);
    const s = stock(db, "Held Co");
    buy(db, bank, d, s, "2024-01-01", 1_000, 100);
    priced(db, s, 400); // ₹300 a share

    const h = ltcgHarvestHint(db, "m", TODAY);
    assert.equal(h.unused, rupees(100_000));
    const line = h.lines.find((l) => l.instrument === "Held Co")!;
    // ₹1,00,000 ÷ ₹300 = 333.33 → 333 whole shares, ₹99,900.
    assert.equal(line.suggestUnits, units(333));
    assert.equal(line.suggestGain, rupees(99_900));
    assert.equal(line.suggestProceeds, rupees(133_200));
    assert.ok(h.suggestedGain <= h.unused);
  });

  test("fund units are suggested to three decimals", () => {
    const { db, bank } = household();
    const d = demat(db);
    const f = stock(db, "Equity Fund", { kind: "mutual-fund", cls: "equity" });
    buy(db, bank, d, f, "2024-01-01", 10_000, 10);
    priced(db, f, 40); // ₹30 a unit, ₹3,00,000 long-term
    const line = ltcgHarvestHint(db, "m", TODAY).lines[0]!;
    // ₹1,25,000 ÷ ₹30 = 4,166.666… units
    assert.equal(line.suggestUnits, units(4_166.666));
    assert.ok(line.suggestGain <= rupees(125_000));
    assert.ok(line.suggestGain > rupees(124_999));
  });

  test("no long-term lots: nothing suggested, and the date the oldest turns long-term", () => {
    const { db, bank } = household();
    const d = demat(db);
    const s = stock(db, "New Co");
    buy(db, bank, d, s, "2026-01-31", 100, 100);
    priced(db, s, 200);
    const line = ltcgHarvestHint(db, "m", TODAY).lines[0]!;
    assert.equal(line.longTermUnits, 0);
    assert.equal(line.shortTermUnits, units(100));
    assert.equal(line.suggestUnits, 0);
    // More than twelve months: 2027-01-31 is exactly twelve, so the day after.
    assert.equal(line.nextLongTermOn, "2027-02-01");
  });

  test("mixed lots under FIFO: the suggestion never reaches the short-term lot", () => {
    const { db, bank } = household();
    const d = demat(db);
    const s = stock(db, "Mixed Co");
    buy(db, bank, d, s, "2025-01-10", 100, 100); // long-term: ₹10,000 gain at ₹200
    buy(db, bank, d, s, "2026-05-01", 1_000, 100); // short-term
    priced(db, s, 200);
    const line = ltcgHarvestHint(db, "m", TODAY).lines[0]!;
    assert.equal(line.longTermUnits, units(100));
    assert.equal(line.shortTermUnits, units(1_000));
    assert.equal(line.longTermGain, rupees(10_000));
    // Plenty of exemption left, but selling a 101st share would be short-term.
    assert.equal(line.suggestUnits, units(100));
    assert.equal(line.suggestGain, rupees(10_000));
  });

  test("a long-term lot at a loss is consumed first, and nets in the same head", () => {
    const { db, bank } = household();
    const d = demat(db);
    const s = stock(db, "Dip Co");
    buy(db, bank, d, s, "2024-01-10", 100, 500); // at ₹300: −₹20,000
    buy(db, bank, d, s, "2024-06-10", 1_000, 100); // at ₹300: +₹2,00,000
    priced(db, s, 300);
    const line = ltcgHarvestHint(db, "m", TODAY).lines[0]!;
    assert.equal(line.longTermGain, rupees(180_000));
    // −₹20,000 + n × ₹200 ≤ ₹1,25,000 → n = 725; 825 units in all.
    assert.equal(line.suggestUnits, units(825));
    assert.equal(line.suggestGain, rupees(125_000));
  });

  test("a grandfathered lot is costed at its 31 January 2018 value, or excluded without one", () => {
    const { db, bank } = household();
    const d = demat(db);
    const s = stock(db, "Old Co");
    buy(db, bank, d, s, "2016-01-04", 1_000, 100);
    priced(db, s, 300);
    let h = ltcgHarvestHint(db, "m", TODAY);
    assert.equal(h.lines.length, 0);
    assert.match(h.excluded[0]!.reason, /31 January 2018/);

    priced(db, s, 250, "2018-01-31");
    h = ltcgHarvestHint(db, "m", TODAY);
    const line = h.lines[0]!;
    // max(₹100, min(₹250, ₹300)) = ₹250: ₹50 a share, not ₹200.
    assert.equal(line.longTermGain, rupees(50_000));
    assert.equal(line.suggestUnits, units(1_000));
  });

  test("member scoping: another member's demat and sales are not this member's", () => {
    const { db, bank } = household([["m", "Ravi"], ["p", "Priya"]]);
    const mine = demat(db, "Ravi demat", "m");
    const hers = demat(db, "Priya demat", "p");
    realise(db, bank, hers, 125_000);
    const s = stock(db, "Shared Co");
    buy(db, bank, hers, s, "2024-01-01", 100, 100);
    buy(db, bank, mine, s, "2024-01-01", 10, 100);
    priced(db, s, 200);

    const r = ltcgHarvestHint(db, "m", TODAY);
    assert.equal(r.unused, rupees(125_000), "Priya's sale used Ravi's exemption");
    assert.deepEqual(r.lines.map((l) => [l.accountName, l.longTermUnits]), [["Ravi demat", units(10)]]);

    const p = ltcgHarvestHint(db, "p", TODAY);
    assert.equal(p.unused, 0);
    assert.deepEqual(p.lines.map((l) => l.accountName), ["Priya demat"]);
  });

  test("an account with no holder in a two-member household is excluded, not shared", () => {
    const { db, bank } = household([["m", "Ravi"], ["p", "Priya"]]);
    const joint = demat(db, "Joint", null);
    const s = stock(db, "Joint Co");
    buy(db, bank, joint, s, "2024-01-01", 10, 100);
    priced(db, s, 200);
    const h = ltcgHarvestHint(db, "m", TODAY);
    assert.equal(h.lines.length, 0);
    assert.match(h.excluded[0]!.reason, /names no holder/);
  });

  test("a stale price is used, and its date and staleness carried", () => {
    const { db, bank } = household();
    const d = demat(db);
    const s = stock(db, "Quiet Co");
    buy(db, bank, d, s, "2024-01-01", 10, 100);
    priced(db, s, 150, "2026-10-01");
    const line = ltcgHarvestHint(db, "m", TODAY).lines[0]!;
    assert.equal(line.priceAsOf, "2026-10-01");
    assert.equal(line.priceStale, true);
    assert.equal(line.longTermGain, rupees(500));
  });

  test("unlisted, hybrid, international and unpriced holdings are excluded with a reason", () => {
    const { db, bank } = household();
    const d = demat(db);
    const unlisted = stock(db, "Private Co", { listed: false });
    const hybrid = stock(db, "Balanced Fund", { kind: "mutual-fund", cls: "hybrid" });
    const intl = stock(db, "World Fund", { kind: "mutual-fund", cls: "equity", region: "international" });
    const unpriced = stock(db, "Unpriced Co");
    const debt = stock(db, "Debt Fund", { kind: "mutual-fund", cls: "debt" });
    for (const id of [unlisted, hybrid, intl, unpriced, debt]) buy(db, bank, d, id, "2024-01-01", 10, 100);
    for (const id of [unlisted, hybrid, intl, debt]) priced(db, id, 200);

    const h = ltcgHarvestHint(db, "m", TODAY);
    assert.equal(h.lines.length, 0);
    const why = Object.fromEntries(h.excluded.map((e) => [e.instrument, e.reason]));
    assert.match(why["Private Co"]!, /unlisted/);
    assert.match(why["Balanced Fund"]!, /hybrid/);
    assert.match(why["World Fund"]!, /international/);
    assert.match(why["Unpriced Co"]!, /no price/);
    assert.equal(why["Debt Fund"], undefined, "a debt fund is not s112A and not listed at all");
  });

  test("the exemption is shared across holdings, never exceeded in total", () => {
    const { db, bank } = household();
    const d = demat(db);
    const a = stock(db, "Alpha Co");
    const b = stock(db, "Beta Co");
    buy(db, bank, d, a, "2024-01-01", 1_000, 100);
    buy(db, bank, d, b, "2024-01-01", 1_000, 100);
    priced(db, a, 200); // ₹1,00,000
    priced(db, b, 150); // ₹50,000
    const h = ltcgHarvestHint(db, "m", TODAY);
    const by = Object.fromEntries(h.lines.map((l) => [l.instrument, l]));
    assert.equal(by["Alpha Co"]!.suggestUnits, units(1_000));
    assert.equal(by["Beta Co"]!.suggestUnits, units(500));
    assert.equal(h.suggestedGain, rupees(125_000));
  });

  test("a year whose gains rules are not in the app is refused", () => {
    const { db } = household();
    assert.throws(() => ltcgHarvestHint(db, "m", "2031-06-01"), /not in this app/);
  });
});
