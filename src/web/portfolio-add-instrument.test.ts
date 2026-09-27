/**
 * Which instrument a purchase lands on.
 *
 * WEALTH-12 · Choosing a fund from the scheme search made the AMFI instrument
 * and then showed the blank by-hand form, so the purchase created a second,
 * manual instrument — the chosen scheme held nothing and the holding never
 * got a NAV.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryAll } from "../db/db.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createAssetAccount } from "../domain/assets.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

async function setup() {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  const actor = { memberId: "m", source: "ui" as const };
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2024-01-01", openingBalance: rupees(500_000),
  }).id;
  const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" }).id;
  const app = await startTestApp(db, { memberId: "m" });
  return { db, app, bank, demat };
}

const instruments = (db: ReturnType<typeof freshDb>) => queryAll<{
  id: string; name: string; symbol: string | null; provider: string; holdings: number;
}>(db, `SELECT i.id, i.name, i.symbol, i.provider,
               (SELECT COUNT(*) FROM holdings h WHERE h.instrument_id = i.id) AS holdings
          FROM instruments i`);

describe("WEALTH-12 · a scheme chosen from the search", () => {
  test("is the instrument the purchase goes to", async () => {
    const { db, app, demat } = await setup();
    try {
      const name = "Fictional Flexi Cap Fund - Direct Plan - Growth";
      const chose = await app.post("/portfolio/add", { step: "details", scheme_code: "999001", name });
      assert.equal(chose.status, 303);
      const next = chose.headers.get("location")!;
      const chosen = instruments(db)[0]!;
      assert.match(next, new RegExp(`instrument=${chosen.id}`));

      // The form the person lands on carries the choice.
      const page = await (await app.get(next.replace(/^https?:\/\/[^/]+/, ""))).text();
      assert.match(page, new RegExp(`name="instrument_id" value="${chosen.id}"`));
      assert.match(page, /Buy Fictional Flexi Cap Fund/);

      const r = await app.post("/portfolio/add", {
        step: "create", instrument_id: chosen.id, account_id: demat,
        amount: "10000", unit_price: "50", trade_date: "2025-09-01",
      });
      assert.equal(r.status, 303);

      const all = instruments(db);
      assert.equal(all.length, 1, "a second, manual instrument was made");
      assert.equal(all[0]!.provider, "mfapi");
      assert.equal(all[0]!.symbol, "999001");
      assert.equal(all[0]!.holdings, 1);
    } finally {
      await app.close();
    }
  });

  test("an instrument that does not exist is a 404, not a new one", async () => {
    const { db, app, demat } = await setup();
    try {
      const r = await app.post("/portfolio/add", {
        step: "create", instrument_id: "nope", account_id: demat,
        amount: "10000", unit_price: "50", trade_date: "2025-09-01",
      });
      assert.equal(r.status, 404);
      assert.equal(instruments(db).length, 0);
    } finally {
      await app.close();
    }
  });
});
