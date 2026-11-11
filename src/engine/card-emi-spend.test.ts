/**
 * ENG-17 · A card purchase converted to EMI is spent once.
 *
 * The purchase empties its envelope the day it is charged (R6). Converting it
 * moves the debt onto a plan, and each instalment is charged to the card and
 * filed to the plan's envelope. The principal in those instalments repays the
 * purchase — settling a debt already counted, like a card payment — so only
 * the interest and the GST on it are new spending.
 *
 * Counted whole, a ₹60,000 phone converted over 12 months read as about
 * ₹1,26,000 spent in the year: FIRE's annual expenses rose by ₹60,000 (about
 * ₹17 lakh on its number at 3.5%), and the monthly spending chart showed the
 * phone twice.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { convertToEmi } from "../domain/card-emi.ts";
import { recordInstalment, projectLoan, listPayments, createLoan } from "../domain/loans.ts";
import { envelopeSpendByMonth } from "../domain/reports.ts";
import { envelopeSpendBetween } from "./repository.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };
const DATES = [
  "2026-02-10", "2026-03-10", "2026-04-10", "2026-05-10", "2026-06-10", "2026-07-10",
  "2026-08-10", "2026-09-10", "2026-10-10", "2026-11-10", "2026-12-10", "2027-01-10",
];

function household() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m-ravi", "ravi@example.com", "Ravi", nowIST());
  const card = createAccount(db, actor, {
    name: "Fictional Card", kind: "credit", subtype: "credit-card",
    openingDate: "2026-01-01", statementDay: 18, dueDay: 5,
  });
  const group = createGroup(db, actor, "Spending");
  const electronics = createCategory(db, actor, { groupId: group.id, name: "Electronics" });
  return { db, card, electronics: electronics.id };
}

function payAll(db: ReturnType<typeof household>["db"], loanId: string, cardId: string) {
  for (const date of DATES) {
    const p = projectLoan(db, loanId)!;
    if (p.outstanding <= 0) break;
    const last = p.outstanding < p.emi;
    recordInstalment(db, actor, {
      loanId, date, fromAccountId: cardId,
      amount: last ? p.outstanding + Math.round((p.outstanding * 15) / 1200) : p.emi,
    });
  }
}

describe("ENG-17 · an EMI-converted purchase is spent once", () => {
  test("the instalments add only their interest and GST to spending", () => {
    const { db, card, electronics } = household();
    const charge = createTransaction(db, actor, {
      accountId: card.id, amount: -rupees(60_000), date: "2026-01-10",
      categoryId: electronics, payeeName: "Fictional Store",
    });
    const plan = convertToEmi(db, actor, { transactionId: charge.id, tenureMonths: 12, annualRatePct: 15 });
    payAll(db, plan.loan.id, card.id);

    const payments = listPayments(db, plan.loan.id);
    assert.ok(payments.some((p) => p.kind === "charge"), "GST on the interest was charged");
    const cost = payments.reduce((t, p) => t + p.amount - p.principal, 0);
    const expected = rupees(60_000) + cost;

    assert.equal(envelopeSpendBetween(db, "2026-01-01", "2027-01-31"), expected);
    const byMonth = envelopeSpendByMonth(db, "2026-01-01", "2027-01-31");
    assert.equal(byMonth.reduce((t, m) => t + m.spent, 0), expected);
  });

  test("a loan not converted from a recorded purchase still counts its instalments whole", () => {
    const { db, card } = household();
    const loan = createLoan(db, actor, {
      lender: "Fictional Bank", nickname: "Old card plan", loanType: "credit-card-emi",
      sanctioned: rupees(60_000), sanctionDate: "2026-01-10", interestModel: "reducing",
      annualRatePct: 15, tenureMonths: 12, currentOutstanding: rupees(60_000),
    });
    payAll(db, loan.id, card.id);
    const paid = listPayments(db, loan.id).reduce((t, p) => t + p.amount, 0);
    assert.equal(envelopeSpendBetween(db, "2026-01-01", "2027-01-31"), paid);
  });
});
