/**
 * DEBUG-LOANS-5 · A closed loan is out of every list and every total, so
 * nothing more may be recorded against it until it is reopened.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createLoan, closeLoan, recordDisbursement, recordInstalment, listPayments } from "./loans.ts";
import { netWorthStatement } from "./networth.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

function closedLoan() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(5_00_000),
  });
  const loan = createLoan(db, actor, {
    lender: "Bajaj", loanType: "personal", sanctioned: rupees(1_00_000), sanctionDate: "2026-01-01",
    interestModel: "reducing", annualRatePct: 12, tenureMonths: 12,
    currentOutstanding: rupees(50_000) as Paise, disbursedAtCreation: rupees(50_000) as Paise,
    repaymentAccountId: bank.id,
  });
  closeLoan(db, actor, { loanId: loan.id, date: "2026-03-01", settlement: rupees(50_000) as Paise });
  return { db, bankId: bank.id, loanId: loan.id };
}

describe("DEBUG-LOANS-5 · a closed loan", () => {
  test("cannot be drawn on — the new debt would reach no total", () => {
    const { db, bankId, loanId } = closedLoan();
    const before = netWorthStatement(db).netWorth;
    assert.throws(
      () => recordDisbursement(db, actor, {
        loanId, date: "2026-04-01", amount: rupees(40_000) as Paise,
        destination: "budget-account", destinationAccountId: bankId,
      }),
      /closed/,
    );
    assert.equal(netWorthStatement(db).netWorth, before,
      "₹40,000 drawn on a closed loan arrived in the bank as if it were nobody's money");
  });

  test("cannot be settled twice", () => {
    const { db, loanId } = closedLoan();
    assert.throws(
      () => closeLoan(db, actor, { loanId, date: "2026-03-02", settlement: rupees(50_000) as Paise }),
      /closed/,
    );
    assert.equal(listPayments(db, loanId).filter((p) => p.kind === "foreclosure").length, 1);
  });

  test("takes no further payment", () => {
    const { db, bankId, loanId } = closedLoan();
    assert.throws(
      () => recordInstalment(db, actor, {
        loanId, date: "2026-04-05", amount: rupees(500) as Paise, principal: 0 as Paise,
        interest: rupees(500) as Paise, fromAccountId: bankId,
      }),
      /closed/,
    );
  });
});
