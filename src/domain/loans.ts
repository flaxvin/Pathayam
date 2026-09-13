/**
 * F18 · Loans — the database side of `06`.
 *
 * The amortisation maths lives in `loans/amortisation.ts` and knows nothing
 * about storage. This module records loans, disbursements, rate periods and
 * actual instalments, and asks that module for projections.
 *
 * The invariant that matters most: **F18.g — a loan balance never contributes
 * to Ready to Assign, in any state.** That falls out of the account kind: a
 * loan is a Tracking account, and `to_budget` only ever counts Budget accounts
 * (see docs/dev/01-engine-derivation.md §3). There is no code path that could
 * make a ₹40 lakh liability look like spendable money.
 */

import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, registerUndoHandler, type Actor } from "../core/events.ts";
import { nowIST, todayIST, formatDate, monthOf, type IsoDate } from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import { createAccount, getAccount } from "./accounts.ts";
import { createTransaction, createTransfer } from "./transactions.ts";
import {
  buildSchedule, emiFor, flatRateLoan, moratorium, preEmi, drift,
  lifetimeMetrics, type Schedule, type InterestModel, type LifetimeMetrics,
} from "../loans/amortisation.ts";
import { householdBudgetId } from "./budgets.ts";

export type LoanType =
  | "home" | "home-under-construction" | "car" | "personal" | "gold"
  | "education" | "loan-against-property" | "credit-card-emi" | "bnpl" | "other";

export const LOAN_TYPE_LABELS: Record<LoanType, string> = {
  home: "Home loan",
  "home-under-construction": "Home loan (under construction)",
  car: "Car loan",
  personal: "Personal loan",
  gold: "Gold loan",
  education: "Education loan",
  "loan-against-property": "Loan against property",
  "credit-card-emi": "Credit-card EMI",
  bnpl: "Buy now, pay later",
  other: "Other loan",
};

export interface Loan {
  id: string;
  account_id: string;
  lender: string;
  nickname: string | null;
  loan_type: LoanType;
  sanctioned: Paise;
  sanction_date: IsoDate;
  interest_model: InterestModel;
  benchmark: string | null;
  tenure_months: number;
  moratorium_months: number;
  first_instalment_date: IsoDate | null;
  instalment_day: number | null;
  repayment_account_id: string | null;
  /** R14: set when the loan predates the app, so metrics can say "from…". */
  history_from: IsoDate | null;
  disbursed_at_creation: Paise;
  closed_at: string | null;
  created_at: string;
}

export interface Disbursement {
  id: string;
  loan_id: string;
  date: IsoDate;
  amount: Paise;
  /** R15: a Budget account (income) or a third party (liability only). */
  destination: "budget-account" | "third-party";
  destination_account_id: string | null;
  note: string | null;
}

export interface RatePeriod {
  id: string;
  loan_id: string;
  effective_from: IsoDate;
  annual_rate_pct: number;
  note: string | null;
}

export interface LoanPayment {
  id: string;
  loan_id: string;
  date: IsoDate;
  amount: Paise;
  principal: Paise;
  interest: Paise;
  /** R18.3: an estimated split stays visually distinct from a confirmed one. */
  estimated: number;
  kind: "instalment" | "prepayment" | "extra" | "charge" | "foreclosure";
  transaction_id: string | null;
  note: string | null;
}

// ---------------------------------------------------------------------------
// R14 · Creating a loan
// ---------------------------------------------------------------------------

export interface CreateLoanInput {
  /** H2 · Whose loan this is. Null means the household's. */
  holderMemberId?: string | null;
  /** H2.2 · A private loan is visible only to its holder. */
  visibility?: "household" | "private";
  lender: string;
  nickname?: string | null;
  loanType: LoanType;
  sanctioned: Paise;
  sanctionDate: IsoDate;
  interestModel: InterestModel;
  /** R16 M3/M4 · Length of the moratorium; 0 for none. */
  moratoriumMonths?: number;
  annualRatePct: number;
  benchmark?: string | null;
  tenureMonths: number;
  firstInstalmentDate?: IsoDate | null;
  instalmentDay?: number | null;
  repaymentAccountId?: string | null;
  /** R14: created mid-life — what is owed now, rather than at origination. */
  currentOutstanding?: Paise | null;
  historyFrom?: IsoDate | null;
  /** Defaults to the sanction — most mid-life loans are fully drawn. */
  disbursedAtCreation?: Paise | null;
  /**
   * R15 · Where the money actually went, when the loan is drawn at creation.
   *
   * The two cases are genuinely different and a household knows which it had. A
   * car or education loan is paid straight to the dealer or the institution: the
   * liability rises and the budget never sees a rupee, which is exactly what
   * `third-party` means. A personal loan lands in your bank account and is income
   * to assign like any other, which is `budget-account`.
   *
   * Omitted, nothing is recorded — which was the only behaviour until now, and
   * left a personal loan's ₹5,00,000 missing from the account it arrived in.
   */
  disbursementDestination?: "budget-account" | "third-party";
  disbursementAccountId?: string | null;
}

