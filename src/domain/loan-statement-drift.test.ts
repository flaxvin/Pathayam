/**
 * DEBUG-LOANS-2 · A lender's statement is a balance on a date, and the app's
 * side of the comparison has to be the balance on that same date.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import {
  createLoan, projectLoan, recordInstalment, recordLoanStatement, reanchorToLenderBalance, outstandingPrincipal,
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
  const loan = createLoan(db, actor, {
    lender: "SBI", loanType: "home", sanctioned: rupees(10_00_000), sanctionDate: "2026-01-01",
    interestModel: "reducing", annualRatePct: 9, tenureMonths: 120,
    currentOutstanding: rupees(10_00_000) as Paise, repaymentAccountId: bank.id,
  });
  return { db, bankId: bank.id, loanId: loan.id };
}

describe("DEBUG-LOANS-2 · drift against a lender statement", () => {
  test("paying the next instalment does not open a drift against a matching statement", () => {
    const { db, bankId, loanId } = setup();
    recordLoanStatement(db, actor, { loanId, asOf: "2026-02-01", lenderOutstanding: rupees(10_00_000) as Paise });
    assert.equal(projectLoan(db, loanId)!.driftMaterial, false);

    recordInstalment(db, actor, {
      loanId, date: "2026-03-05", amount: rupees(12_667) as Paise,
      principal: rupees(5_167) as Paise, interest: rupees(7_500) as Paise, fromAccountId: bankId,
    });

    const p = projectLoan(db, loanId)!;
    assert.equal(
      p.driftMaterial, false,
      `the statement of 1 Feb agreed to the paisa, yet a March instalment read as ` +
      `${p.driftAmount} paise of drift against it`,
    );
    assert.equal(p.driftAmount, 0);
  });

  test("a statement dated before a payment is compared with the balance on its date", () => {
    const { db, bankId, loanId } = setup();
    recordInstalment(db, actor, {
      loanId, date: "2026-03-05", amount: rupees(12_667) as Paise,
      principal: rupees(5_167) as Paise, interest: rupees(7_500) as Paise, fromAccountId: bankId,
    });
    const s = recordLoanStatement(db, actor, {
      loanId, asOf: "2026-02-28", lenderOutstanding: rupees(10_00_000) as Paise,
    });
    assert.equal(s.app_outstanding, rupees(10_00_000), "the app's figure on 28 Feb, not today's");
    assert.equal(projectLoan(db, loanId)!.driftMaterial, false);
  });

  test("re-anchoring to an older statement does not undo the payments made since", () => {
    const { db, bankId, loanId } = setup();
    recordInstalment(db, actor, {
      loanId, date: "2026-03-05", amount: rupees(12_667) as Paise,
      principal: rupees(5_167) as Paise, interest: rupees(7_500) as Paise, fromAccountId: bankId,
    });
    // The lender agrees with the app on 28 Feb, so there is nothing to correct.
    reanchorToLenderBalance(db, actor, { loanId, asOf: "2026-02-28", lenderOutstanding: rupees(10_00_000) as Paise });
    assert.equal(
      outstandingPrincipal(db, loanId), rupees(10_00_000 - 5_167),
      "the March instalment was added back onto the debt",
    );
  });
});
