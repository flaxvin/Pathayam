/**
 * ENG-22 · Borrowed money is not income.
 *
 * A ₹5,00,000 personal loan paid into savings was ₹5,00,000 of income: in
 * FIRE's annual income and savings rate, the Overview's income chart, a
 * month's close and the Tax page's starting figure. It still reaches Ready to
 * Assign — it is cash to give a job to — but it is not earnings.
 *
 * Each way borrowed or returned money arrives, against the income figures:
 *   · a loan drawn when it is added, to a budget account
 *   · a later draw (a tranche or top-up)
 *   · a card EMI conversion's credit on the card
 *   · money a family member lends you, or repays you (a transfer: already out)
 *   · a deposit's proceeds moved to the bank (a transfer: already out)
 *   · ENG-23 · a portfolio sale's proceeds (a hand-valued asset's sale is in
 *     src/web/sale-proceeds-income.test.ts, since its route writes it)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne, migrate, type DB } from "../db/db.ts";
import { MIGRATIONS } from "../db/schema.ts";
import { nowIST, monthOf, fiscalYearOf } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { createAccount, createCard } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createTransaction, createTransfer } from "./transactions.ts";
import { createLoan, recordDisbursement } from "./loans.ts";
import { convertToEmi } from "./card-emi.ts";
import { createFamilyLoan, recordAdvance, recordRepayment } from "./family-loans.ts";
import { incomeVsExpense } from "./reports.ts";
import { incomeInFinancialYear } from "./tax.ts";
import { fireProjection } from "./fire.ts";
import { monthCloseView } from "./month-close.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale, recordDividend, listHoldings,
} from "./assets.ts";
import { units, price } from "../portfolio/holdings.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget } from "../engine/engine.ts";

const actor: Actor = { memberId: "m", source: "ui" };
const OPENED = "2025-06-01";
const AS_OF = "2026-06-01";
const SALARY = rupees(1_00_000);
const LOAN = rupees(5_00_000);

function household(): { db: DB; bank: string; groceries: string } {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "ravi@example.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Savings", kind: "budget", subtype: "savings", openingDate: OPENED, openingBalance: 0 as Paise,
  }).id;
  const group = createGroup(db, actor, "Living");
  const groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" }).id;
  // A salary on the 10th of every month for a year, and groceries.
  for (let i = 0; i < 12; i++) {
    const y = 2025 + Math.floor((5 + i) / 12);
    const date = `${y}-${String(((5 + i) % 12) + 1).padStart(2, "0")}-10`;
    createTransaction(db, actor, { accountId: bank, amount: SALARY, date, cleared: true });
    createTransaction(db, actor, {
      accountId: bank, amount: -rupees(40_000) as Paise, date, categoryId: groceries, cleared: true,
    });
  }
  return { db, bank, groceries };
}

const DRAWN = "2026-02-15";
const FY = fiscalYearOf("2025-06-10");

function personalLoan(db: DB, bank: string, drawnNow = LOAN): string {
  return createLoan(db, actor, {
    lender: "Fictional Bank", loanType: "personal", sanctioned: rupees(8_00_000),
    sanctionDate: DRAWN, interestModel: "reducing", annualRatePct: 12, tenureMonths: 36,
    repaymentAccountId: bank, disbursedAtCreation: drawnNow,
    disbursementDestination: "budget-account", disbursementAccountId: bank,
  }).id;
}

const trendIncome = (db: DB) =>
  incomeVsExpense(db, OPENED, AS_OF).reduce((s, p) => s + p.income, 0);
const rta = (db: DB, month: string) =>
  computeBudget(loadEngineInput(db, { through: month })).get(month)!.readyToAssign;

describe("ENG-22 · a loan's money paid in is not income", () => {
  test("baseline: a year of salary is the income", () => {
    const { db, bank } = household();
    void bank;
    assert.equal(trendIncome(db), SALARY * 12);
    assert.equal(fireProjection(db, { asOf: AS_OF }).annualIncome > 0, true);
  });

  test("a personal loan drawn to savings when added: out of reports, FIRE, tax and month close", () => {
    const { db, bank } = household();
    const before = {
      trend: trendIncome(db),
      fire: fireProjection(db, { asOf: AS_OF }),
      tax: incomeInFinancialYear(db, FY, [bank]),
      close: monthCloseView(db, monthOf(DRAWN), AS_OF).outcome.income,
      rta: rta(db, monthOf(DRAWN)),
    };
    personalLoan(db, bank);

    assert.equal(trendIncome(db), before.trend, "Overview income chart");
    const fire = fireProjection(db, { asOf: AS_OF });
    assert.equal(fire.annualIncome, before.fire.annualIncome, "FIRE annual income");
    assert.equal(fire.savingsRatePct, before.fire.savingsRatePct, "FIRE savings rate");
    assert.equal(incomeInFinancialYear(db, FY, [bank]), before.tax, "Tax page starting figure");
    assert.equal(monthCloseView(db, monthOf(DRAWN), AS_OF).outcome.income, before.close, "month close");

    // The ledger is untouched: the money is in the bank and Ready to Assign.
    assert.equal(rta(db, monthOf(DRAWN)), before.rta + LOAN, "Ready to Assign still takes it");
    const legs = queryOne<{ n: number }>(db,
      `SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND amount = ? AND deleted_at IS NULL`,
      bank, LOAN)!.n;
    assert.equal(legs, 1);
  });

  test("a later draw (a tranche or top-up) is left out too, and undoing it changes nothing", () => {
    const { db, bank } = household();
    const loan = personalLoan(db, bank, rupees(2_00_000) as Paise);
    const base = { trend: trendIncome(db), tax: incomeInFinancialYear(db, FY, [bank]) };
    const fireBase = fireProjection(db, { asOf: AS_OF });
    recordDisbursement(db, actor, {
      loanId: loan, date: "2026-03-05", amount: rupees(3_00_000) as Paise,
      destination: "budget-account", destinationAccountId: bank,
    });
    assert.equal(trendIncome(db), base.trend);
    assert.equal(incomeInFinancialYear(db, FY, [bank]), base.tax);
    assert.equal(fireProjection(db, { asOf: AS_OF }).annualIncome, fireBase.annualIncome);
    assert.equal(monthCloseView(db, "2026-03", AS_OF).outcome.income, SALARY);

    const ev = queryOne<{ id: string }>(db,
      `SELECT id FROM events WHERE entity = 'loan' AND action = 'disburse' ORDER BY seq DESC LIMIT 1`)!.id;
    assert.ok(undoEvent(db, ev, actor).ok);
    assert.equal(trendIncome(db), base.trend);
  });

  test("the money a loan pays in can still be deleted or taken back on its own, as before", () => {
    const { db, bank } = household();
    personalLoan(db, bank);
    const leg = queryOne<{ transaction_id: string }>(db,
      `SELECT transaction_id FROM loan_disbursements`)!.transaction_id;
    const ev = queryOne<{ id: string }>(db,
      `SELECT id FROM events WHERE entity = 'transaction' AND entity_id = ? AND action = 'create'`, leg)!;
    assert.ok(undoEvent(db, ev.id, actor).ok);
    assert.equal(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM transactions WHERE id = ?`, leg)!.n, 0);
    assert.equal(queryOne<{ t: string | null }>(db, `SELECT transaction_id AS t FROM loan_disbursements`)!.t, null);
  });

  test("a card EMI conversion's credit on the card is not money that came in", () => {
    const { db, bank, groceries } = household();
    const card = createAccount(db, actor, {
      name: "Card", kind: "credit", subtype: "credit-card", openingDate: OPENED,
    });
    createCard(db, actor, { accountId: card.id, label: "Primary", isPrimary: true });
    const charge = createTransaction(db, actor, {
      accountId: card.id, amount: -rupees(60_000) as Paise, date: "2026-04-05",
      categoryId: groceries, cleared: true,
    });
    const before = {
      close: monthCloseView(db, "2026-04", AS_OF).outcome.income,
      trend: trendIncome(db), tax: incomeInFinancialYear(db, FY + 1, [bank, card.id]),
    };
    const fireBefore = fireProjection(db, { asOf: AS_OF });
    convertToEmi(db, actor, { transactionId: charge.id, tenureMonths: 12, annualRatePct: 15 });
    assert.equal(monthCloseView(db, "2026-04", AS_OF).outcome.income, before.close, "month close");
    assert.equal(trendIncome(db), before.trend);
    assert.equal(incomeInFinancialYear(db, FY + 1, [bank, card.id]), before.tax);
    assert.equal(fireProjection(db, { asOf: AS_OF }).annualIncome, fireBefore.annualIncome);
  });

  test("money a family member lends you, or repays you, is not income", () => {
    const { db, bank } = household();
    const base = {
      trend: trendIncome(db), tax: incomeInFinancialYear(db, FY, [bank]),
      fire: fireProjection(db, { asOf: AS_OF }).annualIncome,
      close: monthCloseView(db, "2026-02", AS_OF).outcome.income,
    };
    const uncle = createFamilyLoan(db, actor, { counterparty: "Uncle", startedAt: OPENED });
    recordRepayment(db, actor, { loanId: uncle.id, amount: rupees(2_00_000) as Paise, date: "2026-02-01", accountId: bank });
    const cousin = createFamilyLoan(db, actor, { counterparty: "Cousin", startedAt: OPENED });
    recordAdvance(db, actor, { loanId: cousin.id, amount: rupees(50_000) as Paise, date: "2025-12-01", fromAccountId: bank });
    recordRepayment(db, actor, { loanId: cousin.id, amount: rupees(50_000) as Paise, date: "2026-02-20", accountId: bank });
    assert.equal(trendIncome(db), base.trend);
    assert.equal(incomeInFinancialYear(db, FY, [bank]), base.tax);
    assert.equal(fireProjection(db, { asOf: AS_OF }).annualIncome, base.fire);
    assert.equal(monthCloseView(db, "2026-02", AS_OF).outcome.income, base.close);
  });

  test("a deposit's proceeds moved to the bank are not income", () => {
    const { db, bank } = household();
    const fd = createAccount(db, actor, {
      name: "Fixed deposit", kind: "tracking", subtype: "fixed-deposit",
      openingDate: OPENED, openingBalance: rupees(3_00_000) as Paise,
    }).id;
    const base = { trend: trendIncome(db), tax: incomeInFinancialYear(db, FY, [bank]) };
    const fire = fireProjection(db, { asOf: AS_OF }).annualIncome;
    createTransfer(db, actor, { fromAccountId: fd, toAccountId: bank, amount: rupees(3_00_000) as Paise, date: "2026-03-01" });
    assert.equal(trendIncome(db), base.trend);
    assert.equal(incomeInFinancialYear(db, FY, [bank]), base.tax);
    assert.equal(fireProjection(db, { asOf: AS_OF }).annualIncome, fire);
  });

  test("0075 links draws recorded before it from their events", () => {
    const { db, bank } = household();
    const loan = personalLoan(db, bank);
    recordDisbursement(db, actor, {
      loanId: loan, date: "2026-03-05", amount: rupees(1_00_000) as Paise,
      destination: "budget-account", destinationAccountId: bank,
    });
    recordDisbursement(db, actor, {
      loanId: loan, date: "2026-03-06", amount: rupees(50_000) as Paise, destination: "third-party",
    });
    const linked = () => queryOne<{ n: number }>(db,
      `SELECT COUNT(*) AS n FROM loan_disbursements d JOIN transactions t ON t.id = d.transaction_id
        WHERE t.account_id = d.destination_account_id AND t.amount = d.amount`)!.n;
    assert.equal(linked(), 2);
    const trend = trendIncome(db);

    // Back to how the app left them before 0075.
    db.exec(`DROP INDEX idx_disbursements_tx`);
    db.exec(`ALTER TABLE loan_disbursements DROP COLUMN transaction_id`);
    db.exec(`ALTER TABLE asset_valuations DROP COLUMN proceeds_transaction_id`);
    db.exec(`PRAGMA user_version = 74`);
    migrate(db, false, 75);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);

    assert.equal(linked(), 2);
    assert.equal(queryOne<{ n: number }>(db,
      `SELECT COUNT(*) AS n FROM loan_disbursements WHERE destination = 'third-party' AND transaction_id IS NOT NULL`)!.n, 0);
    assert.equal(trendIncome(db), trend);
  });
});

describe("ENG-23 · a sale's proceeds are money coming back, not income", () => {
  test("a fund sold into savings: out of reports, FIRE, tax and month close; a dividend stays in", () => {
    const { db, bank } = household();
    const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" }).id;
    const fund = findOrCreateInstrument(db, actor, {
      name: "Fictional Index Fund", kind: "mutual-fund", symbol: "F", provider: "manual",
    }).id;
    recordPurchase(db, actor, {
      accountId: demat, instrumentId: fund, tradeDate: "2025-06-02", price: price(100), units: units(2_000),
    });
    const holdingId = listHoldings(db, demat)[0]!.id;
    const before = {
      trend: trendIncome(db), tax: incomeInFinancialYear(db, FY, [bank]),
      fire: fireProjection(db, { asOf: AS_OF }),
      close: monthCloseView(db, "2026-03", AS_OF).outcome.income,
      rta: rta(db, "2026-03"),
    };
    // ₹3,00,000 of proceeds, ₹1,00,000 of it gain.
    recordSale(db, actor, { holdingId, units: units(2_000), price: price(150), date: "2026-03-12", toAccountId: bank });

    assert.equal(trendIncome(db), before.trend, "Overview income chart");
    const fire = fireProjection(db, { asOf: AS_OF });
    assert.equal(fire.annualIncome, before.fire.annualIncome, "FIRE annual income");
    assert.equal(fire.savingsRatePct, before.fire.savingsRatePct, "FIRE savings rate");
    assert.equal(incomeInFinancialYear(db, FY, [bank]), before.tax, "Tax page starting figure");
    assert.equal(monthCloseView(db, "2026-03", AS_OF).outcome.income, before.close, "month close");
    assert.equal(rta(db, "2026-03"), before.rta + rupees(3_00_000), "Ready to Assign still takes it");

    // A dividend paid out is earned, so it is still income.
    const fund2 = findOrCreateInstrument(db, actor, {
      name: "Fictional Dividend Fund", kind: "mutual-fund", symbol: "D", provider: "manual",
    }).id;
    recordPurchase(db, actor, {
      accountId: demat, instrumentId: fund2, tradeDate: "2025-06-02", price: price(100), units: units(100),
    });
    const h2 = listHoldings(db, demat).find((h) => h.instrument_id === fund2)!.id;
    recordDividend(db, actor, { holdingId: h2, date: "2026-03-20", amount: rupees(5_000) as Paise, toAccountId: bank });
    assert.equal(trendIncome(db), before.trend + rupees(5_000));
    assert.equal(incomeInFinancialYear(db, FY, [bank]), before.tax + rupees(5_000));
  });
});