export function createLoan(db: DB, actor: Actor, input: CreateLoanInput): Loan {
  if (input.sanctioned <= 0) throw new Error("A loan needs a sanctioned amount above zero.");
  if (input.tenureMonths <= 0) throw new Error("A loan needs a tenure of at least one month.");

  return transact(db, () => {
    // F18.g: a Tracking account, so it can never fund the budget.
    const account = createAccount(db, actor, {
      name: input.nickname || `${input.lender} ${LOAN_TYPE_LABELS[input.loanType]}`,
      kind: "tracking",
      subtype: "loan",
      holderMemberId: input.holderMemberId,
      visibility: input.visibility,
      institution: input.lender,
      openingBalance: -(input.currentOutstanding ?? 0),
      openingDate: input.sanctionDate,
    });

    const id = newId();
    execute(
      db,
      `INSERT INTO loans
         (id,account_id,lender,nickname,loan_type,sanctioned,sanction_date,interest_model,
          benchmark,tenure_months,moratorium_months,first_instalment_date,instalment_day,repayment_account_id,
          history_from,disbursed_at_creation,created_at,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, account.id, input.lender, input.nickname ?? null, input.loanType,
      input.sanctioned, input.sanctionDate, input.interestModel,
      input.benchmark ?? null, input.tenureMonths, input.moratoriumMonths ?? 0,
      input.firstInstalmentDate ?? null, input.instalmentDay ?? null,
      input.repaymentAccountId ?? null,
      input.historyFrom ?? null,
      /*
       * A loan entered with a current balance was drawn before this app existed.
       * Treating it as undrawn would report the whole sanction as still
       * available, which it is not.
       *
       * Unless the household said where the money went — then a real disbursement
       * is recorded below, and totalDisbursed sums both columns, so setting this
       * one as well would draw the amount twice and trip the sanction check.
       */
      input.currentOutstanding && !input.disbursementDestination
        ? (input.disbursedAtCreation ?? input.sanctioned)
        : 0,
      nowIST(), actor.memberId,
    );

    // R16: rates are versioned from the start, so a reset never rewrites history.
    execute(
      db,
      `INSERT INTO loan_rates (id,loan_id,effective_from,annual_rate_pct,created_at)
       VALUES (?,?,?,?,?)`,
      newId(), id, input.sanctionDate, input.annualRatePct, nowIST(),
    );

    // R14: the payment category, symmetric with the credit-card one (R6).
    createLoanPaymentCategory(db, actor, id, input.nickname || input.lender);

    /*
     * R15 · Record where the drawn money went, if the household said. Doing it
     * through recordDisbursement rather than inline is deliberate: that is where
     * the sanction check, the cash leg and B51's refusal to book a liability
     * without naming the account all live.
     */
    const drawn = input.currentOutstanding ? (input.disbursedAtCreation ?? input.sanctioned) : 0;
    if (drawn > 0 && input.disbursementDestination) {
      recordDisbursement(db, actor, {
        loanId: id,
        date: input.sanctionDate,
        amount: drawn as Paise,
        destination: input.disbursementDestination,
        destinationAccountId: input.disbursementAccountId ?? null,
        note: "Drawn when the loan was added",
      });
    }

    const loan = getLoan(db, id)!;
    appendEvent(db, actor, {
      entity: "loan", entityId: id, action: "create", after: loan,
      summary:
        `Added a ${LOAN_TYPE_LABELS[input.loanType].toLowerCase()} from ${input.lender} — ` +
        `${formatPaise(input.sanctioned)} at ${input.annualRatePct}% over ${input.tenureMonths} months`,
    });
    return loan;
  });
}

export const LOAN_PAYMENTS_GROUP = "Loan Payments";

function createLoanPaymentCategory(db: DB, actor: Actor, loanId: string, name: string): string {
  /*
   * 15 · The envelope follows the account that repays the loan — that is whose
   * money is going out every month. A loan with no repayment account set is the
   * household's until somebody says otherwise.
   */
  const budget = queryOne<{ budget_id: string | null }>(
    db,
    `SELECT a.budget_id AS budget_id FROM loans l
       LEFT JOIN accounts a ON a.id = l.repayment_account_id
      WHERE l.id = ?`,
    loanId,
  )?.budget_id ?? householdBudgetId(db);

  let group = queryOne<{ id: string }>(
    db, `SELECT id FROM category_groups WHERE kind = 'loan-payments' AND budget_id = ? LIMIT 1`,
    budget,
  );
  if (!group) {
    const groupId = newId();
    execute(
      db,
      `INSERT INTO category_groups (id,name,kind,sort,created_at,budget_id)
         VALUES (?,?,'loan-payments',?,?,?)`,
      groupId, LOAN_PAYMENTS_GROUP, 0, nowIST(), budget,
    );
    group = { id: groupId };
  }

  const id = newId();
  execute(
    db,
    `INSERT INTO categories (id,group_id,name,sort,created_at,budget_id) VALUES (?,?,?,0,?,?)`,
    id, group.id, name, nowIST(), budget,
  );
  execute(db, `UPDATE loans SET payment_category_id = ? WHERE id = ?`, id, loanId);

  appendEvent(db, actor, {
    entity: "category", entityId: id, action: "create",
    summary: `Created the payment category for ${name}`,
  });
  return id;
}

export function getLoan(db: DB, id: string): Loan | null {
  return queryOne<Loan>(db, `SELECT * FROM loans WHERE id = ?`, id);
}

export function listLoans(db: DB, opts: { includeClosed?: boolean } = {}): Loan[] {
  return queryAll<Loan>(
    db,
    `SELECT * FROM loans ${opts.includeClosed ? "" : "WHERE closed_at IS NULL"}
      ORDER BY created_at`,
  );
}

export function paymentCategoryForLoan(db: DB, loanId: string): { id: string; name: string } | null {
  return queryOne<{ id: string; name: string }>(
    db,
    `SELECT c.id, c.name FROM loans l JOIN categories c ON c.id = l.payment_category_id
      WHERE l.id = ?`,
    loanId,
  );
}

// ---------------------------------------------------------------------------
// R15 · Disbursement
// ---------------------------------------------------------------------------

/**
 * R15.3 is the rule that matters here: a tranche paid to a builder raises the
 * liability and **must not** create a transaction in any Budget account. That
 * is what stops a ₹40 lakh builder payment appearing as ₹40 lakh of spendable
 * money — the failure `06` §1 says every app gets wrong on day one.
 */
export function recordDisbursement(
  db: DB, actor: Actor,
  input: {
    loanId: string;
    date: IsoDate;
    amount: Paise;
    destination: "budget-account" | "third-party";
    destinationAccountId?: string | null;
    note?: string | null;
  },
): Disbursement {
  if (input.amount <= 0) throw new Error("A disbursement needs an amount above zero.");

  // B51: a disbursement credited to a budget account MUST name the account, or
  // the cash leg below is silently skipped while the liability is still booked —
  // a half-write that raises the debt and delivers no money (the failure class
  // B32 names). Reject the combination rather than record something that is
  // permanently inconsistent with itself.
  if (input.destination === "budget-account" && !input.destinationAccountId) {
    throw new Error(
      "Say which account the money landed in, or record it as paid to a third party.",
    );
  }

  return transact(db, () => {
    const loan = getLoan(db, input.loanId);
    if (!loan) throw new Error("That loan does not exist.");

    const disbursed = totalDisbursed(db, input.loanId);
    if (disbursed + input.amount > loan.sanctioned) {
      throw new Error(
        `That would draw ${formatPaise(disbursed + input.amount)} against a sanction of ` +
          `${formatPaise(loan.sanctioned)}.`,
      );
    }

    const id = newId();
    execute(
      db,
      `INSERT INTO loan_disbursements
         (id,loan_id,date,amount,destination,destination_account_id,note,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      id, input.loanId, input.date, input.amount, input.destination,
      input.destinationAccountId ?? null, input.note ?? null, nowIST(),
    );

    // The liability rises either way.
    createTransaction(db, actor, {
      accountId: loan.account_id,
      amount: -input.amount,
      date: input.date,
      memo: `Disbursement — ${input.destination === "third-party" ? "paid to a third party" : "credited to an account"}`,
      cleared: true,
    });

    if (input.destination === "budget-account" && input.destinationAccountId) {
      // R15.2: arrives as income requiring assignment, never as an
      // uncategorised transaction. Leaving category_id null is what makes it
      // reach Ready to Assign (derivation §3) and appear in Review.
      createTransaction(db, actor, {
        accountId: input.destinationAccountId,
        amount: input.amount,
        date: input.date,
        memo: `Loan disbursement from ${loan.lender}`,
        cleared: true,
      });
    }

    const record = queryOne<Disbursement>(db, `SELECT * FROM loan_disbursements WHERE id = ?`, id)!;
    appendEvent(db, actor, {
      entity: "loan", entityId: input.loanId, action: "disburse", after: record,
      summary:
        `Drew ${formatPaise(input.amount)} on ${formatDate(input.date)}` +
        (input.destination === "third-party"
          ? " — paid directly to a third party, so nothing reached your budget"
          : " — credited to an account, so it needs assigning"),
    });
    return record;
  });
}

export function listDisbursements(db: DB, loanId: string): Disbursement[] {
  return queryAll<Disbursement>(
    db, `SELECT * FROM loan_disbursements WHERE loan_id = ? ORDER BY date`, loanId,
  );
}

/** Draws recorded *since* the loan was added to the app. */
export function recordedDisbursements(db: DB, loanId: string): Paise {
  return (
    queryOne<{ total: number }>(
      db, `SELECT COALESCE(SUM(amount),0) AS total FROM loan_disbursements WHERE loan_id = ?`, loanId,
    )?.total ?? 0
  );
}

/**
 * Everything drawn against the sanction, for the drawn/undrawn display.
 *
 * `disbursed_at_creation` belongs **here only**. It is history — a mid-life
 * loan's original draw, which the opening balance already accounts for. Adding
 * it to the outstanding balance as well would count the same money twice.
 */
export function totalDisbursed(db: DB, loanId: string): Paise {
  return recordedDisbursements(db, loanId) + (getLoan(db, loanId)?.disbursed_at_creation ?? 0);
}

// ---------------------------------------------------------------------------
// R18.8 · Loan reconciliation against a lender statement
// ---------------------------------------------------------------------------

export interface LoanStatement {
  id: string;
  loan_id: string;
  as_of: IsoDate;
  lender_outstanding: Paise;
  app_outstanding: Paise;
  interest_paid_ytd: Paise | null;
  instalments_remaining: number | null;
  resolved: number;
}

export function recordLoanStatement(
  db: DB, actor: Actor,
  input: {
    loanId: string;
    asOf: IsoDate;
    lenderOutstanding: Paise;
    interestPaidYtd?: Paise | null;
    instalmentsRemaining?: number | null;
  },
): LoanStatement {
  return transact(db, () => {
    const appOutstanding = outstandingPrincipal(db, input.loanId);
    const id = newId();
    execute(
      db,
      `INSERT INTO loan_statements
         (id,loan_id,as_of,lender_outstanding,interest_paid_ytd,instalments_remaining,
          app_outstanding,created_at,created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      id, input.loanId, input.asOf, input.lenderOutstanding,
      input.interestPaidYtd ?? null, input.instalmentsRemaining ?? null,
      appOutstanding, nowIST(), actor.memberId,
    );

    const result = drift(appOutstanding, input.lenderOutstanding);
    appendEvent(db, actor, {
      entity: "loan", entityId: input.loanId, action: "statement",
      before: { appOutstanding }, after: { lenderOutstanding: input.lenderOutstanding },
      summary: result.material
        ? `Lender statement of ${formatDate(input.asOf)} says ${formatPaise(input.lenderOutstanding)}, ` +
          `the app says ${formatPaise(appOutstanding)} — a difference of ${formatPaise(result.amount)}`
        : `Lender statement of ${formatDate(input.asOf)} matches the app's ${formatPaise(appOutstanding)}`,
    });

    return queryOne<LoanStatement>(db, `SELECT * FROM loan_statements WHERE id = ?`, id)!;
  });
}

