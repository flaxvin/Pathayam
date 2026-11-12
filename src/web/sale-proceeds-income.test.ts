/**
 * ENG-23 · Selling an asset valued by hand turns it into cash; that is money
 * coming back, not income.
 *
 * Gold coins sold for ₹60,000 into the bank showed as ₹60,000 of income in
 * the Overview's income chart, FIRE's annual income and savings rate, a
 * month's close and the Tax page's starting figure. The sale now names the
 * money it brought in (asset_valuations.proceeds_transaction_id), and those
 * figures leave it out. Ready to Assign still takes it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import { todayIST, monthOf, fiscalYearOf } from "../core/dates.ts";
import { queryOne } from "../db/db.ts";
import { createAccount } from "../domain/accounts.ts";
import { createAssetAccount } from "../domain/assets.ts";
import { incomeVsExpense } from "../domain/reports.ts";
import { incomeInFinancialYear } from "../domain/tax.ts";
import { fireProjection } from "../domain/fire.ts";
import { monthCloseView } from "../domain/month-close.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget } from "../engine/engine.ts";
import { deleteTransaction } from "../domain/transactions.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

const ravi = { memberId: "m", source: "ui" as const };

describe("ENG-23 · a hand-valued asset's sale proceeds are not income", () => {
  test("left out of reports, FIRE, tax and month close; still in Ready to Assign", async () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    const today = todayIST();
    const bank = createAccount(db, ravi, {
      name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: rupees(1_00_000),
    }).id;
    const gold = createAssetAccount(db, ravi, {
      name: "Gold coins", subtype: "commodity", openingValue: rupees(50_000), asOf: "2025-01-01",
    }).id;
    const month = monthOf(today);
    const fy = fiscalYearOf(today);
    const read = () => ({
      trend: incomeVsExpense(db, "2025-01-01", today).reduce((s, p) => s + p.income, 0),
      tax: incomeInFinancialYear(db, fy, [bank]),
      fire: fireProjection(db, { asOf: today }).annualIncome,
      close: monthCloseView(db, month, today).outcome.income,
      rta: computeBudget(loadEngineInput(db, { through: month })).get(month)!.readyToAssign,
    });
    const before = read();

    const app = await startTestApp(db, { memberId: "m" });
    try {
      const sell = await app.post(`/portfolio/asset/${gold}/dispose`, {
        proceeds: "60000", on: today, into_account: bank, remaining: "",
      });
      assert.equal(sell.status, 303);
    } finally {
      await app.close();
    }

    const after = read();
    assert.equal(after.trend, before.trend, "Overview income chart");
    assert.equal(after.tax, before.tax, "Tax page starting figure");
    assert.equal(after.fire, before.fire, "FIRE annual income");
    assert.equal(after.close, before.close, "month close");
    assert.equal(after.rta, before.rta + rupees(60_000), "Ready to Assign still takes it");

    // The link holds nothing up: the proceeds can still be deleted.
    const link = queryOne<{ id: string }>(db,
      `SELECT proceeds_transaction_id AS id FROM asset_valuations WHERE proceeds_transaction_id IS NOT NULL`)!.id;
    deleteTransaction(db, ravi, link);
    assert.equal(read().rta, before.rta);
  });
});
