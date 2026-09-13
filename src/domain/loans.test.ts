import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryAll, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { accountBalances } from "../engine/repository.ts";
import {
  createLoan, projectLoan, recordDisbursement, recordInstalment,
  closeLoan, listLoans, getLoan,
} from "./loans.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(50_00_000),
  });
  return { db, bankId: bank.id };
}

describe("06 R15 · tranche disbursement", () => {
  test("an under-construction loan starts undrawn, then draws in tranches", () => {
    const { db } = setup();
    // ₹50L sanctioned, nothing drawn yet — an under-construction home.
    const loan = createLoan(db, actor, {
      lender: "SBI", loanType: "home-under-construction",
      sanctioned: rupees(50_00_000), sanctionDate: "2026-04-01",
      interestModel: "reducing", annualRatePct: 8.5, tenureMonths: 240,
    });

    let p = projectLoan(db, loan.id)!;
    assert.equal(p.disbursed, 0);
    assert.equal(p.undrawn, rupees(50_00_000));

    // Tranche 1 — ₹10L to the builder. R15.1: pre-EMI on the drawn amount.
    recordDisbursement(db, actor, {
      loanId: loan.id, amount: rupees(10_00_000), date: "2026-05-01", destination: "third-party",
    });
    p = projectLoan(db, loan.id)!;
    assert.equal(p.disbursed, rupees(10_00_000));
    assert.equal(p.undrawn, rupees(40_00_000));
    // Pre-EMI = 10,00,000 × 8.5%/12 = ₹7,083.33, which the docs round to ₹7,083.
    assert.equal(p.preEmi, 708_333, "pre-EMI is interest on what is drawn");
  });

  test("R15.3 · a third-party tranche never touches Ready to Assign", () => {
    const { db } = setup();
    const loan = createLoan(db, actor, {
      lender: "SBI", loanType: "home-under-construction",
      sanctioned: rupees(50_00_000), sanctionDate: "2026-04-01",
      interestModel: "reducing", annualRatePct: 8.5, tenureMonths: 240,
    });
    recordDisbursement(db, actor, {
      loanId: loan.id, amount: rupees(40_00_000), date: "2026-05-01", destination: "third-party",
    });
    // The builder payment creates a liability transaction on the loan account,
    // but no transaction in any budget account.
    const budgetTxns = queryAll<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE a.kind = 'budget'`,
    )[0]!;
    assert.equal(budgetTxns.n, 0, "no ₹40L of spendable money appears");
  });

  test("R15.2 · a tranche credited to an account arrives to assign", () => {
    const { db, bankId } = setup();
    const loan = createLoan(db, actor, {
      lender: "Axis", loanType: "personal",
      sanctioned: rupees(5_00_000), sanctionDate: "2026-04-01",
      interestModel: "reducing", annualRatePct: 11, tenureMonths: 36,
    });
    recordDisbursement(db, actor, {
      loanId: loan.id, amount: rupees(5_00_000), date: "2026-05-01",
      destination: "budget-account", destinationAccountId: bankId,
    });
    // The credit lands in the bank account, uncategorised, so it reaches RTA.
    const credit = queryAll<{ amount: number; category_id: string | null }>(
      db, `SELECT amount, category_id FROM transactions WHERE account_id = ? AND amount > 0`, bankId,
    );
    assert.ok(credit.some((c) => c.amount === rupees(5_00_000) && c.category_id === null));
  });

  test("a tranche cannot exceed the sanction", () => {
    const { db } = setup();
    const loan = createLoan(db, actor, {
      lender: "SBI", loanType: "home-under-construction",
      sanctioned: rupees(10_00_000), sanctionDate: "2026-04-01",
      interestModel: "reducing", annualRatePct: 8.5, tenureMonths: 240,
    });
    assert.throws(
      () => recordDisbursement(db, actor, {
        loanId: loan.id, amount: rupees(11_00_000), date: "2026-05-01", destination: "third-party",
      }),
      /against a sanction/,
    );
  });

  test("B51 · a budget-account tranche with no account named is refused, not half-written", () => {
    const { db } = setup();
    const loan = createLoan(db, actor, {
      lender: "Axis", loanType: "personal",
      sanctioned: rupees(5_00_000), sanctionDate: "2026-04-01",
      interestModel: "reducing", annualRatePct: 11, tenureMonths: 36,
    });
    // Before the guard this booked the liability and silently skipped the cash
    // leg — the debt rose and the money vanished, while the handler reported
    // "the money is in your account".
    assert.throws(
      () => recordDisbursement(db, actor, {
        loanId: loan.id, amount: rupees(1_00_000), date: "2026-05-01",
        destination: "budget-account", destinationAccountId: null,
      }),
      /which account/,
    );
    // Nothing was written: no disbursement row, no liability leg.
    const rows = queryAll<{ n: number }>(
      db, `SELECT COUNT(*) AS n FROM loan_disbursements WHERE loan_id = ?`, loan.id,
    );
    assert.equal(rows[0]!.n, 0, "no disbursement row should survive the rejection");
    const liability = queryAll<{ n: number }>(
      db, `SELECT COUNT(*) AS n FROM transactions t JOIN loans l ON l.account_id = t.account_id
           WHERE l.id = ?`, loan.id,
    );
    assert.equal(liability[0]!.n, 0, "no liability leg should have been booked");
  });

  test("B51 · a loan with nothing drawn reports no instalments saved", () => {
    const { db } = setup();
    // A brand-new under-construction loan: empty schedule, nothing repaid. The
    // old hardcoded baselineMonths made this read "240 instalments saved".
    const loan = createLoan(db, actor, {
      lender: "SBI", loanType: "home-under-construction",
      sanctioned: rupees(50_00_000), sanctionDate: "2026-04-01",
      interestModel: "reducing", annualRatePct: 8.5, tenureMonths: 240,
    });
    const p = projectLoan(db, loan.id)!;
    assert.equal(p.metrics.emisSaved, 0, "nothing drawn means nothing saved");
  });
});

describe("06 R16 M3/M4 · moratorium in the projection", () => {
  test("M3 serviced — principal stays put, interest is paid across the moratorium", () => {
    const { db } = setup();
    // ₹10L education loan, 8.5%, 48-month moratorium, then 120 months.
    const loan = createLoan(db, actor, {
      lender: "Union", loanType: "education",
      sanctioned: rupees(10_00_000), sanctionDate: "2026-04-01",
      interestModel: "moratorium-serviced", annualRatePct: 8.5,
      tenureMonths: 120, moratoriumMonths: 48,
      currentOutstanding: rupees(10_00_000),
    });
    const p = projectLoan(db, loan.id)!;
    assert.ok(p.moratorium);
    assert.equal(p.moratorium!.capitalised, false);
    // Monthly interest ≈ 10,00,000 × 8.5%/12 = ₹7,083.
    assert.equal(p.preEmi, 708_333, "serviced interest is the monthly obligation");
    // Repayment starts against the untouched principal.
    assert.equal(p.moratorium!.balanceAtRepaymentStart, rupees(10_00_000));
    assert.equal(p.moratorium!.capitalisedInterest, 0);
  });

  test("M4 capitalised — nothing paid now, interest rolls into a larger principal", () => {
    const { db } = setup();
    const loan = createLoan(db, actor, {
      lender: "Union", loanType: "education",
      sanctioned: rupees(10_00_000), sanctionDate: "2026-04-01",
      interestModel: "moratorium-capitalised", annualRatePct: 8.5,
      tenureMonths: 120, moratoriumMonths: 48,
      currentOutstanding: rupees(10_00_000),
    });
    const p = projectLoan(db, loan.id)!;
    assert.ok(p.moratorium);
    assert.equal(p.moratorium!.capitalised, true);
    assert.equal(p.preEmi, null, "nothing is paid during a capitalised moratorium");
    // The balance grew, so repayment starts against more than ₹10L.
    assert.ok(p.moratorium!.balanceAtRepaymentStart > rupees(10_00_000));
    assert.ok(p.moratorium!.capitalisedInterest > 0);
    // And the EMI is computed against the grown balance.
    assert.ok(p.emi > 0);
  });

  test("once repayment begins the moratorium is history", () => {
    const { db, bankId } = setup();
    const loan = createLoan(db, actor, {
      lender: "Union", loanType: "education",
      sanctioned: rupees(10_00_000), sanctionDate: "2026-04-01",
      interestModel: "moratorium-serviced", annualRatePct: 8.5,
      tenureMonths: 120, moratoriumMonths: 48,
      currentOutstanding: rupees(10_00_000),
      repaymentAccountId: bankId, firstInstalmentDate: "2030-05-01",
    });
    recordInstalment(db, actor, {
      loanId: loan.id, date: "2030-05-01", amount: rupees(12_083),
      principal: rupees(5_000), interest: rupees(7_083), fromAccountId: bankId,
    });
    const p = projectLoan(db, loan.id)!;
    assert.equal(p.moratorium, null, "a recorded instalment ends the moratorium view");
  });
});

describe("R15 · where a new loan's money went", () => {
  /**
   * Creating a loan recorded the drawn amount as a number on the loan row and
   * nothing else, so a personal loan whose ₹5,00,000 landed in a bank account
   * left that account untouched — the money existed on the liability side and
   * nowhere else. The two cases are genuinely different and a household knows
   * which it had.
   */
  test("paid to a seller: the debt rises and the budget is untouched", () => {
    const { db, bankId: bank } = setup();
    const before = accountBalances(db).get(bank)?.working ?? 0;

    createLoan(db, actor, {
      lender: "HDFC", loanType: "car", sanctioned: rupees(5_00_000),
      sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 9,
      tenureMonths: 60, currentOutstanding: rupees(5_00_000),
      disbursementDestination: "third-party",
    });

    assert.equal(accountBalances(db).get(bank)?.working ?? 0, before, "no money arrived");
  });

  test("paid into an account: the money is there to assign", () => {
    const { db, bankId: bank } = setup();
    const before = accountBalances(db).get(bank)?.working ?? 0;

    createLoan(db, actor, {
      lender: "Axis", loanType: "personal", sanctioned: rupees(3_00_000),
      sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 14,
      tenureMonths: 36, currentOutstanding: rupees(3_00_000),
      disbursementDestination: "budget-account", disbursementAccountId: bank,
    });

    assert.equal(
      accountBalances(db).get(bank)?.working ?? 0,
      before + rupees(3_00_000),
      "it landed where the household said it did",
    );
  });

  test("saying an account is required when it went into one (B51)", () => {
    const { db } = setup();
    assert.throws(
      () => createLoan(db, actor, {
        lender: "Axis", loanType: "personal", sanctioned: rupees(1_00_000),
        sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 14,
        tenureMonths: 12, currentOutstanding: rupees(1_00_000),
        disbursementDestination: "budget-account",
      }),
      /which account the money landed in/,
    );
  });

  test("saying nothing records nothing, which is what it always did", () => {
    const { db, bankId: bank } = setup();
    const before = accountBalances(db).get(bank)?.working ?? 0;
    createLoan(db, actor, {
      lender: "Canara", loanType: "education", sanctioned: rupees(8_00_000),
      sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 10,
      tenureMonths: 84, currentOutstanding: rupees(8_00_000),
    });
    assert.equal(accountBalances(db).get(bank)?.working ?? 0, before);
  });
});

describe("R21 · a loan that has been paid off", () => {
  /**
   * It used to sit in the list at zero for ever. Nothing noticed it was done and
   * nothing could be done about it: closeLoan existed and was reachable from
   * nowhere.
   */
  test("closing keeps every figure and files it away", () => {
    const { db, bankId } = setup();
    const loan = createLoan(db, actor, {
      lender: "Axis", loanType: "personal", sanctioned: rupees(1_00_000),
      sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 12,
      tenureMonths: 12, currentOutstanding: rupees(1_00_000),
      repaymentAccountId: bankId,
    });

    const metrics = closeLoan(db, actor, { loanId: loan.id, date: "2026-06-01" });
    assert.ok(metrics, "the closure reports what it cost (R21.2)");

    // Gone from the open list, still there when asked for everything.
    assert.equal(listLoans(db).some((l) => l.id === loan.id), false);
    assert.equal(listLoans(db, { includeClosed: true }).some((l) => l.id === loan.id), true);
    assert.ok(getLoan(db, loan.id)?.closed_at, "and it is marked closed, not deleted");
  });
});
