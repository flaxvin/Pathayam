/**
 * WEALTH-21 · Undoing something a loan recorded reverses it, or says why not.
 *
 * The loan's undo handler knew "create" and "close". Every other action —
 * an instalment, a prepayment, a rate change, a re-anchor — was answered
 * "Reversed a change to the loan" and marked undone while nothing moved: the
 * ₹5,000 payment stayed, the bank stayed ₹5,000 down, the outstanding stayed
 * ₹96,000. Undoing a settlement's close reopened the loan and left its account
 * closed, so the loan fell out of every account list.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne, queryAll, type DB } from "../db/db.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import {
  createLoan, recordInstalment, recordPrepayment, recordRateChange, reanchorToLenderBalance,
  recordLoanStatement, recordDisbursement, closeLoan, outstandingPrincipal, getLoan, listRatePeriods,
  latestStatement, listDisbursements,
} from "./loans.ts";
import { UndoRefused } from "./transactions.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
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
    tenureMonths: 24, currentOutstanding: rupees(1_00_000), repaymentAccountId: bank,
  });
  return { db, bank, loan };
}

const balance = (db: DB, accountId: string) =>
  queryOne<{ b: number }>(
    db,
    `SELECT opening_balance + COALESCE((SELECT SUM(amount) FROM transactions
                                         WHERE account_id = a.id AND deleted_at IS NULL), 0) AS b
       FROM accounts a WHERE id = ?`,
    accountId,
  )!.b;

/** The newest loan event with this action. */
const lastEvent = (db: DB, action: string) =>
  queryOne<{ id: string }>(
    db, `SELECT id FROM events WHERE entity = 'loan' AND action = ? ORDER BY seq DESC LIMIT 1`, action,
  )!.id;

function undo(db: DB, action: string) {
  const result = undoEvent(db, lastEvent(db, action), actor, { force: true });
  assert.ok(result.ok, result.reason);
  return result.undoEvent!.summary ?? "";
}

