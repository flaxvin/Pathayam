/**
 * Portfolio's "Other assets" printed a hand-valued foreign balance in its own
 * currency with a rupee sign: the demo's SGD 41,120 savings read "₹41,120"
 * while net worth and FIRE counted it as ₹25 lakh. Found comparing Portfolio
 * with FIRE in a browser.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, testConfig, type TestApp } from "./harness.test-data.ts";
import { createAssetAccount, recordFxRate } from "../domain/assets.ts";
import { rupees } from "../core/money.ts";
import { todayIST } from "../core/dates.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };
let app: TestApp;

before(async () => {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  createAssetAccount(db, actor, {
    name: "Fictional Singapore savings", subtype: "retirement", currency: "SGD",
    openingValue: rupees(41_120), asOf: todayIST(),
  });
  recordFxRate(db, { base: "SGD", quote: "INR", rate: 60, asOf: todayIST(), source: "t" });
  app = await startTestApp(db, { memberId: "m-ravi", config: testConfig({}) });
});
after(async () => { await app.close(); });

test("a foreign hand-valued asset is shown in rupees on Portfolio", async () => {
  const page = (await (await app.get("/portfolio")).text()).replace(/\s+/g, " ");
  assert.match(page, /Fictional Singapore savings/);
  assert.match(page, /₹24,67,200/, "SGD 41,120 at 60 is ₹24,67,200");
  assert.doesNotMatch(page, /₹41,120</);
});
