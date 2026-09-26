/**
 * IMPORTS-SCHEDULES-22 · A rule on the amount is typed in rupees.
 *
 * The /rules form stored the typed "5000" as it stood and the evaluator
 * compared it with paise, so "the amount is more than 5000" filed a ₹60 chai
 * (6000 paise) into Big spends, and "is exactly 649" never met a ₹649 Netflix
 * (64900). The form now reads the figure as rupees and stores paise.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { listStaged } from "./pipeline.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

describe("IMPORTS-SCHEDULES-22 · rule amounts", () => {
  test("'more than 5000' and 'is exactly 649' are rupees", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const account = createAccount(db, actor, {
      name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
    });
    const g = createGroup(db, actor, "ZZ Group");
    const big = createCategory(db, actor, { groupId: g.id, name: "ZZ Big spends" }).id;
    const stream = createCategory(db, actor, { groupId: g.id, name: "ZZ Streaming" }).id;
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      assert.equal((await app.post("/rules/new", {
        name: "ZZ Big", field: "absoluteAmount", op: "greaterThan", value: "5,000", category_id: big,
      })).status, 303);
      assert.equal((await app.post("/rules/new", {
        name: "ZZ Stream", field: "absoluteAmount", op: "is", value: "649", category_id: stream,
      })).status, 303);
      const stored = queryOne<{ conditions_json: string }>(db,
        `SELECT conditions_json FROM rules WHERE name = 'ZZ Big'`)!;
      assert.equal(JSON.parse(stored.conditions_json)[0].value, 500000);

      // A word is not an amount: refused, not saved to never match.
      assert.equal((await app.post("/rules/new", {
        name: "ZZ Word", field: "amount", op: "is", value: "lots", category_id: big,
      })).status, 422);

      // The list shows the figure back in rupees.
      const page = await (await app.get("/rules")).text();
      assert.match(page, /absoluteAmount greaterThan 5,000/);

      await app.post("/import", {
        account_id: account.id, file_name: "zz.csv",
        csv: "Date,Narration,Amount\n03-09-2026,UPI/ZZ CHAI,-60.00\n04-09-2026,ZZ STREAMING,-649.00\n05-09-2026,UPI/ZZ RENT,-25000.00",
      });
      const filed = new Map(listStaged(db).map((r) => [r.raw_narration, r.category_id]));
      assert.equal(filed.get("UPI/ZZ CHAI"), null);
      assert.equal(filed.get("ZZ STREAMING"), stream);
      assert.equal(filed.get("UPI/ZZ RENT"), big);
    } finally {
      await app.close();
    }
  });
});
