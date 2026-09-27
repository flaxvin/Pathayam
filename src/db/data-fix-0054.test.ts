/**
 * 0054 · a loan closed before BUDGET-27 stops asking for its EMI.
 *
 * Closing a loan left its payment envelope's monthly target in place, so the
 * envelope read underfunded by the instalment every month after.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execute, queryOne, migrate } from "./db.ts";
import { MIGRATIONS } from "./schema.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createLoan, paymentCategoryForLoan } from "../domain/loans.ts";
import { rupees } from "../core/money.ts";

const ravi = { memberId: "m-ravi", source: "ui" as const };

test("0054 · a closed loan's envelope loses its target; an open loan's keeps it", () => {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const bank = createAccount(db, ravi, { name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(1_00_000) }).id;
  const loan = (lender: string) => createLoan(db, ravi, {
    lender, loanType: "personal", sanctioned: rupees(50_000), sanctionDate: "2026-01-01",
    interestModel: "reducing", annualRatePct: 12, tenureMonths: 12,
    currentOutstanding: rupees(50_000), repaymentAccountId: bank,
  });
  const closed = loan("Fictional Lender");
  const open = loan("Another Fictional Lender");
  // What the old close left behind: closed, target still on.
  execute(db, `UPDATE loans SET closed_at = '2026-06-01T09:00:00.000+05:30' WHERE id = ?`, closed.id);

  const targetOf = (id: string) => queryOne(db, `SELECT 1 AS n FROM targets WHERE category_id = ?`,
    paymentCategoryForLoan(db, id)!.id);
  assert.ok(targetOf(closed.id));

  db.exec("PRAGMA user_version = 53");
  migrate(db, false, 54);
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);

  assert.equal(targetOf(closed.id), null);
  assert.ok(targetOf(open.id));
});
