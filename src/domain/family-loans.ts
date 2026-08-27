/**
 * `10` §3.5 · F2.10, FL1–FL9 · Private lending within the family.
 *
 * Money lent to or borrowed from a person rather than an institution. It is
 * neither of the two things the app already has, and forcing it into either is
 * wrong in a way that shows up immediately:
 *
 *   · As a **loan** (`06`), there is no rate, no EMI, no schedule and no lender
 *     statement, so R18.8's drift has nothing to measure and R15–R17 have
 *     nothing to model. Setting an interest rate of zero to make the screens
 *     render is how a module becomes a lie.
 *   · As a **Tracking account**, the balance is a number retyped each month,
 *     untethered from the events behind it — which loses the only thing the
 *     household wants to know.
 *
 * So: FL2 · **the balance is derived, never typed.** Every advance and
 * repayment is a transfer against a real Budget account (FL3), which means the
 * account balance machinery already computes the outstanding figure and R1
 * stays true — lending ₹50,000 really does reduce what is available to assign.
 *
 * FL4 is the rule that keeps the budget honest: an advance is not spending and
 * a repayment is not income. Lending money does not consume an envelope, and
 * being repaid is not earnings. Only a write-off (FL7) is an expense.
 *
 * FL9 is the rule that keeps the *app* honest. There are no reminders here, no
 * ageing alerts and no nudges. N18 forbids the app being used to apply
 * pressure, and the person on the other side of a family loan is not a debtor
 * to be managed.
 */

import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, registerUndoHandler, type Actor } from "../core/events.ts";
import { todayIST, nowIST, daysBetween, formatDate, type IsoDate } from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import { createAccount, getAccount } from "./accounts.ts";
import { createTransfer, createTransaction, deleteTransaction } from "./transactions.ts";
import { accountBalances } from "../engine/repository.ts";

/** FL1 · Money lent is an asset; money borrowed is a liability. */
export type LendingDirection = "lent" | "borrowed";

export interface FamilyLoan {
  id: string;
  account_id: string;
  counterparty: string;
  direction: LendingDirection;
  /** FL5 · An agreed total, not a rate. Null when nothing extra was agreed. */
  agreed_total: Paise | null;
  note: string | null;
  started_at: IsoDate;
  closed_at: string | null;
  written_off_at: string | null;
  write_off_transaction_id: string | null;
  created_at: string;
}