export function latestStatement(db: DB, loanId: string): LoanStatement | null {
  return queryOne<LoanStatement>(
    db,
    `SELECT * FROM loan_statements WHERE loan_id = ? ORDER BY as_of DESC, created_at DESC LIMIT 1`,
    loanId,
  );
}

// ---------------------------------------------------------------------------
// R16, R20 · Rates
// ---------------------------------------------------------------------------

export function listRatePeriods(db: DB, loanId: string): RatePeriod[] {
  return queryAll<RatePeriod>(
    db, `SELECT * FROM loan_rates WHERE loan_id = ? ORDER BY effective_from`, loanId,
  );
}

export function currentRate(db: DB, loanId: string, asOf = todayIST()): number {
  return (
    queryOne<{ annual_rate_pct: number }>(
      db,
      `SELECT annual_rate_pct FROM loan_rates WHERE loan_id = ? AND effective_from <= ?
        ORDER BY effective_from DESC LIMIT 1`,
      loanId, asOf,
    )?.annual_rate_pct ?? 0
  );
}

/** R20.1 · A rate change is a new dated period, never an edit to the old one. */
export function recordRateChange(
  db: DB, actor: Actor,
  input: { loanId: string; effectiveFrom: IsoDate; annualRatePct: number; note?: string | null },
): RatePeriod {
  return transact(db, () => {
    const previous = currentRate(db, input.loanId, input.effectiveFrom);
    const id = newId();
    execute(
      db,
      `INSERT INTO loan_rates (id,loan_id,effective_from,annual_rate_pct,note,created_at)
       VALUES (?,?,?,?,?,?)`,
      id, input.loanId, input.effectiveFrom, input.annualRatePct, input.note ?? null, nowIST(),
    );

    appendEvent(db, actor, {
      entity: "loan", entityId: input.loanId, action: "rate-change",
      before: { rate: previous }, after: { rate: input.annualRatePct },
      summary:
        `Rate moved from ${previous}% to ${input.annualRatePct}% ` +
        `with effect from ${formatDate(input.effectiveFrom)}`,
    });

    return queryOne<RatePeriod>(db, `SELECT * FROM loan_rates WHERE id = ?`, id)!;
  });
}

