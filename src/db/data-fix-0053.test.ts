/**
 * 0053 · loan accounts already credited with interest are brought back to the
 * outstanding (WEALTH-16).
 *
 * Same approach as the other data-fix tests: today's code builds the rows, SQL
 * bends them into the shapes the old code wrote, and only this migration
 * replays. Three old shapes:
 *   - since B124, a loan leg of its own carrying the whole instalment (and a
 *     charge's leg carrying the whole charge);
 *   - before B124, a transfer whose loan leg carried the whole instalment;
 *   - a waiver whose credit was written but never linked.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, queryOne, queryAll, migrate, newId, type DB } from "./db.ts";
import { MIGRATIONS } from "./schema.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createLoan, recordInstalment, recordPrepayment, closeLoan, outstandingPrincipal } from "../domain/loans.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

function owed(db: DB, accountId: string): number {
  return -(queryOne<{ bal: number }>(
    db,
    `SELECT opening_balance + COALESCE((SELECT SUM(amount) FROM transactions
                                         WHERE account_id = a.id AND deleted_at IS NULL), 0) AS bal
       FROM accounts a WHERE id = ?`,
    accountId,
  )!.bal) || 0;
}

function loan(db: DB, bank: string, name: string) {
  return createLoan(db, actor, {
    lender: "Fictional Bank", nickname: name, loanType: "personal", sanctioned: rupees(1_00_000),
    sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 12, tenureMonths: 24,
    currentOutstanding: rupees(1_00_000), repaymentAccountId: bank,
  });
}

describe("0053 · the loan leg carries the principal", () => {
  test("old legs are corrected, a transfer is offset, and the waiver is linked", () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const bank = createAccount(db, actor, { name: "Bank", kind: "budget", subtype: "savings",
      openingDate: "2026-01-01", openingBalance: rupees(10_00_000) }).id;

    // A · two EMIs on one day (the pairing must not cross them), and a charge.
    const a = loan(db, bank, "Loan A");
    const a1 = recordInstalment(db, actor, { loanId: a.id, date: "2026-02-05", amount: rupees(5_000) as Paise, fromAccountId: bank });
    const a2 = recordInstalment(db, actor, { loanId: a.id, date: "2026-02-05", amount: rupees(5_000) as Paise, fromAccountId: bank });
    recordPrepayment(db, actor, { loanId: a.id, date: "2026-03-01", amount: rupees(10_000) as Paise,
      mode: "emi", fromAccountId: bank, charge: rupees(500) as Paise });
    // What the old code wrote: every leg the whole amount, and a leg for the charge.
    for (const p of [a1, a2]) {
      execute(db, `UPDATE transactions SET amount = ? WHERE id = ?`, p.amount, p.loan_transaction_id);
    }
    execute(db,
      `INSERT INTO transactions (id,account_id,date,amount,memo,cleared,created_at,updated_at)
       VALUES (?,?,?,?,?,1,?,?)`,
      newId(), a.account_id, "2026-03-01", rupees(500), "Loan A instalment", nowIST(), nowIST());

    // B · before B124: a transfer, both legs the whole instalment.
    const b = loan(db, bank, "Loan B");
    const b1 = recordInstalment(db, actor, { loanId: b.id, date: "2026-02-05", amount: rupees(5_000) as Paise, fromAccountId: bank });
    const pair = newId();
    execute(db, `UPDATE transactions SET category_id = NULL, transfer_pair_id = ? WHERE id = ?`, pair, b1.transaction_id);
    execute(db, `UPDATE transactions SET amount = ?, transfer_pair_id = ? WHERE id = ?`, b1.amount, pair, b1.loan_transaction_id);

    // C · settled for less than owed: the waiver's credit, unlinked.
    const c = loan(db, bank, "Loan C");
    closeLoan(db, actor, { loanId: c.id, date: "2026-02-10", settlement: rupees(90_000) as Paise, settlementAccountId: bank });

    for (const l of [a, b]) {
      assert.notEqual(owed(db, l.account_id), outstandingPrincipal(db, l.id), "the fixture is not the broken shape");
    }

    // As a database from before 0053 would be: no column at all.
    db.exec("ALTER TABLE loan_payments DROP COLUMN loan_transaction_id");
    db.exec("PRAGMA user_version = 52");
    migrate(db, false, 53);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);

    for (const l of [a, b, c]) {
      assert.equal(owed(db, l.account_id), outstandingPrincipal(db, l.id),
        `${l.nickname}: the account still disagrees with the outstanding`);
    }

    // A's legs are linked, each to its own principal.
    const legs = queryAll<{ principal: number; amount: number | null }>(
      db,
      `SELECT p.principal, t.amount FROM loan_payments p
         LEFT JOIN transactions t ON t.id = p.loan_transaction_id AND t.deleted_at IS NULL
        WHERE p.loan_id = ? AND p.kind IN ('instalment', 'prepayment') ORDER BY p.created_at`,
      a.id,
    );
    assert.deepEqual(legs.map((l) => l.amount), legs.map((l) => l.principal));
    assert.equal(queryOne<{ n: number }>(
      db, `SELECT COUNT(*) AS n FROM loan_payments WHERE loan_id = ? AND kind = 'charge' AND loan_transaction_id IS NOT NULL`,
      a.id)!.n, 0, "a charge is linked to a leg it should not have");

    // B's transfer legs are untouched and still equal.
    const bLegs = queryAll<{ amount: number }>(db, `SELECT amount FROM transactions WHERE transfer_pair_id = ?`, pair);
    assert.deepEqual(bLegs.map((l) => Math.abs(l.amount)), [rupees(5_000), rupees(5_000)]);

    // C's waiver is linked to its credit.
    const waiver = queryOne<{ principal: number; amount: number }>(
      db,
      `SELECT p.principal, t.amount FROM loan_payments p JOIN transactions t ON t.id = p.loan_transaction_id
        WHERE p.loan_id = ? AND p.amount = 0`,
      c.id,
    );
    assert.deepEqual([waiver?.principal, waiver?.amount], [rupees(10_000), rupees(10_000)]);
  });
});
