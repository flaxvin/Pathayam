import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryAll, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { accountBalances, loadEngineInput } from "../engine/repository.ts";
import {
  createLoan, projectLoan, recordDisbursement, recordInstalment,
  closeLoan, listLoans, getLoan, debtOverview, paymentCategoryForLoan, recordRateChange,
  recordPrepayment,
} from "./loans.ts";
import { getTarget, createGroup, createCategory, setAssigned } from "./budget.ts";
import { computeBudget } from "../engine/engine.ts";
import { monthOf } from "../core/dates.ts";
import { netWorthStatement } from "./networth.ts";
import { todayIST } from "../core/dates.ts";

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

describe("H2.2 · a private loan is its holder's alone", () => {
  /**
   * The flag was offered on the form, stored, and shown as a chip — and enforced
   * nowhere. `listLoans` had no viewer filter, so a loan marked private appeared
   * in everybody's list, in the household's debt table, in the net-worth
   * liabilities and as an instalment on everybody's cashflow calendar. A privacy
   * control that records an intention and does not keep it is worse than not
   * offering one, because somebody relies on it.
   */
  function twoMembers(db: ReturnType<typeof setup>["db"]) {
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
      "m-priya", "priya@example.com", "Priya", nowIST());
  }

  test("it is in its holder's list and nobody else's", () => {
    const { db, bankId } = setup();
    twoMembers(db);
    const loan = createLoan(db, actor, {
      lender: "Axis", loanType: "personal", sanctioned: rupees(2_00_000),
      sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 14,
      tenureMonths: 24, currentOutstanding: rupees(2_00_000),
      repaymentAccountId: bankId, holderMemberId: RAVI, visibility: "private",
    });

    const sees = (viewer: string | null) =>
      listLoans(db, { viewerMemberId: viewer }).some((l) => l.id === loan.id);
    assert.equal(sees(RAVI), true);
    assert.equal(sees("m-priya"), false);
    // Omitting the viewer still returns everything, which the export wants.
    assert.equal(listLoans(db).some((l) => l.id === loan.id), true);
  });

  test("and out of everybody else's debt table and net worth", () => {
    const { db, bankId } = setup();
    twoMembers(db);
    createLoan(db, actor, {
      lender: "Axis", loanType: "personal", sanctioned: rupees(2_00_000),
      sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 14,
      tenureMonths: 24, currentOutstanding: rupees(2_00_000),
      repaymentAccountId: bankId, holderMemberId: RAVI, visibility: "private",
    });

    assert.equal(debtOverview(db, RAVI).some((d) => d.name.includes("Axis")), true);
    assert.equal(debtOverview(db, "m-priya").some((d) => d.name.includes("Axis")), false);

    /*
     * The total matters as much as the row: Priya can see every other line, so a
     * net worth that included his private loan would publish the amount by
     * subtraction.
     */
    const his = netWorthStatement(db, todayIST(), "INR", { viewerMemberId: RAVI });
    const hers = netWorthStatement(db, todayIST(), "INR", { viewerMemberId: "m-priya" });
    assert.notEqual(his.netWorth, hers.netWorth);
    assert.equal(hers.netWorth - his.netWorth, rupees(2_00_000), "exactly the hidden loan");
  });

  test("a shared loan carries the holder's name instead", () => {
    const { db, bankId } = setup();
    twoMembers(db);
    createLoan(db, actor, {
      lender: "Canara", loanType: "education", sanctioned: rupees(5_00_000),
      sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 10,
      tenureMonths: 60, currentOutstanding: rupees(5_00_000),
      repaymentAccountId: bankId, holderMemberId: RAVI,
    });

    const row = debtOverview(db, "m-priya").find((d) => d.name.includes("Canara"));
    assert.ok(row, "shared, so she sees it");
    assert.equal(row!.holderName, "Ravi", "with whose it is on the row");
  });
});