// ---------------------------------------------------------------------------
// R18 · Recording an actual instalment
// ---------------------------------------------------------------------------

/**
 * R18 · An instalment is a transfer from a Budget account to the loan account,
 * funded from the loan payment category.
 *
 * The split is the lender's where given (R18.1, authoritative) and the
 * projection's otherwise (R18.2, marked estimated). Only the principal portion
 * reduces the outstanding balance; the interest portion is an expense.
 */
export function recordInstalment(
  db: DB, actor: Actor,
  input: {
    loanId: string;
    date: IsoDate;
    amount: Paise;
    /** R18.1: the lender's own split, where entered or parsed. */
    principal?: Paise | null;
    interest?: Paise | null;
    fromAccountId?: string | null;
    kind?: LoanPayment["kind"];
    note?: string | null;
  },
): LoanPayment {
  if (input.amount <= 0) throw new Error("An instalment needs an amount above zero.");

  return transact(db, () => {
    const loan = getLoan(db, input.loanId);
    if (!loan) throw new Error("That loan does not exist.");

    let principal = input.principal ?? null;
    let interest = input.interest ?? null;
    let estimated = 0;

    if (principal === null || interest === null) {
      // R18.2: fall back to the projected split, and mark it.
      const outstanding = outstandingPrincipal(db, input.loanId);
      const rate = currentRate(db, input.loanId, input.date);
      const projectedInterest = Math.round((outstanding * rate) / 1200);
      interest = Math.min(projectedInterest, input.amount);
      principal = input.amount - interest;
      estimated = 1;
    }

    if (principal + interest !== input.amount) {
      throw new Error(
        `The split adds up to ${formatPaise(principal + interest)}, but the payment is ` +
          `${formatPaise(input.amount)}.`,
      );
    }

    let transactionId: string | null = null;
    if (input.fromAccountId) {
      // The payment envelope is reduced by the full amount, and the loan
      // account rises by it — symmetric with a card payment (R6).
      const [out] = createTransfer(db, actor, {
        fromAccountId: input.fromAccountId,
        toAccountId: loan.account_id,
        amount: input.amount,
        date: input.date,
        memo: `${loan.lender} instalment`,
      });
      transactionId = out.id;
    }

    const id = newId();
    execute(
      db,
      `INSERT INTO loan_payments
         (id,loan_id,date,amount,principal,interest,estimated,kind,transaction_id,note,created_at,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, input.loanId, input.date, input.amount, principal, interest, estimated,
      input.kind ?? "instalment", transactionId, input.note ?? null, nowIST(), actor.memberId,
    );

    const payment = queryOne<LoanPayment>(db, `SELECT * FROM loan_payments WHERE id = ?`, id)!;
    appendEvent(db, actor, {
      entity: "loan", entityId: input.loanId, action: "instalment", after: payment,
      summary:
        `Paid ${formatPaise(input.amount)} on ${formatDate(input.date)} — ` +
        `${formatPaise(principal)} principal, ${formatPaise(interest)} interest` +
        (estimated ? " (split estimated, not yet confirmed by the lender)" : ""),
    });
    return payment;
  });
}

export function listPayments(db: DB, loanId: string): LoanPayment[] {
  return queryAll<LoanPayment>(
    db, `SELECT * FROM loan_payments WHERE loan_id = ? ORDER BY date, created_at`, loanId,
  );
}

/** Disbursed less every principal portion recorded against the loan. */
export function outstandingPrincipal(db: DB, loanId: string): Paise {
  const loan = getLoan(db, loanId);
  if (!loan) return 0;

  const opening = Math.max(0, -(getAccount(db, loan.account_id)?.opening_balance ?? 0));
  // Only draws made since the loan was added; the opening balance already
  // carries whatever was drawn before that.
  const disbursed = recordedDisbursements(db, loanId);
  const repaid =
    queryOne<{ total: number }>(
      db, `SELECT COALESCE(SUM(principal),0) AS total FROM loan_payments WHERE loan_id = ?`, loanId,
    )?.total ?? 0;

  return Math.max(0, opening + disbursed - repaid);
}

// ---------------------------------------------------------------------------
// Projections and metrics
// ---------------------------------------------------------------------------

export interface LoanProjection {
  loan: Loan;
  outstanding: Paise;
  disbursed: Paise;
  undrawn: Paise;
  ratePct: number;
  emi: Paise;
  /** R15: interest-only, while the loan is not yet fully drawn or in moratorium. */
  preEmi: Paise | null;
  /** R16 M3/M4 · Present only while a moratorium loan is still in its moratorium. */
  moratorium: {
    months: number;
    capitalised: boolean;
    /** M4 · interest rolled into principal — the cost of not paying now. */
    capitalisedInterest: Paise;
    /** M3 · total interest serviced across the moratorium. */
    totalServiced: Paise;
    /** What the EMI phase amortises against. */
    balanceAtRepaymentStart: Paise;
  } | null;
  schedule: Schedule;
  /** R17.3: the schedule as at origination, so savings are measurable. */
  baseline: Schedule;
  metrics: LifetimeMetrics;
  /**
   * R18.4 · Drift, and null when there is nothing to measure against.
   *
   * Drift is the projection diverging from the *lender's* balance (R18.8).
   * Comparing the projection to our own ledger instead would report every
   * extra payment as drift — that is the household paying more on purpose,
   * not the projection going wrong.
   */
  driftAmount: Paise | null;
  driftMaterial: boolean;
  driftAsOf: IsoDate | null;
  /** M2 only — the rate a flat quote really is. */
  equivalentReducingRatePct: number | null;
}

export function projectLoan(db: DB, loanId: string): LoanProjection | null {
  const loan = getLoan(db, loanId);
  if (!loan) return null;

  const disbursed = totalDisbursed(db, loanId);
  const openingOwed = Math.max(0, -(getAccount(db, loan.account_id)?.opening_balance ?? 0));
  // A mid-life loan's baseline starts from what was owed when it was added —
  // R22.3's "from DD-MM-YYYY", not from origination, which is unknown.
  const principalBase = openingOwed > 0 ? openingOwed : disbursed;
  const outstanding = outstandingPrincipal(db, loanId);
  const rate = currentRate(db, loanId);

  const payments = listPayments(db, loanId);
  const paidInterest = payments.reduce((sum, p) => sum + p.interest, 0);
  const paidPrincipal = payments.reduce((sum, p) => sum + p.principal, 0);
  const charges = payments.filter((p) => p.kind === "charge").reduce((sum, p) => sum + p.amount, 0);

  const remainingMonths = Math.max(1, loan.tenure_months - payments.filter((p) => p.kind === "instalment").length);

  const baseline =
    principalBase > 0
      ? buildSchedule({
          principal: principalBase,
          annualRatePct: firstRate(db, loanId),
          months: loan.tenure_months,
          firstInstalmentDate: loan.first_instalment_date ?? undefined,
        })
      : emptySchedule();

  // R16 M3/M4 · A loan still in its moratorium amortises against the balance the
  // moratorium leaves behind — the original principal if interest is serviced,
  // or the grown principal if it is capitalised. Once repayment has begun (a
  // recorded instalment), the moratorium is history and the live outstanding
  // governs.
  const inMoratorium =
    (loan.interest_model === "moratorium-serviced" ||
      loan.interest_model === "moratorium-capitalised") &&
    loan.moratorium_months > 0 &&
    payments.filter((pay) => pay.kind === "instalment").length === 0;

  const moratoriumOutcome = inMoratorium && outstanding > 0
    ? moratorium({
        principal: outstanding,
        annualRatePct: rate,
        moratoriumMonths: loan.moratorium_months,
        repaymentMonths: loan.tenure_months,
        capitalise: loan.interest_model === "moratorium-capitalised",
      })
    : null;

  const scheduleprincipal = moratoriumOutcome?.balanceAtRepaymentStart ?? outstanding;
  const scheduleMonths = moratoriumOutcome ? loan.tenure_months : remainingMonths;

  const schedule =
    outstanding > 0
      ? buildSchedule({
          principal: scheduleprincipal,
          annualRatePct: rate,
          months: scheduleMonths,
          firstInstalmentDate: loan.first_instalment_date ?? undefined,
        })
      : emptySchedule();

  // R15.1: while undrawn, the obligation is interest on what has been drawn.
  const fullyDrawn = disbursed >= loan.sanctioned || disbursed === 0;

  const statement = latestStatement(db, loanId);
  const driftResult = statement
    ? drift(outstanding, statement.lender_outstanding)
    : null;

  return {
    loan,
    outstanding,
    disbursed,
    undrawn: Math.max(0, loan.sanctioned - disbursed),
    ratePct: rate,
    emi: moratoriumOutcome
      ? moratoriumOutcome.emiAfter
      : outstanding > 0 ? emiFor(outstanding, rate, remainingMonths) : 0,
    // During a moratorium the monthly obligation is the servicing (M3) or the
    // drawn-amount pre-EMI (an under-construction loan). Capitalised (M4) pays
    // nothing now, which is exactly what makes it expensive later.
    preEmi: moratoriumOutcome
      ? (moratoriumOutcome.monthlyInterest > 0 ? moratoriumOutcome.monthlyInterest : null)
      : fullyDrawn ? null : preEmi(disbursed, rate),
    moratorium: moratoriumOutcome
      ? {
          months: loan.moratorium_months,
          capitalised: loan.interest_model === "moratorium-capitalised",
          capitalisedInterest: moratoriumOutcome.capitalisedInterest,
          totalServiced: moratoriumOutcome.totalServiced,
          balanceAtRepaymentStart: moratoriumOutcome.balanceAtRepaymentStart,
        }
      : null,
    schedule,
    baseline,
    metrics: lifetimeMetrics({
      disbursed: principalBase,
      actualInterestPaid: paidInterest,
      actualPrincipalRepaid: paidPrincipal,
      projectedRemainingInterest: schedule.totalInterest,
      baselineInterest: baseline.totalInterest,
      // B51: both sides must come from the same derivation. Hardcoding
      // `loan.tenure_months` here while `projectedMonths` derived from the
      // schedule meant a loan with nothing drawn — empty schedule, zero
      // projected months — reported `tenure_months` instalments "saved" (240 on
      // a fresh 20-year loan). `baseline.months` is 0 for an undrawn loan, so
      // the two agree and the phantom saving disappears.
      baselineMonths: baseline.months,
      projectedMonths: payments.filter((p) => p.kind === "instalment").length + schedule.months,
      fees: charges,
      fromDate: loan.history_from,
    }),
    driftAmount: driftResult?.amount ?? null,
    driftMaterial: driftResult?.material ?? false,
    driftAsOf: statement?.as_of ?? null,
    equivalentReducingRatePct:
      loan.interest_model === "flat" && principalBase > 0
        ? flatRateLoan(principalBase, rate, loan.tenure_months).equivalentReducingRatePct
        : null,
  };
}

function firstRate(db: DB, loanId: string): number {
  return listRatePeriods(db, loanId)[0]?.annual_rate_pct ?? 0;
}

function emptySchedule(): Schedule {
  return {
    instalments: [], totalInterest: 0, months: 0, finalEmi: 0, totalRepaid: 0, closesOn: null,
  };
}

/** R18.6 · Re-anchor the projection from the lender's balance. */
export function reanchorToLenderBalance(
  db: DB, actor: Actor,
  input: { loanId: string; lenderOutstanding: Paise; asOf: IsoDate },
): void {
  transact(db, () => {
    const projected = outstandingPrincipal(db, input.loanId);
    const difference = projected - input.lenderOutstanding;
    if (difference === 0) return;

    // R18.7: recorded history and lifetime interest paid are untouched. The
    // adjustment is a principal-only correction to the forward projection.
    execute(
      db,
      `INSERT INTO loan_payments
         (id,loan_id,date,amount,principal,interest,estimated,kind,note,created_at,created_by)
       VALUES (?,?,?,?,?,0,0,'charge',?,?,?)`,
      newId(), input.loanId, input.asOf, 0, difference,
      `Re-anchored to the lender's balance of ${formatPaise(input.lenderOutstanding)}`,
      nowIST(), actor.memberId,
    );

    appendEvent(db, actor, {
      entity: "loan", entityId: input.loanId, action: "reanchor",
      before: { outstanding: projected }, after: { outstanding: input.lenderOutstanding },
      summary:
        `Re-anchored the projection to the lender's ${formatPaise(input.lenderOutstanding)} ` +
        `as of ${formatDate(input.asOf)} — a difference of ${formatPaise(difference)}. ` +
        `Recorded history and lifetime interest are unchanged.`,
    });
  });
}

