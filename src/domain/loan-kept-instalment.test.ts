/**
 * EXTRA-1 · "Reduce the tenure" keeps the instalment — the one the borrower had.
 *
 * The tenure was the only thing stored, and it is a whole number of months. A
 * ₹1,00,000 loan at 12% over a year asks ₹8,884.88 a month; ₹20,000 prepaid
 * "keeping the instalment" left ₹80,000, which that instalment clears in 9.6
 * months. The tenure became 10, the projection priced ₹80,000 over ten months
 * at ₹8,446.57, and the notice beside it said the instalment was unchanged.
 * The instalment kept is now stored, and the projection runs the loan down at it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne, type DB } from "../db/db.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { nowIST, todayIST, addDays } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import {
  createLoan, recordInstalment, recordPrepayment, recordRateChange, projectLoan, getLoan,
} from "./loans.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup(tenureMonths = 12) {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "ravi@example.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(5_00_000),
  }).id;
  const loan = createLoan(db, actor, {
    lender: "Fictional Bank", loanType: "personal", sanctioned: rupees(1_00_000),
    sanctionDate: "2025-01-01", interestModel: "reducing", annualRatePct: 12,
    tenureMonths, currentOutstanding: rupees(1_00_000), repaymentAccountId: bank,
  });
  return { db, bank, loan };
}

const emi = (db: DB, id: string) => projectLoan(db, id)!.emi;

function undoLast(db: DB, action: string) {
  const id = queryOne<{ id: string }>(
    db, `SELECT id FROM events WHERE entity = 'loan' AND action = ? ORDER BY seq DESC LIMIT 1`, action,
  )!.id;
  const result = undoEvent(db, id, actor, { force: true });
  assert.ok(result.ok, result.reason);
}

describe("EXTRA-1 · a prepayment that reduces the tenure keeps the instalment", () => {
  test("₹20,000 off ₹1,00,000 at 12% over a year: still ₹8,884.88, now ten instalments", () => {
    const { db, loan } = setup();
    assert.equal(emi(db, loan.id), 888488);

    recordPrepayment(db, actor, { loanId: loan.id, date: "2025-01-10", amount: rupees(20_000) as Paise, mode: "tenure" });

    const p = projectLoan(db, loan.id)!;
    assert.equal(p.emi, 888488, "the instalment the borrower kept");
    assert.equal(p.schedule.instalments[0]!.payment, 888488);
    assert.equal(p.schedule.months, 10);
    assert.ok(p.schedule.instalments.at(-1)!.payment < 888488, "the last one is what remains");
    assert.equal(getLoan(db, loan.id)!.tenure_months, 10);
    assert.equal(getLoan(db, loan.id)!.emi_pinned, 888488);
  });

  test("an instalment paid after it leaves the kept instalment where it is", () => {
    const { db, bank, loan } = setup();
    recordPrepayment(db, actor, { loanId: loan.id, date: "2025-01-10", amount: rupees(20_000) as Paise, mode: "tenure" });
    recordInstalment(db, actor, { loanId: loan.id, date: "2025-02-05", amount: 888488 as Paise, fromAccountId: bank });
    assert.equal(emi(db, loan.id), 888488);
  });

  test("a later prepayment that reduces the instalment lets it go", () => {
    const { db, loan } = setup();
    recordPrepayment(db, actor, { loanId: loan.id, date: "2025-01-10", amount: rupees(20_000) as Paise, mode: "tenure" });
    recordPrepayment(db, actor, { loanId: loan.id, date: "2025-01-12", amount: rupees(10_000) as Paise, mode: "emi" });
    assert.equal(getLoan(db, loan.id)!.emi_pinned, null);
    assert.ok(emi(db, loan.id) < 888488);
  });

  test("undoing the prepayment puts the instalment back as it was — derived, not kept", () => {
    const { db, loan } = setup();
    recordPrepayment(db, actor, { loanId: loan.id, date: "2025-01-10", amount: rupees(20_000) as Paise, mode: "tenure" });
    undoLast(db, "instalment");
    const after = getLoan(db, loan.id)!;
    assert.equal(after.emi_pinned, null);
    assert.equal(after.tenure_months, 12);
    assert.equal(emi(db, loan.id), 888488);
  });

  test("undoing an instalment-reducing prepayment restores the kept instalment", () => {
    const { db, loan } = setup();
    recordPrepayment(db, actor, { loanId: loan.id, date: "2025-01-10", amount: rupees(20_000) as Paise, mode: "tenure" });
    recordPrepayment(db, actor, { loanId: loan.id, date: "2025-01-12", amount: rupees(10_000) as Paise, mode: "emi" });
    undoLast(db, "instalment");
    assert.equal(getLoan(db, loan.id)!.emi_pinned, 888488);
    assert.equal(emi(db, loan.id), 888488);
  });
});

describe("EXTRA-1 · WEALTH-18's rate change uses the same kept instalment", () => {
  test("a rise taken by keeping the instalment holds it exactly", () => {
    const { db, loan } = setup(24);
    const before = emi(db, loan.id);
    recordRateChange(db, actor, { loanId: loan.id, effectiveFrom: todayIST(), annualRatePct: 14, keep: "emi" });
    assert.equal(emi(db, loan.id), before);
    assert.equal(getLoan(db, loan.id)!.emi_pinned, before);
    assert.ok(getLoan(db, loan.id)!.tenure_months > 24);
  });

  test("a later change keeping the tenure moves it from its own day, not before", () => {
    const { db, loan } = setup();
    recordPrepayment(db, actor, { loanId: loan.id, date: "2025-01-10", amount: rupees(20_000) as Paise, mode: "tenure" });

    const ahead = addDays(todayIST(), 20);
    recordRateChange(db, actor, { loanId: loan.id, effectiveFrom: ahead, annualRatePct: 11, keep: "tenure" });
    assert.equal(emi(db, loan.id), 888488, "nothing moves before the rate applies");
    assert.equal(getLoan(db, loan.id)!.emi_pinned_until, ahead);

    recordRateChange(db, actor, { loanId: loan.id, effectiveFrom: todayIST(), annualRatePct: 11, keep: "tenure" });
    assert.equal(getLoan(db, loan.id)!.emi_pinned, null, "dated today, the instalment moves now");
    assert.notEqual(emi(db, loan.id), 888488);

    undoLast(db, "rate-change");
    assert.equal(getLoan(db, loan.id)!.emi_pinned, 888488);
    assert.equal(getLoan(db, loan.id)!.emi_pinned_until, ahead);
  });
});
