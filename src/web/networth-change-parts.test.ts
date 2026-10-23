/**
 * NW-1 · The net worth page and the month close show every part of the
 * change, including the balancing "Other" line for a period that starts on a
 * snapshot written before money owed to family and other liabilities were
 * recorded.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../db/db.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransfer } from "../domain/transactions.ts";
import { createAssetAccount, recordValuation } from "../domain/assets.ts";
import { snapshotNetWorth } from "../domain/networth.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

const ravi: Actor = { memberId: "m", source: "ui" };

async function setup(opts: { oldStart: boolean }) {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  const bank = createAccount(db, ravi, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: rupees(5_00_000),
  }).id;
  const flat = createAssetAccount(db, ravi, { name: "Flat", subtype: "physical" }).id;
  recordValuation(db, ravi, { accountId: flat, value: rupees(50_00_000), asOf: "2025-02-01" });
  const dues = createAccount(db, ravi, {
    name: "Society dues", kind: "tracking", subtype: "liability",
    openingDate: "2025-01-01", openingBalance: -rupees(1_00_000) as Paise,
  }).id;
  snapshotNetWorth(db, ravi, "2025-03-01");
  if (opts.oldStart) {
    execute(db, `UPDATE net_worth_snapshots SET owed_to_family = NULL, other_liabilities = NULL`);
  }
  recordValuation(db, ravi, { accountId: flat, value: rupees(55_00_000), asOf: "2025-03-15" });
  createTransfer(db, ravi, { fromAccountId: bank, toAccountId: dues, amount: rupees(20_000), date: "2025-03-20" });
  snapshotNetWorth(db, ravi, "2025-03-31");
  const app = await startTestApp(db, { memberId: "m" });
  return { db, app };
}

describe("NW-1 · the net worth page", () => {
  test("shows other assets and other liabilities as their own steps", async () => {
    const { app } = await setup({ oldStart: false });
    try {
      const page = await (await app.get("/net-worth")).text();
      assert.match(page, /Other assets/);
      assert.match(page, /Other liabilities repaid/);
      assert.doesNotMatch(page, /not recorded before/);
    } finally {
      await app.close();
    }
  });

  test("from an old snapshot, shows the balancing line with its date", async () => {
    const { app } = await setup({ oldStart: true });
    try {
      const page = await (await app.get("/net-worth")).text();
      assert.match(page, /Other \(not recorded before 31-03-2025\)/);
      assert.doesNotMatch(page, /Other liabilities repaid/);
    } finally {
      await app.close();
    }
  });
});

describe("NW-1 · the month close", () => {
  test("lists the parts that moved beyond the four it always shows", async () => {
    const { app } = await setup({ oldStart: true });
    try {
      const page = await (await app.get("/months/2025-03/close")).text();
      assert.match(page, /Money you actually saved/);
      assert.match(page, /Debt you repaid/);
      assert.match(page, /Other assets/);
      assert.match(page, /Other \(not recorded before 31-03-2025\)/);
      assert.match(page, /Other \(not recorded before 31-03-2025\)<\/td>\s*<td class="numeric">₹20,000<\/td>/);
    } finally {
      await app.close();
    }
  });
});