export function createFamilyLoan(
  db: DB, actor: Actor,
  input: {
    counterparty: string;
    direction: LendingDirection;
    note?: string | null;
    agreedTotal?: Paise | null;
    startedAt?: IsoDate;
  },
): FamilyLoan {
  return transact(db, () => {
    const started = input.startedAt ?? todayIST();
    const name = input.direction === "lent"
      ? `Lent to ${input.counterparty}`
      : `Borrowed from ${input.counterparty}`;

    // FW1/FL8 · A Tracking account, so it can never fund the budget, and so
    // R30's firewall covers it without a special case.
    const account = createAccount(db, actor, {
      name,
      kind: "tracking",
      subtype: "family-loan",
      openingBalance: 0,
      openingDate: started,
    });

    const id = newId();
    execute(
      db,
      `INSERT INTO family_loans
         (id,account_id,counterparty,direction,agreed_total,note,started_at,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      id, account.id, input.counterparty, input.direction,
      input.agreedTotal ?? null, input.note ?? null, started, nowIST(),
    );

    appendEvent(db, actor, {
      entity: "family-loan", entityId: id, action: "create",
      after: { counterparty: input.counterparty, direction: input.direction },
      summary: `Started tracking money ${input.direction === "lent" ? "lent to" : "borrowed from"} ${input.counterparty}`,
    });

    return getFamilyLoan(db, id)!;
  });
}

export function getFamilyLoan(db: DB, id: string): FamilyLoan | null {
  return queryOne<FamilyLoan>(db, `SELECT * FROM family_loans WHERE id = ?`, id);
}

export function listFamilyLoans(db: DB, opts: { includeClosed?: boolean } = {}): FamilyLoan[] {
  return queryAll<FamilyLoan>(
    db,
    opts.includeClosed
      ? `SELECT * FROM family_loans ORDER BY closed_at IS NOT NULL, started_at DESC`
      : `SELECT * FROM family_loans WHERE closed_at IS NULL ORDER BY started_at DESC`,
  );
}

/**
 * FL3 · An advance: money leaves a Budget account and the balance owed grows.
 *
 * Recorded as a transfer, which is what makes FL4 true without any special
 * casing — a transfer consumes no category, so lending does not read as
 * spending anywhere in the app.
 */
export function recordAdvance(
  db: DB, actor: Actor,
  input: { loanId: string; amount: Paise; date?: IsoDate; fromAccountId: string; memo?: string | null },
): void {
  transact(db, () => {
    const loan = requireOpen(db, input.loanId);
    if (input.amount <= 0) throw new Error("Enter an amount greater than zero.");

    const date = input.date ?? todayIST();

    // Direction decides which way the money actually moves. Lending sends it
    // out; borrowing brings it in.
    if (loan.direction === "lent") {
      createTransfer(db, actor, {
        fromAccountId: input.fromAccountId,
        toAccountId: loan.account_id,
        amount: input.amount, date, cleared: true,
        memo: input.memo ?? `Lent to ${loan.counterparty}`,
      });
    } else {
      createTransfer(db, actor, {
        fromAccountId: loan.account_id,
        toAccountId: input.fromAccountId,
        amount: input.amount, date, cleared: true,
        memo: input.memo ?? `Borrowed from ${loan.counterparty}`,
      });
    }

    appendEvent(db, actor, {
      entity: "family-loan", entityId: loan.id, action: "advance",
      after: { amount: input.amount, date },
      summary:
        loan.direction === "lent"
          ? `Lent ${formatPaise(input.amount)} to ${loan.counterparty}`
          : `Borrowed ${formatPaise(input.amount)} from ${loan.counterparty}`,
    });
  });
}

/** FL3 · A repayment, in whichever direction the money is owed. */
export function recordRepayment(
  db: DB, actor: Actor,
  input: { loanId: string; amount: Paise; date?: IsoDate; accountId: string; memo?: string | null },
): void {
  transact(db, () => {
    const loan = requireOpen(db, input.loanId);
    if (input.amount <= 0) throw new Error("Enter an amount greater than zero.");

    const date = input.date ?? todayIST();

    if (loan.direction === "lent") {
      createTransfer(db, actor, {
        fromAccountId: loan.account_id,
        toAccountId: input.accountId,
        amount: input.amount, date, cleared: true,
        memo: input.memo ?? `${loan.counterparty} repaid`,
      });
    } else {
      createTransfer(db, actor, {
        fromAccountId: input.accountId,
        toAccountId: loan.account_id,
        amount: input.amount, date, cleared: true,
        memo: input.memo ?? `Repaid ${loan.counterparty}`,
      });
    }

    appendEvent(db, actor, {
      entity: "family-loan", entityId: loan.id, action: "repayment",
      after: { amount: input.amount, date },
      summary:
        loan.direction === "lent"
          ? `${loan.counterparty} repaid ${formatPaise(input.amount)}`
          : `Repaid ${formatPaise(input.amount)} to ${loan.counterparty}`,
    });
  });
}

export interface FamilyLoanView {
  loan: FamilyLoan;
  /** FL2 · Derived from the transfers, never stored. Always ≥ 0. */
  outstanding: Paise;
  advanced: Paise;
  repaid: Paise;
  /** FL5 · What is still owed against an agreed total, when one was agreed. */
  agreedOutstanding: Paise | null;
  firstAdvance: IsoDate | null;
  lastRepayment: { date: IsoDate; amount: Paise } | null;
  /** FL6 · How long, stated. Nothing is said about it (N18). */
  daysOutstanding: number | null;
  settled: boolean;
  writtenOff: boolean;
}

/**
 * FL6 · Everything the household wants without asking: what is outstanding,
 * since when, and what has been repaid.
 */
export function viewFamilyLoan(
  db: DB, id: string, today: IsoDate = todayIST(),
): FamilyLoanView | null {
  const loan = getFamilyLoan(db, id);
  if (!loan) return null;

  // The write-off is excluded from the tally deliberately. It closes the
  // balance, but nobody paid it back, and counting it as a repayment would
  // overstate what the counterparty actually returned — which is precisely the
  // figure FL6 exists to state honestly.
  const rows = queryAll<{ date: IsoDate; amount: Paise }>(
    db,
    `SELECT date, amount FROM transactions
      WHERE account_id = ? AND deleted_at IS NULL AND id IS NOT ?
      ORDER BY date, created_at`,
    loan.account_id, loan.write_off_transaction_id ?? null,
  );

  // The account's own sign already encodes the direction: lending leaves a
  // positive tracking balance, borrowing a negative one. Reading the magnitude
  // keeps one code path for both.
  let advanced = 0;
  let repaid = 0;
  let firstAdvance: IsoDate | null = null;
  let lastRepayment: { date: IsoDate; amount: Paise } | null = null;

  const growing = loan.direction === "lent" ? 1 : -1;

  for (const row of rows) {
    if (row.amount * growing > 0) {
      advanced += Math.abs(row.amount);
      if (!firstAdvance) firstAdvance = row.date;
    } else if (row.amount !== 0) {
      repaid += Math.abs(row.amount);
      lastRepayment = { date: row.date, amount: Math.abs(row.amount) as Paise };
    }
  }

  const balance = accountBalances(db).get(loan.account_id)?.working ?? 0;
  const outstanding = Math.max(0, Math.abs(balance)) as Paise;

  return {
    loan,
    outstanding,
    advanced: advanced as Paise,
    repaid: repaid as Paise,
    agreedOutstanding:
      loan.agreed_total === null ? null : (Math.max(0, loan.agreed_total - repaid) as Paise),
    firstAdvance,
    lastRepayment,
    daysOutstanding: firstAdvance && outstanding > 0 ? daysBetween(firstAdvance, today) : null,
    settled: outstanding === 0 && advanced > 0,
    writtenOff: loan.written_off_at !== null,
  };
}

/**
 * FL7 · Write off what will not be repaid.
 *
 * The honest end state, and the reason it must exist: an app that cannot
 * express it forces the household either to lie about the balance or to delete
 * the history. Both advances stay (P4); the balance becomes a dated expense to
 * a category they choose.
 */
export function writeOffFamilyLoan(
  db: DB, actor: Actor,
  input: { loanId: string; categoryId: string; date?: IsoDate; note?: string | null },
): Paise {
  return transact(db, () => {
    const view = viewFamilyLoan(db, input.loanId);
    if (!view) throw new Error("That does not exist.");
    if (view.loan.written_off_at) throw new Error("That has already been written off.");
    if (view.outstanding <= 0) throw new Error("There is nothing outstanding to write off.");
    if (view.loan.direction !== "lent") {
      // Writing off money you *borrowed* is income, not an expense, and it is
      // rare enough that guessing at the treatment would be worse than saying
      // so. Recorded by hand as income to the category of their choosing.
      throw new Error(
        "Only money you lent can be written off here. If a debt you owed was " +
        "forgiven, record it as income — it is not an expense.",
      );
    }

    const date = input.date ?? todayIST();

    // FL4's exception: this is the one movement that *is* an expense.
    const expense = createTransaction(db, actor, {
      accountId: view.loan.account_id,
      amount: -view.outstanding,
      date,
      categoryId: input.categoryId,
      memo: input.note ?? `Written off — ${view.loan.counterparty}`,
      cleared: true,
    });

    execute(
      db,
      `UPDATE family_loans SET written_off_at = ?, closed_at = ?, write_off_transaction_id = ?
        WHERE id = ?`,
      nowIST(), nowIST(), expense.id, view.loan.id,
    );

    appendEvent(db, actor, {
      entity: "family-loan", entityId: view.loan.id, action: "write-off",
      after: { amount: view.outstanding, date },
      summary:
        `Wrote off ${formatPaise(view.outstanding)} lent to ${view.loan.counterparty}` +
        (view.firstAdvance ? `, outstanding since ${formatDate(view.firstAdvance)}` : ""),
    });

    return view.outstanding;
  });
}

/** Close a settled arrangement, keeping every transaction. */
export function closeFamilyLoan(db: DB, actor: Actor, id: string): void {
  transact(db, () => {
    const loan = getFamilyLoan(db, id);
    if (!loan) throw new Error("That does not exist.");
    execute(db, `UPDATE family_loans SET closed_at = ? WHERE id = ?`, nowIST(), id);
    execute(db, `UPDATE accounts SET closed_at = ? WHERE id = ?`, nowIST(), loan.account_id);
    appendEvent(db, actor, {
      entity: "family-loan", entityId: id, action: "close",
      summary: `Closed the arrangement with ${loan.counterparty}`,
    });
  });
}

export function reopenFamilyLoan(db: DB, actor: Actor, id: string): void {
  transact(db, () => {
    const loan = getFamilyLoan(db, id);
    if (!loan) throw new Error("That does not exist.");
    execute(db, `UPDATE family_loans SET closed_at = NULL WHERE id = ?`, id);
    execute(db, `UPDATE accounts SET closed_at = NULL WHERE id = ?`, loan.account_id);
    appendEvent(db, actor, {
      entity: "family-loan", entityId: id, action: "reopen",
      summary: `Reopened the arrangement with ${loan.counterparty}`,
    });
  });
}

/**
 * FL8 · What net worth should count, split by direction.
 *
 * Lent money is an asset and borrowed money is a liability, both at the derived
 * balance rather than at anything typed.
 */
export function familyLoanNetWorth(db: DB): {
  lent: { label: string; accountId: string; value: Paise }[];
  borrowed: { label: string; accountId: string; value: Paise }[];
} {
  const lent: { label: string; accountId: string; value: Paise }[] = [];
  const borrowed: { label: string; accountId: string; value: Paise }[] = [];

  for (const loan of listFamilyLoans(db)) {
    const view = viewFamilyLoan(db, loan.id);
    if (!view || view.outstanding <= 0) continue;

    const line = {
      label: loan.direction === "lent"
        ? `Lent to ${loan.counterparty}`
        : `Borrowed from ${loan.counterparty}`,
      accountId: loan.account_id,
      value: view.outstanding,
    };
    (loan.direction === "lent" ? lent : borrowed).push(line);
  }

  return { lent, borrowed };
}

function requireOpen(db: DB, id: string): FamilyLoan {
  const loan = getFamilyLoan(db, id);
  if (!loan) throw new Error("That does not exist.");
  if (loan.written_off_at) throw new Error("That has been written off.");
  if (!getAccount(db, loan.account_id)) throw new Error("Its account is missing.");
  return loan;
}

// R37 · Every action undoes.
registerUndoHandler("family-loan", (db, event) => {
  if (event.action === "write-off") {
    const loan = queryOne<{ write_off_transaction_id: string | null; counterparty: string }>(
      db, `SELECT write_off_transaction_id, counterparty FROM family_loans WHERE id = ?`,
      event.entityId,
    );
    if (loan?.write_off_transaction_id) {
      deleteTransaction(db, { memberId: null, source: "system" }, loan.write_off_transaction_id);
    }
    execute(
      db,
      `UPDATE family_loans SET written_off_at = NULL, closed_at = NULL,
         write_off_transaction_id = NULL WHERE id = ?`,
      event.entityId,
    );
    return `Reversed the write-off for ${loan?.counterparty ?? "that arrangement"}`;
  }

  if (event.action === "close" || event.action === "reopen") {
    const closing = event.action === "close";
    execute(
      db, `UPDATE family_loans SET closed_at = ? WHERE id = ?`,
      closing ? null : nowIST(), event.entityId,
    );
    return closing ? "Reopened it" : "Closed it again";
  }

  return "Nothing to undo.";
});