/** R21 · Closure, with the summary R21.2 requires. */
export function closeLoan(
  db: DB, actor: Actor, input: { loanId: string; date: IsoDate; settlement?: Paise },
): LifetimeMetrics {
  return transact(db, () => {
    const projection = projectLoan(db, input.loanId);
    if (!projection) throw new Error("That loan does not exist.");

    if (input.settlement && input.settlement > 0) {
      recordInstalment(db, actor, {
        loanId: input.loanId,
        date: input.date,
        amount: input.settlement,
        principal: projection.outstanding,
        interest: input.settlement - projection.outstanding,
        kind: "foreclosure",
        note: "Foreclosure settlement",
      });
    }

    execute(db, `UPDATE loans SET closed_at = ? WHERE id = ?`, nowIST(), input.loanId);
    execute(db, `UPDATE accounts SET closed_at = ? WHERE id = ?`, nowIST(), projection.loan.account_id);

    appendEvent(db, actor, {
      entity: "loan", entityId: input.loanId, action: "close",
      after: projection.metrics,
      summary:
        `Closed the ${projection.loan.lender} loan — ` +
        `${formatPaise(projection.metrics.interestPaid)} of interest paid over its life` +
        (projection.metrics.emisSaved > 0
          ? `, ${projection.metrics.emisSaved} instalments saved`
          : ""),
    });

    return projection.metrics;
  });
}

