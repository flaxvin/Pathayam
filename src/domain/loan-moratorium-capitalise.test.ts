/**
 * LOANS-1 · A capitalised moratorium's interest joins the debt at the first EMI.
 *
 * The projection said what the lender says: ₹10,00,000 at 10% with twelve
 * months of capitalised moratorium is owed as ₹11,04,713.07 when repayment
 * starts, repaid at ₹14,598.86 over 120 months. But the interest was never
 * added to the outstanding. After the first EMI the moratorium view ended, the
 * live outstanding (still ₹10,00,000 less one month's principal) took over,
 * and the loan read ₹9,93,734.47 owed with a new EMI of ₹13,196.70 — about
 * ₹1.05 lakh of debt gone from net worth until somebody re-anchored to the
 * lender's balance.
 *
 * The arithmetic, by hand (r = 10% / 12 = 1/120 a month):
 *
 *   grown      = 10,00,000 × (1 + 1/120)^12   = 10,00,000 × 1.1047130674
 *              = ₹11,04,713.07                  capitalised: ₹1,04,713.07
 *   EMI        = P·r·(1+r)^n / ((1+r)^n − 1), n = 120, (1+r)^120 = 2.7070414961
 *              = 11,04,713.07 × (1/120) × 2.7070414961 / 1.7070414961
 *              = 9,205.9422 × 1.5858083…       = ₹14,598.86
 *   1st EMI    interest  = 11,04,713.07 / 120  = ₹9,205.94
 *              principal = 14,598.86 − 9,205.94 = ₹5,392.92
 *   owed after = 11,04,713.07 − 5,392.92      = ₹10,99,320.15
 *   next EMI   = the same ₹14,598.86, over the 119 months left.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne, type DB } from "../db/db.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { nowIST, type MonthKey } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import {
  createLoan, recordInstalment, reanchorToLenderBalance, outstandingPrincipal, projectLoan,
  listPayments, isMoratoriumCapitalisation, type CreateLoanInput,
} from "./loans.ts";
import { accountDrifts } from "./account-drift.ts";
import { UndoRefused } from "./transactions.ts";
import { netWorthStatement } from "./networth.ts";
import { computeBudget, identityResidual } from "../engine/engine.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { emiFor } from "../loans/amortisation.ts";

const actor: Actor = { memberId: "m", source: "ui" };

const GROWN = 1_10_471_307; // ₹11,04,713.07
const CAPITALISED = 10_471_307; // ₹1,04,713.07
const EMI = 1_459_886; // ₹14,598.86

function setup(overrides: Partial<CreateLoanInput> = {}) {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "ravi@example.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2024-01-01", openingBalance: rupees(5_00_000),
  }).id;
  const loan = createLoan(db, actor, {
    lender: "Fictional Bank", loanType: "education", sanctioned: rupees(10_00_000),
    sanctionDate: "2024-01-01", interestModel: "moratorium-capitalised", annualRatePct: 10,
    tenureMonths: 120, moratoriumMonths: 12, currentOutstanding: rupees(10_00_000),
    repaymentAccountId: bank, firstInstalmentDate: "2025-02-01",
    ...overrides,
  });
  return { db, bank, loan };
}

const ledgerOwed = (db: DB, accountId: string) =>
  -queryOne<{ b: number }>(
    db,
    `SELECT opening_balance + COALESCE((SELECT SUM(amount) FROM transactions
                                         WHERE account_id = a.id AND deleted_at IS NULL), 0) AS b
       FROM accounts a WHERE id = ?`,
    accountId,
  )!.b;

const loanLine = (db: DB, accountId: string) =>
  netWorthStatement(db, "2025-03-01").liabilityGroups
    .flatMap((g) => g.lines).find((l) => l.accountId === accountId)?.value;

function assertAgrees(db: DB, loanId: string, accountId: string, owed: number, when: string) {
  assert.equal(outstandingPrincipal(db, loanId), owed, `${when}: outstanding`);
  assert.equal(projectLoan(db, loanId)!.outstanding, owed, `${when}: projection`);
  assert.equal(ledgerOwed(db, accountId), owed, `${when}: the loan account's balance`);
  assert.equal(Math.abs(loanLine(db, accountId) ?? NaN), owed, `${when}: net worth`);
  assert.deepEqual(accountDrifts(db, { viewerMemberId: "m" }).map((d) => d.explanation), [],
    `${when}: a drift the app caused`);
}

function assertLedgerBalances(db: DB) {
  const budget = computeBudget(loadEngineInput(db, { through: "2025-03" as MonthKey }));
  const off = [...budget.entries()].filter(([, s]) => identityResidual(s) !== 0).map(([m]) => m);
  assert.deepEqual(off, [], "the budget identity holds every month");
}

const capitalisations = (db: DB, loanId: string) =>
  listPayments(db, loanId).filter(isMoratoriumCapitalisation).length;

const undoLast = (db: DB, action: string) => {
  const id = queryOne<{ id: string }>(
    db, `SELECT id FROM events WHERE entity = 'loan' AND action = ? ORDER BY seq DESC LIMIT 1`, action,
  )!.id;
  return undoEvent(db, id, actor, { force: true });
};

describe("LOANS-1 · capitalised moratorium interest is added at the first EMI", () => {
  test("the projection's own figures, checked by hand", () => {
    const { db, loan } = setup();
    const p = projectLoan(db, loan.id)!;
    assert.equal(p.moratorium!.balanceAtRepaymentStart, GROWN);
    assert.equal(p.moratorium!.capitalisedInterest, CAPITALISED);
    assert.equal(p.emi, EMI);
    // Independently of the module: 10,00,000 × (1 + 1/120)^12.
    assert.equal(Math.round(1_00_000_000 * (1 + 1 / 120) ** 12), GROWN);
  });

  test("the first EMI: ₹10,99,320.15 owed everywhere, and the EMI stays ₹14,598.86", () => {
    const { db, bank, loan } = setup();
    const paid = recordInstalment(db, actor, {
      loanId: loan.id, date: "2025-02-01", amount: EMI as Paise, fromAccountId: bank,
    });
    assert.equal(paid.interest, 920_594, "interest on the grown balance: ₹9,205.94");
    assert.equal(paid.principal, 539_292, "₹14,598.86 − ₹9,205.94 = ₹5,392.92");

    assertAgrees(db, loan.id, loan.account_id, 1_09_932_015, "after the first EMI");
    const p = projectLoan(db, loan.id)!;
    assert.equal(p.moratorium, null, "the moratorium is history");
    assert.equal(p.emi, EMI, "the EMI is the lender's, not ₹13,196.70");
    assert.equal(emiFor(1_09_932_015, 10, 119), EMI);

    // The loan's ledger carries one dated row adding the interest, before the EMI.
    const rows = listPayments(db, loan.id);
    assert.equal(rows.length, 2);
    const cap = rows.find((r) => r.id !== paid.id)!;
    assert.equal(cap.date, "2025-02-01");
    assert.equal(cap.amount, 0, "nothing was paid");
    assert.equal(cap.principal, -CAPITALISED);
    assert.equal(cap.interest, 0, "not interest paid — interest owed, now principal");
    assert.equal(
      queryOne<{ amount: number }>(db, `SELECT amount FROM transactions WHERE id = ?`, cap.loan_transaction_id)!.amount,
      -CAPITALISED, "the loan account owes the interest too",
    );
    // Lifetime figures count only what was repaid.
    assert.equal(p.metrics.principalRepaid, 539_292);
    assertLedgerBalances(db);
  });

  test("a second EMI does not capitalise again", () => {
    const { db, bank, loan } = setup();
    recordInstalment(db, actor, { loanId: loan.id, date: "2025-02-01", amount: EMI as Paise, fromAccountId: bank });
    recordInstalment(db, actor, { loanId: loan.id, date: "2025-03-01", amount: EMI as Paise, fromAccountId: bank });
    assert.equal(capitalisations(db, loan.id), 1);
    // 10,99,320.15 − (14,598.86 − round(10,99,320.15/120 = 9,161.00)) = 10,93,882.29
    assert.equal(outstandingPrincipal(db, loan.id), 1_09_932_015 - (EMI - 916_100));
    assert.equal(ledgerOwed(db, loan.account_id), outstandingPrincipal(db, loan.id));
  });

  test("undoing the first EMI takes the capitalisation with it, and redoing it adds it once", () => {
    const { db, bank, loan } = setup();
    recordInstalment(db, actor, { loanId: loan.id, date: "2025-02-01", amount: EMI as Paise, fromAccountId: bank });
    const result = undoLast(db, "instalment");
    assert.ok(result.ok, result.reason);
    assert.equal(listPayments(db, loan.id).length, 0);
    assertAgrees(db, loan.id, loan.account_id, rupees(10_00_000), "after the undo");
    assert.equal(projectLoan(db, loan.id)!.moratorium!.capitalisedInterest, CAPITALISED, "back in moratorium");

    recordInstalment(db, actor, { loanId: loan.id, date: "2025-02-01", amount: EMI as Paise, fromAccountId: bank });
    assertAgrees(db, loan.id, loan.account_id, 1_09_932_015, "after recording it again");
    assert.equal(capitalisations(db, loan.id), 1);
    assertLedgerBalances(db);
  });

  test("a re-anchor after the first EMI must be undone before the EMI is", () => {
    const { db, bank, loan } = setup();
    recordInstalment(db, actor, { loanId: loan.id, date: "2025-02-01", amount: EMI as Paise, fromAccountId: bank });
    reanchorToLenderBalance(db, actor, { loanId: loan.id, lenderOutstanding: rupees(10_99_000) as Paise, asOf: "2025-02-10" });
    assert.throws(
      () => undoLast(db, "instalment"),
      (e: Error) => e instanceof UndoRefused && /re-anchor/i.test(e.message),
    );
    assert.equal(outstandingPrincipal(db, loan.id), rupees(10_99_000), "nothing moved");

    assert.ok(undoLast(db, "reanchor").ok);
    assert.ok(undoLast(db, "instalment").ok);
    assert.equal(outstandingPrincipal(db, loan.id), rupees(10_00_000));
  });

  test("a later instalment must be undone before the first", () => {
    const { db, bank, loan } = setup();
    recordInstalment(db, actor, { loanId: loan.id, date: "2025-02-01", amount: EMI as Paise, fromAccountId: bank });
    const first = queryOne<{ id: string }>(
      db, `SELECT id FROM events WHERE entity = 'loan' AND action = 'instalment' ORDER BY seq LIMIT 1`,
    )!.id;
    recordInstalment(db, actor, { loanId: loan.id, date: "2025-03-01", amount: EMI as Paise, fromAccountId: bank });
    assert.throws(() => undoEvent(db, first, actor, { force: true }), UndoRefused);
    assert.ok(undoLast(db, "instalment").ok);
    assert.ok(undoEvent(db, first, actor, { force: true }).ok);
    assertAgrees(db, loan.id, loan.account_id, rupees(10_00_000), "after both are undone");
  });

  test("a lender balance taken during the moratorium already holds the interest", () => {
    const { db, bank, loan } = setup();
    // The lender's statement in month 11: the capitalised balance so far.
    reanchorToLenderBalance(db, actor, { loanId: loan.id, lenderOutstanding: 1_09_557_000 as Paise, asOf: "2025-01-01" });
    recordInstalment(db, actor, {
      loanId: loan.id, date: "2025-02-01", amount: EMI as Paise, fromAccountId: bank,
      principal: 546_000 as Paise, interest: (EMI - 546_000) as Paise,
    });
    assert.equal(
      capitalisations(db, loan.id), 0,
      "re-anchored to the lender, the interest is not added a second time",
    );
    assert.equal(outstandingPrincipal(db, loan.id), 1_09_557_000 - 546_000);
  });

  test("an interest-only payment does not begin repayment, so does not capitalise", () => {
    const { db, bank, loan } = setup();
    recordInstalment(db, actor, {
      loanId: loan.id, date: "2024-06-01", amount: rupees(8_000) as Paise, fromAccountId: bank,
      principal: 0 as Paise, interest: rupees(8_000) as Paise,
    });
    assert.equal(listPayments(db, loan.id).length, 1);
    assert.equal(outstandingPrincipal(db, loan.id), rupees(10_00_000));
  });

  test("a serviced moratorium, and a loan with none, are untouched", () => {
    for (const overrides of [
      { interestModel: "moratorium-serviced" as const },
      { interestModel: "reducing" as const, moratoriumMonths: 0 },
    ]) {
      const { db, bank, loan } = setup(overrides);
      const paid = recordInstalment(db, actor, {
        loanId: loan.id, date: "2025-02-01", amount: rupees(13_215) as Paise, fromAccountId: bank,
      });
      assert.equal(listPayments(db, loan.id).length, 1, overrides.interestModel);
      assert.equal(outstandingPrincipal(db, loan.id), rupees(10_00_000) - paid.principal);
      assert.equal(ledgerOwed(db, loan.account_id), outstandingPrincipal(db, loan.id));
    }
  });

  test("a loan recorded without a paying account still capitalises on the loan", () => {
    const { db, loan } = setup();
    recordInstalment(db, actor, { loanId: loan.id, date: "2025-02-01", amount: EMI as Paise });
    assert.equal(outstandingPrincipal(db, loan.id), 1_09_932_015);
    // With no account, the instalment posts no loan leg (as for any loan); the
    // capitalisation is a change in the debt, not a payment, so it always does.
    assert.equal(ledgerOwed(db, loan.account_id), GROWN);
  });
});