describe("R8 + R14 · the loan's envelope asks for the instalment", () => {
  /**
   * The app knows the EMI exactly, so making somebody type it into a target — and
   * retype it after every rate reset — asks them to maintain a figure the app
   * computes. Without a target the envelope is also invisible to the underfunded
   * total and to auto-assign, which are the two things that would put the money
   * there.
   */
  test("a new loan's payment envelope carries the EMI as its monthly target", () => {
    const { db, bankId } = setup();
    const loan = createLoan(db, actor, {
      lender: "Axis", loanType: "personal", sanctioned: rupees(3_00_000),
      sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 12,
      tenureMonths: 36, currentOutstanding: rupees(3_00_000), repaymentAccountId: bankId,
    });

    const payment = paymentCategoryForLoan(db, loan.id)!;
    const target = getTarget(db, payment.id);
    const projection = projectLoan(db, loan.id)!;

    assert.ok(target, "it has one");
    assert.equal(target!.type, "monthly");
    assert.equal(target!.amount, projection.emi, "and it is the instalment");
  });

  test("a rate reset moves the target with the instalment", () => {
    const { db, bankId } = setup();
    const loan = createLoan(db, actor, {
      lender: "Axis", loanType: "personal", sanctioned: rupees(3_00_000),
      sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 12,
      tenureMonths: 36, currentOutstanding: rupees(3_00_000), repaymentAccountId: bankId,
    });
    const payment = paymentCategoryForLoan(db, loan.id)!;
    const before = getTarget(db, payment.id)!.amount;

    recordRateChange(db, actor, {
      loanId: loan.id, effectiveFrom: "2026-06-01", annualRatePct: 15,
    });

    const after = getTarget(db, payment.id)!.amount;
    assert.notEqual(after, before, "the instalment changed, so the target did");
    assert.equal(after, projectLoan(db, loan.id)!.emi);
  });
});

describe("R19.5 · settling early, and what it cost", () => {
  /**
   * Most lenders charge to foreclose — a percentage on a personal loan, a flat fee
   * on a card EMI. Without somewhere to record it, the prepayment decision is
   * taken against a saving bigger than the one actually on offer, which is the
   * single decision `06` §1 says the module exists for.
   */
  test("the charge is recorded against an account and an envelope", () => {
    const { db, bankId } = setup();
    const group = createGroup(db, actor, "Fixed");
    const charges = createCategory(db, actor, { groupId: group.id, name: "Bank charges" });
    const loan = createLoan(db, actor, {
      lender: "Axis", loanType: "personal", sanctioned: rupees(3_00_000),
      sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 12,
      tenureMonths: 36, currentOutstanding: rupees(3_00_000), repaymentAccountId: bankId,
    });
    const before = accountBalances(db).get(bankId)!.working;

    closeLoan(db, actor, {
      loanId: loan.id, date: todayIST(),
      foreclosureCharge: rupees(6_000),
      chargeAccountId: bankId, chargeCategoryId: charges.id,
    });

    assert.equal(
      accountBalances(db).get(bankId)!.working, before - rupees(6_000),
      "it came out of a real account",
    );
    assert.ok(getLoan(db, loan.id)?.closed_at, "and the loan is closed");
  });

  test("a charge with no account behind it is refused", () => {
    const { db, bankId } = setup();
    const loan = createLoan(db, actor, {
      lender: "Axis", loanType: "personal", sanctioned: rupees(1_00_000),
      sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 12,
      tenureMonths: 12, currentOutstanding: rupees(1_00_000), repaymentAccountId: bankId,
    });
    assert.throws(
      () => closeLoan(db, actor, {
        loanId: loan.id, date: todayIST(), foreclosureCharge: rupees(2_000),
      }),
      /which account the foreclosure charge came out of/,
    );
  });

  test("closing without a charge is unchanged", () => {
    const { db, bankId } = setup();
    const loan = createLoan(db, actor, {
      lender: "Canara", loanType: "education", sanctioned: rupees(5_00_000),
      sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 10,
      tenureMonths: 60, currentOutstanding: rupees(5_00_000), repaymentAccountId: bankId,
    });
    const before = accountBalances(db).get(bankId)!.working;
    closeLoan(db, actor, { loanId: loan.id, date: todayIST() });
    assert.equal(accountBalances(db).get(bankId)!.working, before);
  });
});


/**
 * B114 / B115 · Two screens offered a choice, priced both sides of it, and then
 * carried out the same thing whichever you picked. The tenure was the only lever
 * that could have made the other option real, and it never moved.
 */