registerUndoHandler("loan", (db, event) => {
  if (event.action === "create") {
    const loan = event.after as Loan;
    execute(db, `DELETE FROM loan_rates WHERE loan_id = ?`, event.entityId!);
    execute(db, `DELETE FROM categories WHERE id = (SELECT payment_category_id FROM loans WHERE id = ?)`, event.entityId!);
    execute(db, `DELETE FROM loans WHERE id = ?`, event.entityId!);
    execute(db, `DELETE FROM accounts WHERE id = ?`, loan.account_id);
    return `Removed the loan that was added`;
  }
  if (event.action === "close") {
    execute(db, `UPDATE loans SET closed_at = NULL WHERE id = ?`, event.entityId!);
    return `Reopened the loan`;
  }
  return `Reversed a change to the loan`;
});

/** Where the household's monthly obligations sit, for the debt overview (F18.16). */
export interface DebtRow {
  name: string;
  kind: "loan" | "card";
  balance: Paise;
  ratePct: number | null;
  monthlyObligation: Paise;
  monthsRemaining: number | null;
}

export function debtOverview(db: DB): DebtRow[] {
  const rows: DebtRow[] = [];

  for (const loan of listLoans(db)) {
    const projection = projectLoan(db, loan.id);
    if (!projection) continue;
    rows.push({
      name: loan.nickname || `${loan.lender} ${LOAN_TYPE_LABELS[loan.loan_type].toLowerCase()}`,
      kind: "loan",
      balance: projection.outstanding,
      ratePct: projection.ratePct,
      monthlyObligation: projection.preEmi ?? projection.emi,
      monthsRemaining: projection.schedule.months || null,
    });
  }

  for (const card of queryAll<{ id: string; name: string }>(
    db, `SELECT id, name FROM accounts WHERE kind = 'credit' AND closed_at IS NULL`,
  )) {
    const balance =
      queryOne<{ total: number }>(
        db,
        `SELECT COALESCE(SUM(amount),0) + (SELECT opening_balance FROM accounts WHERE id = ?) AS total
           FROM transactions WHERE account_id = ? AND deleted_at IS NULL`,
        card.id, card.id,
      )?.total ?? 0;
    if (balance >= 0) continue;
    rows.push({
      name: card.name, kind: "card", balance: -balance,
      ratePct: null, monthlyObligation: 0, monthsRemaining: null,
    });
  }

  return rows.sort((a, b) => b.balance - a.balance);
}

export { monthOf };