describe("WEALTH-21 · undoing a loan's changes", () => {
  test("an instalment: the payment, the bank debit and the loan credit all go", () => {
    const { db, bank, loan } = setup();
    recordInstalment(db, actor, { loanId: loan.id, date: "2025-02-05", amount: rupees(5_000) as Paise, fromAccountId: bank });
    assert.equal(outstandingPrincipal(db, loan.id), rupees(96_000));

    assert.match(undo(db, "instalment"), /Removed the ₹5,000 instalment/);
    assert.equal(queryAll(db, `SELECT id FROM loan_payments WHERE loan_id = ?`, loan.id).length, 0);
    assert.equal(outstandingPrincipal(db, loan.id), rupees(1_00_000));
    assert.equal(balance(db, bank), rupees(5_00_000));
    assert.equal(balance(db, loan.account_id), -rupees(1_00_000));
  });

  test("a prepayment taken as a shorter tenure: the tenure comes back too", () => {
    const { db, bank, loan } = setup();
    recordPrepayment(db, actor, { loanId: loan.id, date: "2025-02-05", amount: rupees(50_000) as Paise, mode: "tenure", fromAccountId: bank });
    assert.ok(getLoan(db, loan.id)!.tenure_months < 24, "the fixture did not shorten the tenure");

    undo(db, "instalment");
    assert.equal(getLoan(db, loan.id)!.tenure_months, 24);
    assert.equal(outstandingPrincipal(db, loan.id), rupees(1_00_000));
    assert.equal(balance(db, bank), rupees(5_00_000));
  });

  test("a rate change: the period goes, and a tenure it stretched comes back", () => {
    const { db, loan } = setup();
    recordRateChange(db, actor, { loanId: loan.id, effectiveFrom: "2025-01-01", annualRatePct: 14, keep: "emi" });
    assert.ok(getLoan(db, loan.id)!.tenure_months > 24, "the fixture did not stretch the tenure");

    undo(db, "rate-change");
    assert.deepEqual(listRatePeriods(db, loan.id).map((r) => r.annual_rate_pct), [12]);
    assert.equal(getLoan(db, loan.id)!.tenure_months, 24);
  });

  test("a re-anchor and a lender statement", () => {
    const { db, loan } = setup();
    recordLoanStatement(db, actor, { loanId: loan.id, asOf: "2025-02-01", lenderOutstanding: rupees(99_000) as Paise });
    reanchorToLenderBalance(db, actor, { loanId: loan.id, lenderOutstanding: rupees(99_000) as Paise, asOf: "2025-02-01" });
    assert.equal(outstandingPrincipal(db, loan.id), rupees(99_000));

    undo(db, "reanchor");
    assert.equal(outstandingPrincipal(db, loan.id), rupees(1_00_000));
    undo(db, "statement");
    assert.equal(latestStatement(db, loan.id), null);
  });

  test("a disbursement: the draw and both of its legs", () => {
    const { db, bank } = setup();
    const loan = createLoan(db, actor, {
      lender: "Fictional Builder Finance", loanType: "home-under-construction", sanctioned: rupees(10_00_000),
      sanctionDate: "2025-01-01", interestModel: "reducing", annualRatePct: 9, tenureMonths: 240,
    });
    recordDisbursement(db, actor, { loanId: loan.id, date: "2025-02-01", amount: rupees(2_00_000) as Paise,
      destination: "budget-account", destinationAccountId: bank });
    assert.equal(balance(db, bank), rupees(7_00_000));

    undo(db, "disburse");
    assert.deepEqual(listDisbursements(db, loan.id), []);
    assert.equal(balance(db, bank), rupees(5_00_000));
    assert.equal(balance(db, loan.account_id), 0);
  });

  test("a settlement's close: the loan and its account reopen, and the waiver goes", () => {
    const { db, bank, loan } = setup();
    closeLoan(db, actor, { loanId: loan.id, date: "2025-03-01", settlement: rupees(90_000) as Paise, settlementAccountId: bank });
    assert.equal(outstandingPrincipal(db, loan.id), 0);

    // The settlement payment cannot be undone while the loan is closed.
    assert.throws(() => undoEvent(db, lastEvent(db, "instalment"), actor, { force: true }), UndoRefused);

    undo(db, "close");
    const row = queryOne<{ l: string | null; a: string | null }>(
      db, `SELECT l.closed_at AS l, a.closed_at AS a FROM loans l JOIN accounts a ON a.id = l.account_id WHERE l.id = ?`,
      loan.id)!;
    assert.deepEqual([row.l, row.a], [null, null], "the account stayed closed");
    assert.equal(outstandingPrincipal(db, loan.id), rupees(10_000), "the waiver stayed");
    assert.equal(balance(db, loan.account_id), -rupees(10_000));

    // And now the payment itself can be taken back.
    undo(db, "instalment");
    assert.equal(outstandingPrincipal(db, loan.id), rupees(1_00_000));
    assert.equal(balance(db, bank), rupees(5_00_000));
  });

  test("what cannot be reversed is refused, and not logged as undone", () => {
    const { db, loan } = setup();
    recordRateChange(db, actor, { loanId: loan.id, effectiveFrom: "2025-03-01", annualRatePct: 14 });
    // As an event from before rate changes carried their period's id.
    const id = lastEvent(db, "rate-change");
    execute(db, `UPDATE events SET after_json = ? WHERE id = ?`, JSON.stringify({ rate: 14 }), id);

    assert.throws(() => undoEvent(db, id, actor, { force: true }), UndoRefused);
    assert.equal(queryOne<{ u: string | null }>(db, `SELECT undone_by_event_id AS u FROM events WHERE id = ?`, id)!.u, null);
    assert.equal(listRatePeriods(db, loan.id).length, 2);
  });
});
