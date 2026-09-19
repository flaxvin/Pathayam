/**
 * A hand-valued asset over its whole life: bought, added to, sold in part, sold
 * entirely.
 *
 * The one that matters is the partial sale. Selling a few grams of gold is the
 * ordinary case and was impossible: disposal was all-or-nothing, so somebody
 * selling a portion had to close the account and create a new one for the
 * remainder — losing the history to record something that did not happen.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, testConfig, type TestApp } from "../web/harness.test-data.ts";
import { createAccount } from "./accounts.ts";
import { createAssetAccount, recordValuation, latestValuation } from "./assets.ts";
import { rupees, formatPaise, type Paise } from "../core/money.ts";
import { queryOne } from "../db/db.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

async function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-04-01", openingBalance: rupees(500_000),
  }).id;
  const gold = createAssetAccount(db, actor, {
    name: "SafeGold", subtype: "commodity", currency: "INR",
  });
  recordValuation(db, actor, {
    accountId: gold.id, value: rupees(200_000), asOf: "2026-08-01",
  });
  const app = await startTestApp(db, {
    memberId: "m-ravi", config: testConfig({}),
  });
  return { db, bank, gold, app };
}

function closedAt(db: ReturnType<typeof freshDb>, id: string) {
  return queryOne<{ closed_at: string | null }>(
    db, `SELECT closed_at FROM accounts WHERE id = ?`, id,
  )!.closed_at;
}

function balance(db: ReturnType<typeof freshDb>, id: string): Paise {
  return (queryOne<{ total: number }>(
    db,
    `SELECT COALESCE(SUM(amount),0) + (SELECT opening_balance FROM accounts WHERE id = ?) AS total
       FROM transactions WHERE account_id = ? AND deleted_at IS NULL`,
    id, id,
  )!.total) as Paise;
}

describe("selling part of it", () => {
  test("keeps the account open at what is left", async () => {
    const { db, bank, gold, app } = await setup();
    try {
      const res = await app.post(`/portfolio/asset/${gold.id}/dispose`, {
        proceeds: "40000", into_account: bank, remaining: "160000", on: "2026-09-10",
      });
      assert.equal(res.status, 303);

      assert.equal(closedAt(db, gold.id), null, "a partial sale closed the account");
      assert.equal(
        latestValuation(db, gold.id)?.value, rupees(160_000),
        "the remainder was not recorded",
      );
      assert.equal(
        balance(db, bank), rupees(540_000),
        `the proceeds did not arrive; bank is ${formatPaise(balance(db, bank))}`,
      );
    } finally { await app.close(); }
  });

  test("selling the last of it closes the account", async () => {
    const { db, bank, gold, app } = await setup();
    try {
      await app.post(`/portfolio/asset/${gold.id}/dispose`, {
        proceeds: "200000", into_account: bank, remaining: "0", on: "2026-09-10",
      });
      assert.ok(closedAt(db, gold.id), "selling everything left the account open");
      assert.equal(latestValuation(db, gold.id)?.value, 0);
    } finally { await app.close(); }
  });

  test("the history survives a full sale, because the account is closed not deleted", async () => {
    const { db, gold, app } = await setup();
    try {
      await app.post(`/portfolio/asset/${gold.id}/dispose`, {
        proceeds: "200000", remaining: "0", on: "2026-09-10",
      });
      const count = queryOne<{ n: number }>(
        db, `SELECT COUNT(*) AS n FROM asset_valuations WHERE account_id = ?`, gold.id,
      )!.n;
      assert.ok(count >= 2, "the earlier valuation was lost");
    } finally { await app.close(); }
  });

  test("proceeds can go nowhere, for something given away", async () => {
    const { db, gold, app } = await setup();
    try {
      const res = await app.post(`/portfolio/asset/${gold.id}/dispose`, {
        proceeds: "0", remaining: "0", on: "2026-09-10",
      });
      assert.equal(res.status, 303);
      assert.ok(closedAt(db, gold.id));
    } finally { await app.close(); }
  });

  test("a negative remainder is refused", async () => {
    const { gold, app } = await setup();
    try {
      const res = await app.post(`/portfolio/asset/${gold.id}/dispose`, {
        proceeds: "40000", remaining: "-1000", on: "2026-09-10",
      });
      assert.equal(res.status, 422);
    } finally { await app.close(); }
  });
});

describe("adding to it", () => {
  test("records the payment and the new value", async () => {
    const { db, bank, gold, app } = await setup();
    try {
      const res = await app.post(`/portfolio/asset/${gold.id}/add`, {
        spent: "50000", paid_from: bank, new_value: "250000", on: "2026-09-10",
      });
      assert.equal(res.status, 303);
      assert.equal(latestValuation(db, gold.id)?.value, rupees(250_000));
      assert.equal(
        balance(db, bank), rupees(450_000),
        "the money did not leave — net worth would rise out of nothing",
      );
    } finally { await app.close(); }
  });

  test("what you paid and what it is worth are allowed to differ", async () => {
    // Gold bought at a premium is worth the market rate the moment you own it.
    const { db, bank, gold, app } = await setup();
    try {
      await app.post(`/portfolio/asset/${gold.id}/add`, {
        spent: "50000", paid_from: bank, new_value: "245000", on: "2026-09-10",
      });
      assert.equal(latestValuation(db, gold.id)?.value, rupees(245_000));
      assert.equal(balance(db, bank), rupees(450_000));
    } finally { await app.close(); }
  });
});
