/**
 * BONDS-1 · "Listed on an exchange", asked of a bond on the add-holding form
 * and on its holding page, because a listed bond held over 12 months is taxed
 * at 12.5% and an unlisted one at slab.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne } from "../db/db.ts";
import { rupees } from "../core/money.ts";
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
  return { db, app, demat };
}

const listedOf = (db: ReturnType<typeof freshDb>, name: string) =>
  queryOne<{ listed: number | null }>(db, `SELECT listed FROM instruments WHERE name = ?`, name)!.listed;

const buy = (demat: string, extra: Record<string, string>) => ({
  step: "create", account_id: demat, amount: "10000", unit_price: "100", trade_date: "2025-09-01", ...extra,
});

describe("BONDS-1 · the add-holding form", () => {
  test("offers a bond and asks whether it is listed", async () => {
    const { app } = await setup();
    try {
      const page = await (await app.get("/portfolio/add")).text();
      assert.match(page, /<option value="bond">Bond<\/option>/);
      assert.match(page, /name="listed" value="1"/);
      assert.match(page, /Listed on an exchange/);
    } finally {
      await app.close();
    }
  });

  test("a ticked bond is listed, an unticked one is not, and other kinds record nothing", async () => {
    const { db, app, demat } = await setup();
    try {
      assert.equal((await app.post("/portfolio/add", buy(demat, { name: "Listed NCD", kind: "bond", listed: "1" }))).status, 303);
      assert.equal((await app.post("/portfolio/add", buy(demat, { name: "Private NCD", kind: "bond" }))).status, 303);
      assert.equal((await app.post("/portfolio/add", buy(demat, { name: "A Fund", kind: "mutual-fund", listed: "1" }))).status, 303);
      assert.equal(listedOf(db, "Listed NCD"), 1);
      assert.equal(listedOf(db, "Private NCD"), 0);
      assert.equal(listedOf(db, "A Fund"), null);
    } finally {
      await app.close();
    }
  });
});

describe("BONDS-1 · the bond's holding page", () => {
  test("shows the checkbox and saves it", async () => {
    const { db, app, demat } = await setup();
    try {
      await app.post("/portfolio/add", buy(demat, { name: "Some NCD", kind: "bond" }));
      const holding = listHoldings(db, demat)[0]!;
      const page = await (await app.get(`/portfolio/${holding.id}`)).text();
      assert.match(page, new RegExp(`action="/portfolio/instrument/${holding.instrument_id}/listed"`));

      const r = await app.post(`/portfolio/instrument/${holding.instrument_id}/listed`, {
        listed: "1", holding_id: holding.id,
      });
      assert.equal(r.status, 303);
      assert.match(r.headers.get("location")!, new RegExp(`/portfolio/${holding.id}`));
      assert.equal(listedOf(db, "Some NCD"), 1);

      const after = await (await app.get(`/portfolio/${holding.id}`)).text();
      assert.match(after, /name="listed" value="1" checked/);
    } finally {
      await app.close();
    }
  });

  test("a fund's page does not ask", async () => {
    const { db, app, demat } = await setup();
    try {
      await app.post("/portfolio/add", buy(demat, { name: "A Fund", kind: "mutual-fund" }));
      const holding = listHoldings(db, demat)[0]!;
      const page = await (await app.get(`/portfolio/${holding.id}`)).text();
      assert.doesNotMatch(page, /Listed on an exchange/);
    } finally {
      await app.close();
    }
  });
});
