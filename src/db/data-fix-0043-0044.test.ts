/**
 * The data-fix migrations repair rows the old code actually wrote.
 *
 * 0043 and 0044 change no schema, only data, so this builds rows with today's
 * domain code, bends them into exactly the shape the old code stored, rewinds
 * user_version to 42 and migrates forward — the path a household's database
 * takes on its first start after upgrading.
 *
 *   0043 · A loan settled for less than it owed: the old closeLoan stored ONE
 *          row with interest = settlement − outstanding, so ₹40,000 against a
 *          ₹50,000 outstanding was −₹10,000 of interest, and the interest
 *          report showed negative interest for the year.
 *   0044 · A bonus issue: the old code multiplied every lot's units and divided
 *          its price, keeping the original date and cost — a split. A bonus is
 *          new shares at nil cost, dated on allotment.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryAll, migrate, type DB } from "./db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createLoan, recordDisbursement } from "../domain/loans.ts";
import { loanInterestByFinancialYear } from "../domain/reports.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, listHoldings, classifyInstrument, lotsFor,
} from "../domain/assets.ts";
import { units, price } from "../portfolio/holdings.ts";
import type { IsoDate } from "../core/dates.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function household(): { db: DB; bank: string } {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`, "m", "f@e.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, { name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2023-01-01", openingBalance: rupees(500_000) }).id;
  return { db, bank };
}

function rewindAndMigrate(db: DB): void {
  db.exec("PRAGMA user_version = 42");
  migrate(db, false);
}

describe("0043 · a settlement below the outstanding becomes a waiver", () => {
  test("negative interest is split into principal paid and principal forgiven", () => {
    const { db, bank } = household();
    const loan = createLoan(db, actor, {
      lender: "Fictional Finance", loanType: "personal", sanctioned: rupees(50_000) as Paise,
      sanctionDate: "2025-04-01" as IsoDate, interestModel: "reducing", annualRatePct: 12,
      tenureMonths: 12, firstInstalmentDate: "2025-05-05" as IsoDate, repaymentAccountId: bank,
    });
    recordDisbursement(db, actor, { loanId: loan.id, date: "2025-04-05" as IsoDate,
      amount: rupees(50_000) as Paise, destination: "budget-account", destinationAccountId: bank });
    // Exactly the old closeLoan's row.
    execute(db,
      `INSERT INTO loan_payments (id,loan_id,date,amount,principal,interest,estimated,kind,note,created_at,created_by)
       VALUES ('old',?,?,?,?,?,0,'foreclosure','Settled',?,'m')`,
      loan.id, "2025-10-01", rupees(40_000), rupees(50_000), -rupees(10_000), nowIST());
    assert.ok(loanInterestByFinancialYear(db).some((r) => r.interest < 0), "the fixture is not the old shape");

    rewindAndMigrate(db);

    const rows = queryAll<{ id: string; amount: number; principal: number; interest: number }>(
      db, `SELECT id, amount, principal, interest FROM loan_payments WHERE kind = 'foreclosure' ORDER BY amount DESC`);
    assert.deepEqual(rows.map((r) => [r.amount, r.principal, r.interest]), [
      [rupees(40_000), rupees(40_000), 0],
      [0, rupees(10_000), 0],
    ], "paid ₹40,000 of principal, and ₹10,000 forgiven");
    assert.ok(loanInterestByFinancialYear(db).every((r) => r.interest >= 0), "interest is still negative");
  });
});

describe("0044 · a bonus issue becomes new shares at nil cost", () => {
  function holding() {
    const { db, bank } = household();
    const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" }).id;
    const inst = findOrCreateInstrument(db, actor, { name: "Fictional Co", kind: "equity", symbol: "FC", provider: "manual" }).id;
    classifyInstrument(db, actor, inst, { assetClass: "equity" });
    recordPurchase(db, actor, { accountId: demat, instrumentId: inst, tradeDate: "2023-01-02",
      price: price(1000), units: units(100), fromAccountId: bank });
    const holdingId = listHoldings(db, demat)[0]!.id;
    // What the old recordSplit(kind "bonus", ratio 2) wrote: a split.
    execute(db, `UPDATE lots SET units = units * 2, price = price / 2 WHERE holding_id = ?`, holdingId);
    execute(db,
      `INSERT INTO holding_events (id,holding_id,date,kind,ratio,created_at,created_by)
       VALUES ('bonus-1',?,'2025-06-02','bonus',2,'2099-01-01T00:00:00.000+05:30','m')`, holdingId);
    return { db, holdingId };
  }

  test("the original lot gets its units and price back, and a nil-cost lot is added", () => {
    const { db, holdingId } = holding();
    rewindAndMigrate(db);
    const lots = lotsFor(db, holdingId).map((l) => [l.tradeDate, l.units, l.cost]);
    assert.deepEqual(lots, [
      ["2023-01-02", units(100), rupees(100_000)],
      ["2025-06-02", units(100), 0],
    ]);
  });

  test("a holding sold after the bonus is left for a person to review", () => {
    const { db, holdingId } = holding();
    execute(db,
      `INSERT INTO holding_events (id,holding_id,date,kind,units,created_at,created_by)
       VALUES ('sale-1',?,'2025-09-01','sale',?,'2099-02-01T00:00:00.000+05:30','m')`, holdingId, units(50));
    const before = lotsFor(db, holdingId).map((l) => [l.units, l.cost]);
    rewindAndMigrate(db);
    assert.deepEqual(lotsFor(db, holdingId).map((l) => [l.units, l.cost]), before,
      "realised gains were booked on the old basis; rewriting lots under them would hide that");
  });
});
