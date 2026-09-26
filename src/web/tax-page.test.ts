/**
 * The /tax page's reading of what the member declared.
 *
 * WEALTH-6 · A gross income saved as ₹0 is ₹0. The page treated "gross > 0" as
 * "declared", so somebody whose only receipt was a ₹9,00,000 gift saved ₹0,
 * saw the form re-fill 9,00,000 and was estimated ₹85,800 of tax on the gift.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransaction } from "../domain/transactions.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

const ravi = { memberId: "m", source: "ui" as const };

async function setup() {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  seedMember(db, "p", "Priya");
  const bank = createAccount(db, ravi, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: rupees(10_000),
  }).id;
  const app = await startTestApp(db, { memberId: "m" });
  return { db, app, bank };
}

const grossField = (page: string) => /id="gross" name="gross"[^>]*value="([^"]+)"/.exec(page)?.[1];

describe("WEALTH-6 · a declared gross of ₹0", () => {
  test("is used as ₹0, not replaced by the ledger's receipts", async () => {
    const { db, app, bank } = await setup();
    try {
      createTransaction(db, ravi, { accountId: bank, amount: rupees(900_000), date: "2025-05-10", memo: "A gift" });

      // Before anything is saved, the ledger is the starting point.
      assert.equal(grossField(await (await app.get("/tax?fy=2025")).text()), "900000.00");

      const r = await app.post("/tax", { fy: "2025", gross: "0", s80c: "0", s80d: "0", other: "0" });
      assert.equal(r.status, 303);
      const page = await (await app.get("/tax?fy=2025")).text();
      assert.equal(grossField(page), "0.00");
      assert.doesNotMatch(page, /₹85,800/);
    } finally {
      await app.close();
    }
  });
});
