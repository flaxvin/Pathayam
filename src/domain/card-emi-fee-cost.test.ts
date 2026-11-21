/**
 * DECA-3 · A card EMI's processing fee and its GST are part of the plan's
 * "Total cost of borrowing". The conversion said "costing ₹3,234.82 in
 * interest, GST and fees" and the plan's page said ₹2,882: the fee was charged
 * to the card but never recorded against the plan. It is now recorded as the
 * plan's charge — no principal, no interest — so the outstanding, net worth,
 * budgets and spending count it once, as the card charge it is.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne, queryAll } from "../db/db.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned } from "./budget.ts";
import { createTransaction } from "./transactions.ts";
import { envelopeSpendBetween } from "../engine/repository.ts";
import { convertToEmi } from "./card-emi.ts";
import { projectLoan, listPayments, listLoans } from "./loans.ts";
import { netWorthStatement } from "./networth.ts";
import { loanInterestByFinancialYear } from "./reports.ts";
import { identityProblems } from "../engine/identity.test-data.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };
const MONTH = monthOf(todayIST());

/** The weekly pass's case: ₹36,000 on a card, 9 months at 16%, ₹299 fee. */
function converted(fee = rupees(299)) {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  createAccount(db, actor, {
    name: "SBI", kind: "budget", subtype: "savings", openingBalance: rupees(2_00_000), openingDate: todayIST(),
  });
  const card = createAccount(db, actor, {
    name: "HDFC card", kind: "credit", subtype: "credit-card", institution: "HDFC Bank",
    openingDate: todayIST(), statementDay: 15, dueDay: 3,
  });
  const group = createGroup(db, actor, "Spending");
  const electronics = createCategory(db, actor, { groupId: group.id, name: "Electronics" });
  const fees = createCategory(db, actor, { groupId: group.id, name: "Bank charges" });
  setAssigned(db, actor, MONTH, electronics.id, rupees(36_000));
  setAssigned(db, actor, MONTH, fees.id, rupees(1_000));
  const charge = createTransaction(db, actor, {
    accountId: card.id, amount: -rupees(36_000), date: todayIST(), categoryId: electronics.id, payeeName: "Croma",
  });
  const worthBefore = netWorthStatement(db).netWorth;
  const spentBefore = envelopeSpendBetween(db, `${MONTH}-01`, todayIST());
  const result = convertToEmi(db, actor, {
    transactionId: charge.id, tenureMonths: 9, annualRatePct: 16,
    processingFee: fee, feeCategoryId: fee > 0 ? fees.id : null,
  });
  return { db, card, result, worthBefore, spentBefore };
}

describe("DECA-3 · a card EMI's fee is in its cost of borrowing, counted once", () => {
  test("the plan's Total cost of borrowing matches the conversion: ₹3,234.82", () => {
    const { db, result } = converted();
    assert.equal(result.feeWithGst, 352_82);
    assert.equal(result.totalCostOfBorrowing, 3_234_82);
    const p = projectLoan(db, result.loan.id)!;
    assert.equal(p.metrics.totalCostOfBorrowing, result.totalCostOfBorrowing);
    // The fee is a charge on the plan, linked to the card charge it is.
    const charges = listPayments(db, result.loan.id).filter((x) => x.kind === "charge");
    assert.equal(charges.length, 1);
    assert.equal(charges[0]!.amount, 352_82);
    assert.equal(charges[0]!.principal, 0);
    assert.equal(charges[0]!.interest, 0);
    assert.ok(charges[0]!.transaction_id);
  });

  test("the fee is not added to what is owed on the plan", () => {
    const { db, result } = converted();
    assert.equal(projectLoan(db, result.loan.id)!.outstanding, rupees(36_000));
  });

  test("net worth falls by the fee once, and spending counts it once", () => {
    const { db, worthBefore, spentBefore } = converted();
    assert.equal(netWorthStatement(db).netWorth, worthBefore - 352_82);
    assert.equal(envelopeSpendBetween(db, `${MONTH}-01`, todayIST()), spentBefore + 352_82);
    assert.deepEqual(identityProblems(db, MONTH), []);
  });

  test("no fee, no charge row: the cost is interest and its GST, as before", () => {
    const { db, result } = converted(0 as never);
    assert.equal(listPayments(db, result.loan.id).length, 0);
    assert.equal(projectLoan(db, result.loan.id)!.metrics.totalCostOfBorrowing, result.totalCostOfBorrowing);
  });

  test("the fee alone puts no ₹0 line in loan interest by year", () => {
    const { db, result } = converted();
    assert.equal(loanInterestByFinancialYear(db).filter((r) => r.loan.includes("EMI")).length, 0,
      "a plan with only its fee recorded has no interest year yet");
  });

  test("undoing the conversion takes the fee's charge row with it", () => {
    const { db, card } = converted();
    const event = queryOne<{ id: string }>(
      db, `SELECT id FROM events WHERE entity = 'loan' AND action = 'convert-to-emi'`)!.id;
    const undone = undoEvent(db, event, actor, { force: true });
    assert.ok(undone.ok, undone.reason);
    assert.equal(listLoans(db, { includeClosed: true }).length, 0);
    assert.deepEqual(queryAll(db, `SELECT id FROM loan_payments`), []);
    assert.equal(
      queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND deleted_at IS NULL`, card.id)!.n,
      1, "only the purchase is left on the card",
    );
    assert.deepEqual(identityProblems(db, MONTH), []);
  });
});
