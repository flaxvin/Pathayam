/**
 * WEALTH-15 · A dated net worth snapshot holds that date's figures.
 *
 * Month close snapshots the last day of the month it closes, and the backfill
 * the first of earlier months — but the statement read every balance, lot and
 * loan as of now. Closing June in September stamped September's money on
 * 30 June, and overwrote a correct snapshot already stored for that date.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST, addDays } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { price, units } from "../portfolio/holdings.ts";
import { createAccount } from "./accounts.ts";
import { createTransaction } from "./transactions.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordPrice, recordSale, recordSplit,
  recordValuation,
} from "./assets.ts";
import { createLoan, recordInstalment } from "./loans.ts";
import { netWorthStatement, snapshotNetWorth } from "./networth.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingBalance: rupees(100_000), openingDate: "2025-01-01",
  });
  return { db, bank };
}

// Dates well behind today, so the statement for them is a dated one.
const JUNE_30 = "2025-06-30";

describe("WEALTH-15 · a dated net worth statement", () => {
  test("money that arrived later is not in a June snapshot", () => {
    const { db, bank } = setup();
    createTransaction(db, actor, {
      accountId: bank.id, amount: rupees(500_000), date: "2025-09-01", memo: "Arrived in September",
    });

    const snap = snapshotNetWorth(db, actor, JUNE_30);
    assert.equal(snap.cash, rupees(100_000));
    assert.equal(snap.net_worth, rupees(100_000));
    // Today's statement still counts it.
    assert.equal(netWorthStatement(db).netWorth, rupees(600_000));
    db.close();
  });

  test("holdings are the lots held on the day: later buys out, later sales back in", () => {
    const { db } = setup();
    const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" });
    const fund = findOrCreateInstrument(db, actor, { name: "Fictional Fund", kind: "mutual-fund" });
    const lot = recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: fund.id, tradeDate: "2025-03-01",
      price: price(100), units: units(10),
    });
    recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: fund.id, tradeDate: "2025-08-01",
      price: price(100), units: units(30),
    });
    recordPrice(db, { instrumentId: fund.id, price: price(120), asOf: "2025-06-01", source: "t" });
    recordPrice(db, { instrumentId: fund.id, price: price(150), asOf: "2025-08-01", source: "t" });
    const holdingId = queryOne<{ holding_id: string }>(
      db, `SELECT holding_id FROM lots WHERE id = ?`, lot.id,
    )!.holding_id;
    // All ten June units sold in July, and a 2-for-1 split in October.
    recordSale(db, actor, { holdingId, units: units(10), price: price(130), date: "2025-07-15" });
    recordSplit(db, actor, { holdingId, date: "2025-10-01", ratio: 2 });

    const june = netWorthStatement(db, JUNE_30);
    const investments = june.assetGroups.find((g) => g.name === "Investments")!;
    // 10 units at ₹120 — not the 30 bought in August, and not missing the 10
    // sold in July. In today's split-adjusted terms that is 20 units at ₹60.
    assert.equal(investments.total, rupees(1_200));
    db.close();
  });

  test("a loan owes what it owed then", () => {
    const { db, bank } = setup();
    const loan = createLoan(db, actor, {
      lender: "Fictional Lender", loanType: "personal", sanctioned: rupees(100_000),
      sanctionDate: "2025-01-01", interestModel: "reducing", annualRatePct: 12,
      tenureMonths: 12, currentOutstanding: rupees(100_000),
    });
    recordInstalment(db, actor, {
      loanId: loan.id, date: "2025-08-05", amount: rupees(10_000),
      principal: rupees(9_000), interest: rupees(1_000), fromAccountId: bank.id,
    });

    const june = netWorthStatement(db, JUNE_30);
    const loans = june.liabilityGroups.find((g) => g.name === "Loans")!;
    assert.equal(loans.total, rupees(100_000));
    assert.equal(
      netWorthStatement(db).liabilityGroups.find((g) => g.name === "Loans")!.total,
      rupees(91_000),
    );
    db.close();
  });

  test("a hand-valued asset is worth what it was valued at by the day, not since", () => {
    const { db } = setup();
    const flat = createAssetAccount(db, actor, {
      name: "Flat", subtype: "physical", openingValue: rupees(50_00_000), asOf: "2025-01-01",
    });
    recordValuation(db, actor, { accountId: flat.id, value: rupees(60_00_000), asOf: "2025-09-01" });

    const snap = snapshotNetWorth(db, actor, JUNE_30);
    assert.equal(snap.other_assets, rupees(50_00_000), "September's revaluation is not June's");
    // Before the first valuation there is no stated figure at all.
    assert.equal(snapshotNetWorth(db, actor, "2024-12-31").other_assets, 0);
    // Today's statement reads the latest.
    assert.equal(
      netWorthStatement(db).assetGroups.find((g) => g.name === "Other assets")!.total,
      rupees(60_00_000),
    );
    db.close();
  });

  test("today's statement still counts a future-dated transaction", () => {
    const { db, bank } = setup();
    createTransaction(db, actor, {
      accountId: bank.id, amount: rupees(1_000), date: addDays(todayIST(), 3), memo: "Ahead",
    });
    assert.equal(netWorthStatement(db).netWorth, rupees(101_000));
    db.close();
  });
});
