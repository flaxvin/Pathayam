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
import { Missing, Refusal } from "../core/refusal.ts";
import { setTarget, moveMoney } from "./budget.ts";
import { nowIST, todayIST, formatDate, monthOf, type IsoDate } from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import { createAccount, getAccount } from "./accounts.ts";
import { createTransaction, createTransfer } from "./transactions.ts";
import { familyLoanNetWorth } from "./family-loans.ts";
import { latestValuation } from "./assets.ts";
import {
  buildSchedule, emiFor, flatRateLoan, moratorium, preEmi, drift,
  lifetimeMetrics,
  type Schedule, type InterestModel, type LifetimeMetrics,
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
  /** The live tenure: shortens on a prepayment, extends on a rate reset taken by instalment. */
  tenure_months: number;
  /** The tenure it was first scheduled over. R22's baseline; never moves. */
  original_tenure_months: number | null;
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
  if (input.sanctioned <= 0) throw new Refusal("A loan needs a sanctioned amount above zero.");
  if (input.tenureMonths <= 0) throw new Refusal("A loan needs a tenure of at least one month.");

  return transact(db, () => {
    // F18.g: a Tracking account, so it can never fund the budget.
    const account = createAccount(db, actor, {
      name: input.nickname || `${input.lender} ${LOAN_TYPE_LABELS[input.loanType]}`,
      kind: "tracking",
      subtype: "loan",
      holderMemberId: input.holderMemberId,
      visibility: input.visibility,
      institution: input.lender,
      /*
       * Two different situations, and only one of them sets an opening balance.
       *
       * `currentOutstanding` is what was already owed before this app saw the
       * loan — a mid-life entry, where the opening balance carries it (R14).
       * `disbursementDestination` means the money is being drawn *now*, and the
       * disbursement recorded below carries it instead. Setting both would book
       * the same principal twice: outstanding is opening + disbursements.
       */
      openingBalance: input.disbursementDestination ? 0 : -(input.currentOutstanding ?? 0),
      openingDate: input.sanctionDate,
    });

    const id = newId();
    execute(
      db,
      `INSERT INTO loans
         (id,account_id,lender,nickname,loan_type,sanctioned,sanction_date,interest_model,
          benchmark,tenure_months,original_tenure_months,moratorium_months,first_instalment_date,
          instalment_day,repayment_account_id,
          history_from,disbursed_at_creation,created_at,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, account.id, input.lender, input.nickname ?? null, input.loanType,
      input.sanctioned, input.sanctionDate, input.interestModel,
      input.benchmark ?? null, input.tenureMonths, input.tenureMonths, input.moratoriumMonths ?? 0,
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
    const drawn = input.disbursedAtCreation ?? input.currentOutstanding ?? input.sanctioned;
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

    // R8 · The envelope asks for the instalment from the start.
    syncLoanPaymentTarget(db, actor, id);

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

export function listLoans(
  db: DB, opts: { includeClosed?: boolean; viewerMemberId?: string | null } = {},
): Loan[] {
  /*
   * H2.2 · A private loan is visible only to its holder.
   *
   * This filter did not exist: the flag was offered on the form, stored, shown as
   * a chip, and enforced nowhere — so a loan marked private appeared in everyone's
   * list. A privacy control that records an intention and does not keep it is
   * worse than not offering one, because somebody relies on it.
   *
   * The holder and the flag live on the tracking account the loan hangs off, the
   * same as an asset's, so the rule is the same rule.
   */
  const where: string[] = [];
  const params: (string | null)[] = [];
  if (!opts.includeClosed) where.push("l.closed_at IS NULL");
  if (opts.viewerMemberId !== undefined) {
    where.push("(a.visibility <> 'private' OR a.holder_member_id IS ?)");
    params.push(opts.viewerMemberId);
  }
  return queryAll<Loan>(
    db,
    `SELECT l.* FROM loans l
       JOIN accounts a ON a.id = l.account_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY l.created_at`,
    ...params,
  );
}

/** H2.2 · Whether this viewer may see this loan at all. */
export function canSeeLoan(db: DB, loanId: string, viewerMemberId: string | null): boolean {
  const row = queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM loans l
       JOIN accounts a ON a.id = l.account_id
      WHERE l.id = ? AND (a.visibility <> 'private' OR a.holder_member_id IS ?)`,
    loanId, viewerMemberId,
  );
  return (row?.n ?? 0) > 0;
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
/**
 * R8 + R14 · Keep the loan's payment envelope asking for the instalment.
 *
 * A loan's envelope is where the EMI is budgeted, and the app knows the EMI
 * exactly — so making somebody type it into a target, and retype it after every
 * rate reset, is asking them to maintain a figure the app computes. Without a
 * target the envelope is also invisible to the underfunded total and to
 * auto-assign, which are the two things that would otherwise put the money there.
 *
 * Called after anything that can move the instalment: creating the loan, drawing
 * on it, and a rate change.
 */
export function syncLoanPaymentTarget(db: DB, actor: Actor, loanId: string): void {
  const payment = paymentCategoryForLoan(db, loanId);
  if (!payment) return;

  const projection = projectLoan(db, loanId);
  // During a moratorium the obligation is the pre-EMI, which is what the
  // household actually has to find each month (R16).
  const due = projection?.preEmi ?? projection?.emi ?? 0;
  if (due <= 0) return;

  setTarget(db, actor, payment.id, { type: "monthly", amount: due as Paise });
}

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
  if (input.amount <= 0) throw new Refusal("A disbursement needs an amount above zero.");

  // B51: a disbursement credited to a budget account MUST name the account, or
  // the cash leg below is silently skipped while the liability is still booked —
  // a half-write that raises the debt and delivers no money (the failure class
  // B32 names). Reject the combination rather than record something that is
  // permanently inconsistent with itself.
  if (input.destination === "budget-account" && !input.destinationAccountId) {
    throw new Refusal(
      "Say which account the money landed in, or record it as paid to a third party.",
    );
  }

  return transact(db, () => {
    const loan = getLoan(db, input.loanId);
    if (!loan) throw new Missing("That loan does not exist.");

    const disbursed = totalDisbursed(db, input.loanId);
    if (disbursed + input.amount > loan.sanctioned) {
      throw new Refusal(
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

    // R15.4 · Drawing more changes the instalment, so the envelope follows.
    syncLoanPaymentTarget(db, actor, input.loanId);

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

/**
 * Hold the instalment still and let the tenure take the strain.
 *
 * The projection derives the instalment from what is outstanding over what is
 * left of the tenure, so the tenure is the only lever that keeps an instalment
 * where it is. Shorten it and a prepayment buys months instead of a smaller
 * bill; extend it and a rate rise is absorbed without the monthly figure moving.
 * Both are choices the borrower is entitled to make, and neither was reachable
 * while the tenure could not move.
 */
function keepInstalment(db: DB, actor: Actor, loanId: string, emi: Paise): void {
  const loan = getLoan(db, loanId);
  if (!loan) return;

  const outstanding = outstandingPrincipal(db, loanId);
  if (outstanding <= 0 || emi <= 0) return;

  const paid = queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM loan_payments WHERE loan_id = ? AND kind = 'instalment'`,
    loanId,
  )?.n ?? 0;

  // buildSchedule runs until the balance is actually cleared, so with the
  // instalment pinned it answers how many months that takes — which is the
  // number being asked for.
  const months = buildSchedule({
    principal: outstanding,
    annualRatePct: currentRate(db, loanId),
    months: Math.max(1, loan.tenure_months - paid),
    emi,
  }).months;

  const tenure = paid + months;
  if (tenure === loan.tenure_months) return;
  execute(db, `UPDATE loans SET tenure_months = ? WHERE id = ?`, tenure, loanId);

  // The instalment is meant to be unchanged, but the last one rarely is, and
  // the envelope should ask for what the schedule now says.
  syncLoanPaymentTarget(db, actor, loanId);
}

/**
 * R19.1 · A prepayment, and the choice that comes with it.
 *
 * The choice is the whole point of the screen — RBI requires the lender to
 * offer both, and they are worth very different amounts — and it was being
 * collected, written into the note, and then ignored: the tenure never moved,
 * so every prepayment silently reduced the instalment, including the one the
 * app itself recommends. A recommendation the app then declines to carry out is
 * worse than no recommendation.
 */
export function recordPrepayment(
  db: DB, actor: Actor,
  input: {
    loanId: string;
    date: IsoDate;
    amount: Paise;
    /** "tenure" keeps the instalment and closes early; "emi" keeps the closure date. */
    mode: "tenure" | "emi";
    fromAccountId?: string | null;
    /** R19.4 · The envelope the lump sum comes out of. */
    fundingCategoryId?: string | null;
    charge?: Paise;
  },
): void {
  transact(db, () => {
    const projection = projectLoan(db, input.loanId);
    if (!projection) throw new Refusal("That loan does not exist.");
    if (input.amount <= 0) throw new Refusal("A prepayment needs an amount above zero.");
    if (input.amount > projection.outstanding) {
      throw new Refusal(
        `That is more than the ${formatPaise(projection.outstanding)} still outstanding. ` +
          `To clear the loan, settle and close it instead.`,
      );
    }

    const emiBefore = projection.emi;
    const payment = paymentCategoryForLoan(db, input.loanId);

    /*
     * R19.4 · The screen asks where the money is coming from so that no envelope
     * is quietly drained — and then used the answer for nothing at all. A lakh
     * leaving through the loan's own envelope, which holds one instalment,
     * overdraws it and reports an overspend against a decision the household
     * made deliberately. Move it first, from the envelope they named.
     */
    if (input.fundingCategoryId && payment && input.fundingCategoryId !== payment.id) {
      moveMoney(db, actor, {
        month: monthOf(input.date),
        fromCategoryId: input.fundingCategoryId,
        toCategoryId: payment.id,
        amount: (input.amount + (input.charge ?? 0)) as Paise,
      });
    }

    recordInstalment(db, actor, {
      loanId: input.loanId,
      date: input.date,
      amount: input.amount,
      principal: input.amount,
      interest: 0,
      kind: "prepayment",
      fromAccountId: input.fromAccountId ?? projection.loan.repayment_account_id,
      note: `Prepayment, applied by reducing the ${input.mode === "emi" ? "instalment" : "tenure"}`,
    });

    if (input.charge && input.charge > 0) {
      /*
       * R19.5: recorded as a separate cost, and included in the net saving.
       *
       * `interest: 0`, not `interest: charge`. A prepayment penalty is a fee
       * the lender charges for closing early — it is not interest on borrowed
       * capital, and filing it as interest put it in two places at once: in
       * `fees`, which sums the charge rows' amounts, and again in
       * `paidInterest`, which sums every row's interest. Worse, it reached
       * `loanInterestByFinancialYear`, the figure a household would carry to a
       * §24(b) home-loan interest deduction. A ₹2,000 penalty on a loan that
       * had paid no interest at all was reported as ₹2,000 of interest for the
       * year.
       *
       * The foreclosure charge has always written 0 here. These two are the
       * same kind of cost and now say so.
       */
      recordInstalment(db, actor, {
        loanId: input.loanId, date: input.date, amount: input.charge,
        principal: 0, interest: 0, kind: "charge",
        fromAccountId: input.fromAccountId ?? projection.loan.repayment_account_id,
        note: "Prepayment charge",
      });
    }

    if (input.mode === "tenure") keepInstalment(db, actor, input.loanId, emiBefore);
    else syncLoanPaymentTarget(db, actor, input.loanId);
  });
}

/** R20.1 · A rate change is a new dated period, never an edit to the old one. */
export function recordRateChange(
  db: DB, actor: Actor,
  input: {
    loanId: string; effectiveFrom: IsoDate; annualRatePct: number; note?: string | null;
    /**
     * R20.2 · Which of the two options the lender must offer was taken.
     * "tenure" keeps the closure date and lets the instalment move — the
     * default, and what every rate change did before the choice existed.
     */
    keep?: "tenure" | "emi";
  },
): RatePeriod {
  return transact(db, () => {
    const previous = currentRate(db, input.loanId, input.effectiveFrom);

    // Read the instalment before the new rate exists: keeping it is the whole
    // point of the option, and a moment later it is not the same number.
    const emiBefore = projectLoan(db, input.loanId)?.emi ?? 0;

    const id = newId();
    execute(
      db,
      `INSERT INTO loan_rates (id,loan_id,effective_from,annual_rate_pct,note,created_at)
       VALUES (?,?,?,?,?,?)`,
      id, input.loanId, input.effectiveFrom, input.annualRatePct, input.note ?? null, nowIST(),
    );

    /*
     * R20.2 · A borrower facing a reset gets to choose: keep the instalment and
     * let the tenure move, or keep the closure date and let the instalment move.
     * The app showed both, priced both, and could only ever do the second — the
     * tenure never moved, so the option a household picks when the instalment is
     * all they can afford did nothing.
     */
    if (input.keep === "emi" && emiBefore > 0) keepInstalment(db, actor, input.loanId, emiBefore);

    // R8 · A rate reset moves the instalment, so the envelope's target moves too.
    syncLoanPaymentTarget(db, actor, input.loanId);

    appendEvent(db, actor, {
      entity: "loan", entityId: input.loanId, action: "rate-change",
      before: { rate: previous }, after: { rate: input.annualRatePct },
      summary:
        `Rate moved from ${previous}% to ${input.annualRatePct}% ` +
        `with effect from ${formatDate(input.effectiveFrom)}` +
        (input.keep === "emi"
          ? ", keeping the instalment and moving the tenure"
          : ", keeping the tenure and moving the instalment"),
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
  if (input.amount <= 0) throw new Refusal("An instalment needs an amount above zero.");

  return transact(db, () => {
    const loan = getLoan(db, input.loanId);
    if (!loan) throw new Missing("That loan does not exist.");

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

    /*
     * A charge is neither principal nor interest.
     *
     * The rule below is right for anything that repays a loan: what you paid
     * has to be accounted for as principal plus interest, or money has gone
     * somewhere nobody can name. A fee repays nothing — a prepayment penalty
     * or a foreclosure charge is a cost of closing early, and splitting it
     * into those two buckets is what made it turn up as deductible interest.
     * Foreclosure had already worked around this by inserting its row
     * directly, which is why the two paths disagreed for so long.
     */
    if (input.kind !== "charge" && principal + interest !== input.amount) {
      throw new Refusal(
        `The split adds up to ${formatPaise(principal + interest)}, but the payment is ` +
          `${formatPaise(input.amount)}.`,
      );
    }
    if (input.kind === "charge" && (principal !== 0 || interest !== 0)) {
      throw new Refusal("A charge is a cost, not a repayment — it has no principal or interest.");
    }

    let transactionId: string | null = null;
    if (input.fromAccountId) {
      const from = getAccount(db, input.fromAccountId);

      if (from?.kind === "credit") {
        /*
         * `06` §7.4 · A card EMI's instalment is charged to the card, not paid
         * from a bank account: *"the EMI instalment appears on the card
         * statement, so its payment is recorded against the card, while the EMI
         * loan's outstanding reduces. Both views must agree."*
         *
         * So it is an ordinary card charge filed to the loan's own payment
         * envelope — which is the R6 idiom exactly. The loan's envelope falls by
         * the instalment, the card's payment envelope rises by it, and the
         * household funds the plan once, monthly, in the envelope that exists for
         * it. A transfer would have left the loan's envelope untouched and the
         * card asking for money nothing had set aside.
         */
        const payment = paymentCategoryForLoan(db, input.loanId);
        const charge = createTransaction(db, actor, {
          accountId: input.fromAccountId,
          amount: -input.amount as Paise,
          date: input.date,
          categoryId: payment?.id ?? null,
          payeeName: loan.lender,
          memo: `${loan.nickname || loan.lender} instalment`,
          cleared: true,
        });
        transactionId = charge.id;

        // And the debt itself falls, so the loan's own balance keeps step.
        createTransaction(db, actor, {
          accountId: loan.account_id,
          amount: input.amount,
          date: input.date,
          memo: `${loan.nickname || loan.lender} instalment`,
          cleared: true,
        });
      } else {
        /*
         * B124 · The payment envelope is reduced by the full amount, and the
         * loan account rises by it — symmetric with a card payment (R6), which
         * is what `06` R14 says a loan's envelope is.
         *
         * It was a plain transfer, and a transfer to a tracking account carries
         * no envelope: the money left the budget through Ready to Assign and the
         * envelope kept everything ever assigned to it. So a household that
         * budgeted for its EMI paid for it twice over — once into an envelope
         * that only grew, and again out of the pool when the instalment
         * actually went. Four loans in the demo sat at "not funded" for three
         * years while every instalment was paid on time, which is exactly what
         * that looks like from the outside.
         *
         * Filed to the loan's own envelope instead, it behaves the way the card
         * does: the envelope is what pays, and Ready to Assign is untouched.
         */
        const payment = paymentCategoryForLoan(db, input.loanId);
        const out = createTransaction(db, actor, {
          accountId: input.fromAccountId,
          amount: -input.amount as Paise,
          date: input.date,
          categoryId: payment?.id ?? null,
          payeeName: loan.lender,
          memo: `${loan.nickname || loan.lender} instalment`,
          cleared: true,
        });
        createTransaction(db, actor, {
          accountId: loan.account_id,
          amount: input.amount,
          date: input.date,
          memo: `${loan.nickname || loan.lender} instalment`,
          cleared: true,
        });
        transactionId = out.id;
      }
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
          // The loan as first scheduled — not as it stands after a prepayment
          // shortened it, or a rate reset taken by instalment stretched it.
          months: loan.original_tenure_months ?? loan.tenure_months,
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
        ? flatRateLoan(principalBase, rate, loan.original_tenure_months ?? loan.tenure_months)
            .equivalentReducingRatePct
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
  db: DB, actor: Actor,
  input: {
    loanId: string;
    date: IsoDate;
    settlement?: Paise;
    /**
     * `06` §7.4 / R19.5 · Foreclosing usually costs something — a percentage of
     * the outstanding on a personal loan, a flat fee on a card EMI. It is a real
     * cost of the borrowing and must be recordable, or the prepayment decision is
     * made against a saving that is larger than the one actually available.
     */
    foreclosureCharge?: Paise;
    /** Where the charge is budgeted, and which account it is paid from. */
    chargeCategoryId?: string | null;
    chargeAccountId?: string | null;
  },
): LifetimeMetrics {
  return transact(db, () => {
    const projection = projectLoan(db, input.loanId);
    if (!projection) throw new Missing("That loan does not exist.");

    if (input.foreclosureCharge && input.foreclosureCharge > 0) {
      if (!input.chargeAccountId) {
        throw new Refusal(
          "Say which account the foreclosure charge came out of — a cost with no " +
          "account behind it is a figure nobody paid.",
        );
      }
      createTransaction(db, actor, {
        accountId: input.chargeAccountId,
        amount: -input.foreclosureCharge as Paise,
        date: input.date,
        categoryId: input.chargeCategoryId ?? null,
        payeeName: projection.loan.lender,
        memo: `Foreclosure charge — ${projection.loan.nickname || projection.loan.lender}`,
        cleared: true,
      });
    }

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
  /**
   * `other` is a debt with no schedule behind it — money owed to somebody you
   * know, or an amount stated by hand and revalued. It has no rate and no
   * monthly obligation, which is exactly why it is not a loan; leaving it out
   * of a table headed "Everything you owe" made that heading false.
   */
  kind: "loan" | "card" | "other";
  balance: Paise;
  ratePct: number | null;
  monthlyObligation: Paise;
  monthsRemaining: number | null;
  /** H2 · Whose debt it is; null means the household's, jointly. */
  holderName: string | null;
}

export function debtOverview(db: DB, viewerMemberId?: string | null): DebtRow[] {
  const rows: DebtRow[] = [];

  /*
   * H2 / H2.2 · Whose each debt is, and whose to leave out.
   *
   * "Everything you owe" is a total, so a private loan belonging to somebody else
   * must not be in it — a total including it publishes the amount by subtraction,
   * the same reasoning that governs accounts.
   */
  const holders = new Map(
    queryAll<{ id: string; holder_member_id: string | null; name: string | null }>(
      db,
      `SELECT a.id, a.holder_member_id, m.name
         FROM accounts a LEFT JOIN members m ON m.id = a.holder_member_id`,
    ).map((r) => [r.id, r.name]),
  );

  for (const loan of listLoans(db, { viewerMemberId })) {
    const projection = projectLoan(db, loan.id);
    if (!projection) continue;
    rows.push({
      name: loan.nickname || `${loan.lender} ${LOAN_TYPE_LABELS[loan.loan_type].toLowerCase()}`,
      kind: "loan",
      balance: projection.outstanding,
      ratePct: projection.ratePct,
      monthlyObligation: projection.preEmi ?? projection.emi,
      monthsRemaining: projection.schedule.months || null,
      holderName: holders.get(loan.account_id) ?? null,
    });
  }

  for (const card of queryAll<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM accounts
      WHERE kind = 'credit' AND closed_at IS NULL
        ${viewerMemberId !== undefined ? "AND (visibility <> 'private' OR holder_member_id IS ?)" : ""}`,
    ...(viewerMemberId !== undefined ? [viewerMemberId] : []),
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
      holderName: holders.get(card.id) ?? null,
    });
  }

  /*
   * Debts with no schedule. Two kinds reach here:
   *
   *   · money borrowed from somebody you know, whose balance family lending
   *     derives from the actual transfers;
   *   · a tracking account whose stated value is negative — "other liability",
   *     an amount owed that has no rate, no EMI and no lender.
   *
   * Neither has a rate or a monthly obligation, so those columns stay empty
   * rather than being filled with a zero that would read as "nothing to pay".
   */
  for (const owed of familyLoanNetWorth(db).borrowed) {
    rows.push({
      name: owed.label, kind: "other", balance: owed.value,
      ratePct: null, monthlyObligation: 0, monthsRemaining: null,
      holderName: holders.get(owed.accountId) ?? null,
    });
  }

  for (const account of queryAll<{ id: string; name: string; subtype: string }>(
    db,
    `SELECT id, name, subtype FROM accounts
      WHERE kind = 'tracking' AND closed_at IS NULL
        AND subtype IN ('liability', 'asset')
        ${viewerMemberId !== undefined ? "AND (visibility <> 'private' OR holder_member_id IS ?)" : ""}`,
    ...(viewerMemberId !== undefined ? [viewerMemberId] : []),
  )) {
    /*
     * The balance, not a stated figure. These are tracking accounts: what is
     * owed is the opening balance plus whatever has been paid against it, so
     * repaying some of it moves the number by itself.
     */
    const balance = queryOne<{ total: number }>(
      db,
      `SELECT COALESCE(SUM(amount),0) + (SELECT opening_balance FROM accounts WHERE id = ?) AS total
         FROM transactions WHERE account_id = ? AND deleted_at IS NULL`,
      account.id, account.id,
    )?.total ?? 0;
    const owed = -balance;
    if (owed <= 0) continue;
    rows.push({
      name: account.name, kind: "other", balance: owed as Paise,
      ratePct: null, monthlyObligation: 0, monthsRemaining: null,
      holderName: holders.get(account.id) ?? null,
    });
  }

  return rows.sort((a, b) => b.balance - a.balance);
}

export { monthOf };