describe("06 R20.2 · a rate reset is a choice, and the choice is carried out", () => {
  function homeLoan(db: DB, bankId: string) {
    return createLoan(db, actor, {
      lender: "SBI", loanType: "home", sanctioned: rupees(50_00_000),
      sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 8.5,
      tenureMonths: 240, currentOutstanding: rupees(50_00_000), repaymentAccountId: bankId,
    });
  }

  test("keeping the instalment moves the tenure instead", () => {
    const { db, bankId } = setup();
    const loan = homeLoan(db, bankId);
    const before = projectLoan(db, loan.id)!;

    recordRateChange(db, actor, {
      loanId: loan.id, effectiveFrom: "2026-07-01", annualRatePct: 9.5, keep: "emi",
    });

    const after = projectLoan(db, loan.id)!;
    // Whole months again: the instalment holds to what the last one absorbs.
    assert.ok(
      Math.abs(after.emi - before.emi) < rupees(500),
      `the instalment held: ${before.emi} → ${after.emi}`,
    );
    assert.ok(
      getLoan(db, loan.id)!.tenure_months > 240,
      "and the tenure took the rise instead",
    );
  });

  test("keeping the tenure moves the instalment instead", () => {
    const { db, bankId } = setup();
    const loan = homeLoan(db, bankId);
    const before = projectLoan(db, loan.id)!;

    recordRateChange(db, actor, {
      loanId: loan.id, effectiveFrom: "2026-07-01", annualRatePct: 9.5, keep: "tenure",
    });

    const after = projectLoan(db, loan.id)!;
    assert.equal(getLoan(db, loan.id)!.tenure_months, 240, "the tenure held");
    assert.ok(after.emi > before.emi, "and the instalment took the rise");
  });

  test("the envelope's target follows whichever was chosen", () => {
    const { db, bankId } = setup();
    const loan = homeLoan(db, bankId);
    recordRateChange(db, actor, {
      loanId: loan.id, effectiveFrom: "2026-07-01", annualRatePct: 9.5, keep: "tenure",
    });
    const payment = paymentCategoryForLoan(db, loan.id)!;
    assert.equal(
      getTarget(db, payment.id)?.amount, projectLoan(db, loan.id)!.emi,
      "what the household has to find each month is what the envelope asks for",
    );
  });

  test("the original tenure survives, so lifetime figures still have a baseline", () => {
    const { db, bankId } = setup();
    const loan = homeLoan(db, bankId);
    recordRateChange(db, actor, {
      loanId: loan.id, effectiveFrom: "2026-07-01", annualRatePct: 9.5, keep: "emi",
    });
    assert.equal(getLoan(db, loan.id)!.original_tenure_months, 240);
  });
});

describe("06 R19.1 · a prepayment does what was picked", () => {
  function midLifeLoan(db: DB, bankId: string) {
    return createLoan(db, actor, {
      lender: "HDFC", loanType: "home", sanctioned: rupees(40_00_000),
      sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 9,
      tenureMonths: 180, currentOutstanding: rupees(40_00_000), repaymentAccountId: bankId,
    });
  }

  test("reducing the tenure keeps the instalment and closes it earlier", () => {
    const { db, bankId } = setup();
    const loan = midLifeLoan(db, bankId);
    const before = projectLoan(db, loan.id)!;

    recordPrepayment(db, actor, {
      loanId: loan.id, date: todayIST(), amount: rupees(5_00_000), mode: "tenure",
      fromAccountId: bankId,
    });

    const after = projectLoan(db, loan.id)!;
    /*
     * A tenure is a whole number of months, so "keep the instalment" can only
     * hold it to whatever the final month absorbs — a few rupees on a ₹40,570
     * EMI. That residue is the honest answer, not a miss.
     */
    assert.ok(
      Math.abs(after.emi - before.emi) < rupees(500),
      `the instalment held: ${before.emi} → ${after.emi}`,
    );
    assert.ok(after.schedule.months < before.schedule.months, "and it closes sooner");
    assert.ok(
      after.metrics.emisSaved > 0,
      "the months bought are reported, because the baseline did not move with it",
    );
  });

  test("reducing the EMI keeps the closure date and lowers the instalment", () => {
    const { db, bankId } = setup();
    const loan = midLifeLoan(db, bankId);
    const before = projectLoan(db, loan.id)!;

    recordPrepayment(db, actor, {
      loanId: loan.id, date: todayIST(), amount: rupees(5_00_000), mode: "emi",
      fromAccountId: bankId,
    });

    const after = projectLoan(db, loan.id)!;
    assert.equal(getLoan(db, loan.id)!.tenure_months, 180, "the tenure held");
    assert.ok(after.emi < before.emi, "and the instalment fell");
  });

  test("R19.4 · it comes out of the envelope the household named", () => {
    const { db, bankId } = setup();
    const loan = midLifeLoan(db, bankId);
    const group = createGroup(db, actor, "Savings");
    const savings = createCategory(db, actor, { groupId: group.id, name: "Prepayment fund" });
    const month = monthOf(todayIST());
    setAssigned(db, actor, month, savings.id, rupees(5_00_000));

    recordPrepayment(db, actor, {
      loanId: loan.id, date: todayIST(), amount: rupees(5_00_000), mode: "tenure",
      fromAccountId: bankId, fundingCategoryId: savings.id,
    });

    const state = computeBudget(loadEngineInput(db, { through: month })).get(month)!;
    assert.equal(
      state.categories.get(savings.id)?.balance, 0,
      "the envelope they pointed at is the one that emptied",
    );
  });

  test("prepaying more than is outstanding is refused", () => {
    const { db, bankId } = setup();
    const loan = midLifeLoan(db, bankId);
    assert.throws(
      () => recordPrepayment(db, actor, {
        loanId: loan.id, date: todayIST(), amount: rupees(50_00_000), mode: "tenure",
        fromAccountId: bankId,
      }),
      /more than the/,
    );
  });
});
