/**
 * The /tax page's reading of what the member declared.
 *
 * WEALTH-6 · A gross income saved as ₹0 is ₹0. The page treated "gross > 0" as
 * "declared", so somebody whose only receipt was a ₹9,00,000 gift saved ₹0,
 * saw the form re-fill 9,00,000 and was estimated ₹85,800 of tax on the gift.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees, type Paise } from "../core/money.ts";
import { createLoan, recordInstalment } from "../domain/loans.ts";
import { listTaxPayments } from "../domain/tax.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransaction } from "../domain/transactions.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale, listHoldings,
  classifyInstrument,
} from "../domain/assets.ts";
import { units, price } from "../portfolio/holdings.ts";
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

describe("WEALTH-9 · slab-rated gains alone", () => {
  test("are enough for an estimate", async () => {
    const { db, app, bank } = await setup();
    try {
      // ₹21,00,000 of debt-fund gain in Ravi's own demat, and no salary.
      const demat = createAssetAccount(db, ravi, {
        name: "Demat", subtype: "investment", holderMemberId: "m", visibility: "household",
      }).id;
      const fund = findOrCreateInstrument(db, ravi, {
        name: "Gilt Fund", kind: "mutual-fund", symbol: "GILT", provider: "manual",
      }).id;
      classifyInstrument(db, ravi, fund, { assetClass: "debt" });
      recordPurchase(db, ravi, {
        accountId: demat, instrumentId: fund, tradeDate: "2025-04-10",
        price: price(100), units: units(1_000), fromAccountId: bank,
      });
      recordSale(db, ravi, {
        holdingId: listHoldings(db, demat)[0]!.id, date: "2025-12-01",
        units: units(1_000), price: price(2_200), toAccountId: bank,
      });
      await app.post("/tax", { fy: "2025", gross: "0", s80c: "0", s80d: "0", other: "0" });

      const page = await (await app.get("/tax?fy=2025")).text();
      assert.doesNotMatch(page, /Enter a gross income to see an estimate/);
      assert.match(page, /New regime/);
      assert.match(page, /Advance tax/);
    } finally {
      await app.close();
    }
  });
});

describe("TAX-1..3 · the ledger's home loan interest, and tax already paid", () => {
  test("a loan marked as for a house lived in is carried, overridable, and netted", async () => {
    const { db, app, bank } = await setup();
    const priya = await startTestApp(db, { memberId: "p" });
    try {
      const loan = createLoan(db, ravi, {
        holderMemberId: "m", lender: "Fictional Housing Finance", loanType: "home",
        sanctioned: rupees(10_00_000), sanctionDate: "2025-03-01", interestModel: "reducing",
        annualRatePct: 9, tenureMonths: 240, currentOutstanding: rupees(10_00_000),
        repaymentAccountId: bank, firstInstalmentDate: "2025-04-05",
      });
      for (let k = 0; k < 13; k++) {
        const date = new Date(Date.UTC(2025, 3 + k, 5)).toISOString().slice(0, 10);
        const interest = k === 0 ? rupees(3_100) : rupees(7_000);
        recordInstalment(db, ravi, {
          loanId: loan.id, date, amount: rupees(9_000), interest, principal: (rupees(9_000) - interest) as Paise,
        });
      }

      // Not marked: nothing carried, and "other deductions" no longer asks for it.
      let page = await (await app.get("/tax?fy=2025")).text();
      assert.doesNotMatch(page, /Home loan interest, s24\(b\)/);
      assert.doesNotMatch(page, /under section 24\(b\), which is often the largest/);

      assert.equal((await app.post(`/loans/${loan.id}/property`, { property_use: "self-occupied" })).status, 303);
      await app.post("/tax", { fy: "2025", gross: "1500000", s80c: "0", s80d: "0", other: "0", tds: "150000" });
      page = await (await app.get("/tax?fy=2025")).text();
      // 5/31 of ₹3,100 + 11 × ₹7,000 + 26/31 of ₹7,000, accrued.
      assert.match(page, /₹83,370\.97/);
      assert.match(page, /Home loan interest, s24\(b\)/);

      // The certificate says ₹2,50,000; the cap holds it at ₹2,00,000: old regime ₹1,95,000.
      await app.post("/tax", {
        fy: "2025", gross: "1500000", s80c: "0", s80d: "0", other: "0", tds: "150000", s24b: "250000",
      });
      assert.equal(
        (await app.post("/tax/payments", { fy: "2025", kind: "advance", date: "14-06-2025", amount: "30000" })).status,
        303,
      );
      page = await (await app.get("/tax?fy=2025")).text();
      assert.match(page, /₹1,95,000/);
      // Old: 1,95,000 − 1,80,000 paid. New: 97,500 − 1,80,000, a refund.
      assert.match(page, /₹15,000 to pay/);
      assert.match(page, /₹82,500 refund/);

      // Priya can neither see nor remove Ravi's payment.
      const id = listTaxPayments(db, "m", 2025)[0]!.id;
      assert.doesNotMatch(await (await priya.get("/tax?fy=2025")).text(), /14-06-2025/);
      assert.match(await (await app.get("/tax?fy=2025")).text(), /14-06-2025/);
      assert.notEqual((await priya.post(`/tax/payments/${id}/delete`, {})).status, 303);
      assert.equal(listTaxPayments(db, "m", 2025).length, 1);
      assert.equal((await app.post(`/tax/payments/${id}/delete`, {})).status, 303);
      assert.equal(listTaxPayments(db, "m", 2025).length, 0);
    } finally {
      await app.close();
      await priya.close();
    }
  });
});
