/**
 * ENG-15 · "Listed on a recognised stock exchange", asked of a share on the
 * add-holding form (ticked by default) and on its holding page, because an
 * unlisted share is long-term after 24 months under s112 with no ₹1.25 lakh
 * exemption, not after 12 under s112A.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, queryOne } from "../db/db.ts";
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

describe("ENG-15 · the add-holding form", () => {
  test("asks whether a share is listed on a recognised stock exchange, ticked to start", async () => {
    const { app } = await setup();
    try {
      const page = await (await app.get("/portfolio/add")).text();
      assert.match(page, /Listed on a recognised stock exchange/);
      assert.match(page, /name="share_listed" value="1" checked/);
    } finally {
      await app.close();
    }
  });

  test("a ticked share is listed, an unticked one is not, and a post that never asked records nothing", async () => {
    const { db, app, demat } = await setup();
    try {
      const asked = { share_listed_asked: "1" };
      assert.equal((await app.post("/portfolio/add", buy(demat, { name: "Listed Co", kind: "equity", ...asked, share_listed: "1" }))).status, 303);
      assert.equal((await app.post("/portfolio/add", buy(demat, { name: "Private Co", kind: "equity", ...asked }))).status, 303);
      assert.equal((await app.post("/portfolio/add", buy(demat, { name: "Old Form Co", kind: "equity" }))).status, 303);
      assert.equal((await app.post("/portfolio/add", buy(demat, { name: "A Fund", kind: "mutual-fund", ...asked, share_listed: "1" }))).status, 303);
      assert.equal(listedOf(db, "Listed Co"), 1);
      assert.equal(listedOf(db, "Private Co"), 0);
      assert.equal(listedOf(db, "Old Form Co"), null);
      assert.equal(listedOf(db, "A Fund"), null);
    } finally {
      await app.close();
    }
  });
});

describe("ENG-15 · the share's holding page", () => {
  test("a share never recorded shows as listed, and unticking it saves it as unlisted", async () => {
    const { db, app, demat } = await setup();
    try {
      await app.post("/portfolio/add", buy(demat, { name: "Some Co", kind: "equity" }));
      const holding = listHoldings(db, demat)[0]!;
      const page = await (await app.get(`/portfolio/${holding.id}`)).text();
      assert.match(page, new RegExp(`action="/portfolio/instrument/${holding.instrument_id}/listed"`));
      assert.match(page, /Listed on a recognised stock exchange/);
      assert.match(page, /name="listed" value="1" checked/);

      const r = await app.post(`/portfolio/instrument/${holding.instrument_id}/listed`, { holding_id: holding.id });
      assert.equal(r.status, 303);
      assert.equal(listedOf(db, "Some Co"), 0);

      const after = await (await app.get(`/portfolio/${holding.id}`)).text();
      assert.doesNotMatch(after, /name="listed" value="1" checked/);
      assert.match(after, /24 months/);
    } finally {
      await app.close();
    }
  });

  test("a bond's page keeps its own wording", async () => {
    const { db, app, demat } = await setup();
    try {
      await app.post("/portfolio/add", buy(demat, { name: "Some NCD", kind: "bond" }));
      const holding = listHoldings(db, demat)[0]!;
      execute(db, `UPDATE instruments SET listed = NULL WHERE id = ?`, holding.instrument_id);
      const page = await (await app.get(`/portfolio/${holding.id}`)).text();
      assert.match(page, /Listed on an exchange/);
      assert.doesNotMatch(page, /name="listed" value="1" checked/);
    } finally {
      await app.close();
    }
  });
});
