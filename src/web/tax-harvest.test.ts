/**
 * HARVEST-1 · The Tax page shows what is left of the s112A exemption this
 * year and what could be sold to use it; Portfolio points to it.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordPrice, classifyInstrument,
} from "../domain/assets.ts";
import { units, price } from "../portfolio/holdings.ts";
import { rupees } from "../core/money.ts";
import { aiTaxEstimate } from "../ai/analysis.ts";
import { STYLESHEET as STYLES } from "./styles.ts";
import { addDays, fiscalYearOf, todayIST } from "../core/dates.ts";

const actor = { memberId: "m", source: "ui" as const };
let app: TestApp;
let priya: TestApp;
let db: ReturnType<typeof freshDb>;

before(async () => {
  db = freshDb();
  seedMember(db, "m", "Ravi");
  seedMember(db, "p", "Priya");
  const today = todayIST();
  const bank = createAccount(db, actor, {
    name: "Savings", kind: "budget", subtype: "savings",
    openingDate: addDays(today, -1_000), openingBalance: rupees(10_000_000),
  }).id;
  const demat = createAssetAccount(db, actor, {
    name: "Ravi demat", subtype: "investment", holderMemberId: "m", visibility: "household",
  }).id;
  const stock = findOrCreateInstrument(db, actor, {
    name: "Fictional Harvest Co", kind: "equity", symbol: "FHC", provider: "manual",
  }).id;
  recordPurchase(db, actor, {
    accountId: demat, instrumentId: stock, tradeDate: addDays(today, -800),
    price: price(100), units: units(1_000), fromAccountId: bank,
  });
  recordPrice(db, { instrumentId: stock, price: price(400), asOf: today, source: "manual" });
  const hybrid = findOrCreateInstrument(db, actor, {
    name: "Fictional Balanced Fund", kind: "mutual-fund", provider: "manual",
  }).id;
  classifyInstrument(db, actor, hybrid, { assetClass: "hybrid" });
  recordPurchase(db, actor, {
    accountId: demat, instrumentId: hybrid, tradeDate: addDays(today, -800),
    price: price(10), units: units(100), fromAccountId: bank,
  });
  app = await startTestApp(db, { memberId: "m" });
  priya = await startTestApp(db, { memberId: "p" });
});
after(async () => { await app.close(); await priya.close(); });

test("the Tax page shows the unused exemption and a FIFO suggestion, with its caveats", async () => {
  const page = (await (await app.get("/tax")).text()).replace(/\s+/g, " ");
  assert.ok(page.includes('id="harvest"'), "the card is on the page");
  const card = page.slice(page.indexOf('id="harvest"'), page.indexOf("</section>", page.indexOf('id="harvest"')));
  assert.match(card, /Tax-free long-term gains left this year/);
  assert.match(card, /₹1,25,000/);
  assert.match(card, /Fictional Harvest Co/);
  // ₹300 a share: 416 whole shares realise ₹1,24,800.
  assert.match(card, /<strong>416<\/strong>/);
  assert.match(card, /₹1,24,800/);
  assert.match(card, /days to/);
  assert.match(card, /Fictional Balanced Fund[\s\S]*hybrid/);
  assert.match(card, /not advice/);
  assert.match(card, /Exit loads, STT and brokerage are not included/);
  assert.doesNotMatch(card, /<form/, "nothing on the card is hidden when printed");
});

test("another year shows no card: the exemption is the current year's", async () => {
  const fy = fiscalYearOf(todayIST());
  const page = await (await app.get(`/tax?fy=${fy - 1}`)).text();
  assert.ok(!page.includes('id="harvest"'));
});

test("another member's holdings are not in this member's card", async () => {
  const res = await priya.get("/tax");
  assert.equal(res.status, 200);
  const page = (await res.text()).replace(/\s+/g, " ");
  assert.ok(page.includes('id="harvest"'));
  assert.ok(!page.includes("Fictional Harvest Co"));
  assert.match(page, /You hold no listed shares or equity funds of your own/);
});

test("Portfolio points to the Tax page's card", async () => {
  const page = (await (await app.get("/portfolio")).text()).replace(/\s+/g, " ");
  assert.match(page, /Tax-free long-term gains/);
  assert.match(page, /href="\/tax#harvest"/);
});

test("the AI tax estimate carries the same figures, and only the member's own", () => {
  const mine = aiTaxEstimate(db, "m", {}) as { ltcg_harvest: { unused: number; holdings: { instrument_name: string; suggest_units: number }[] } };
  assert.equal(mine.ltcg_harvest.unused, 125000);
  assert.deepEqual(mine.ltcg_harvest.holdings.map((h) => [h.instrument_name, h.suggest_units]), [["Fictional Harvest Co", 416]]);
  const hers = aiTaxEstimate(db, "p", {}) as { ltcg_harvest: { holdings: unknown[] } };
  assert.deepEqual(hers.ltcg_harvest.holdings, []);
});

test("printing keeps the caveats with the card", () => {
  const print = STYLES.slice(STYLES.indexOf("@media print"));
  assert.match(print, /\.harvest-caveats \{[^}]*break-inside: avoid/);
});
