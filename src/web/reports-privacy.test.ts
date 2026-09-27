/**
 * WEALTH-23 · /reports names nothing from another member's private accounts.
 *
 * "Loan interest by financial year" and "Realised gains" were the two sections
 * of /reports built without a viewer: Priya's page named Ravi's private lender
 * with its interest and principal, and listed the parcels, cost, proceeds and
 * gain of the fund in his private demat — the loan itself 404s for her.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale, listHoldings,
} from "../domain/assets.ts";
import { createLoan, recordInstalment } from "../domain/loans.ts";
import { price, units } from "../portfolio/holdings.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

const ravi: Actor = { memberId: "m", source: "ui" };

function seed() {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  seedMember(db, "p", "Priya");
  const budgetId = ensurePersonalBudget(db, "m", "Ravi").id;
  const bank = createAccount(db, ravi, {
    name: "Ravi private bank", kind: "budget", subtype: "savings", openingDate: "2024-01-01",
    openingBalance: rupees(500_000), holderMemberId: "m", visibility: "private", budgetId,
  }).id;
  const demat = createAssetAccount(db, ravi, {
    name: "Ravi private demat", subtype: "investment", holderMemberId: "m", visibility: "private",
  }).id;
  const inst = findOrCreateInstrument(db, ravi, {
    name: "Bandersnatch Fictional Fund", kind: "equity", symbol: "BFF", provider: "manual",
  }).id;
  recordPurchase(db, ravi, {
    accountId: demat, instrumentId: inst, tradeDate: "2025-05-01", price: price(100), units: units(100),
  });
  recordSale(db, ravi, {
    holdingId: listHoldings(db, demat)[0]!.id, units: units(50), price: price(300), date: "2025-09-01",
  });
  const loan = createLoan(db, ravi, {
    lender: "Jabberwock Fictional Lender", loanType: "personal", sanctioned: rupees(100_000),
    sanctionDate: "2025-01-01", interestModel: "reducing", annualRatePct: 18, tenureMonths: 12,
    currentOutstanding: rupees(100_000), repaymentAccountId: bank,
    holderMemberId: "m", visibility: "private",
  });
  recordInstalment(db, ravi, { loanId: loan.id, date: "2025-06-05", amount: rupees(9_168) });
  return db;
}

describe("WEALTH-23 · /reports privacy", () => {
  test("another member's /reports names neither the private lender nor the private fund", async () => {
    const app = await startTestApp(seed(), { memberId: "p" });
    try {
      const page = await (await app.get("/reports")).text();
      assert.ok(!page.includes("Jabberwock Fictional Lender"), "the private loan's lender is hidden");
      assert.ok(!page.includes("Bandersnatch Fictional Fund"), "the private demat's sale is hidden");
    } finally { await app.close(); }
  });

  test("the holder still sees both", async () => {
    const app = await startTestApp(seed(), { memberId: "m" });
    try {
      const page = await (await app.get("/reports")).text();
      assert.ok(page.includes("Jabberwock Fictional Lender"));
      assert.ok(page.includes("Bandersnatch Fictional Fund"));
    } finally { await app.close(); }
  });
});
