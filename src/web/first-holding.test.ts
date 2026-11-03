/**
 * UI-4 · A new household can add its first mutual fund.
 *
 * Weekly UI pass 04-11-2026, first run: Portfolio → Add a holding showed a
 * required "Held in" dropdown with nothing in it, and Save answered only the
 * browser's "Please select an item in the list". Nothing on the page said
 * what was missing, and nothing in the app could make it: "Held in" takes an
 * investment account, the account form sends investments to Portfolio, and
 * Portfolio's "Add an asset" offered every kind but that one. Only the demo
 * seed ever made one.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { listAssetAccounts } from "../domain/assets.ts";
import { latestValuation } from "../domain/assets.ts";
import { todayIST } from "../core/dates.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

describe("UI-4 · the first holding has somewhere to go", () => {
  test("Add a holding says what is missing and links to where it is made", async () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    const app = await startTestApp(db, { memberId: "m" });
    try {
      const page = await (await app.get("/portfolio/add")).text();
      assert.match(page, /href="\/portfolio\/asset\/new\?subtype=investment"/);

      const form = await (await app.get("/portfolio/asset/new?subtype=investment")).text();
      assert.match(form, /<option value="investment"\s+selected>/);

      const r = await app.post("/portfolio/asset/new", {
        name: "Zerodha", subtype: "investment", value: "50000", as_of: todayIST(),
      });
      assert.ok(r.status < 400, `created: ${r.status}`);
      const demat = listAssetAccounts(db).find((a) => a.name === "Zerodha")!;
      assert.equal(demat.subtype, "investment");
      // Its worth is its holdings; a typed figure would sit unused beside them.
      assert.equal(latestValuation(db, demat.id), null);

      const after = await (await app.get("/portfolio/add")).text();
      assert.match(after, new RegExp(`<option value="${demat.id}"`));
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
