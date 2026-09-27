/**
 * MONEY-CORE-18 · A prepayment is funded from the budget that pays the loan.
 *
 * recordPrepayment moved the lump sum from the envelope the household named
 * into the loan's payment envelope with no thought for whose budget each sat
 * in. Ravi's personal loan, prepaid "from" the household's Food, emptied Food
 * by ₹10,000 — but the cash left Ravi's account, so the household's Ready to
 * Assign rose by what Food lost and Ravi's own budget paid. Each scope still
 * balanced, so nothing flagged it. It is refused now, and the form offers only
 * the paying budget's envelopes.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshHousehold, RAVI } from "../engine/identity.test-data.ts";
import { startTestApp } from "../web/harness.test-data.ts";
import { createAccount } from "./accounts.ts";
import { ensurePersonalBudget } from "./budgets.ts";
import { startPersonalBudget, createGroup, createCategory, setAssigned } from "./budget.ts";
import { createLoan, recordPrepayment, paymentCategoryForLoan } from "./loans.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget } from "../engine/engine.ts";
import { monthOf, todayIST } from "../core/dates.ts";
import { Refusal } from "../core/refusal.ts";
import type { Paise } from "../core/money.ts";

const actor = { memberId: RAVI, source: "ui" as const };

function setup() {
  const db = freshHousehold();
  const ravi = ensurePersonalBudget(db, RAVI, "Ravi").id;
  startPersonalBudget(db, actor, ravi);
  createAccount(db, actor, {
    name: "HBank", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 5_000_000,
  });
  const rBank = createAccount(db, actor, {
    name: "RBank", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
    openingBalance: 10_000_000, budgetId: ravi, holderMemberId: RAVI,
  }).id;
  const month = monthOf(todayIST());
  const hFood = createCategory(db, actor, {
    groupId: createGroup(db, actor, "H", "normal", "budget-household").id, name: "H Food",
  }).id;
  setAssigned(db, actor, month, hFood, 2_000_000);
  const rFun = createCategory(db, actor, {
    groupId: createGroup(db, actor, "R", "normal", ravi).id, name: "R Fun",
  }).id;
  setAssigned(db, actor, month, rFun, 2_000_000);
  const loan = createLoan(db, actor, {
    lender: "Imaginary NBFC", loanType: "personal", holderMemberId: RAVI,
    sanctioned: 5_000_000, sanctionDate: "2026-01-01", interestModel: "reducing",
    annualRatePct: 14, tenureMonths: 12, currentOutstanding: 5_000_000, repaymentAccountId: rBank,
  });
  const rta = (budgetId: string) =>
    computeBudget(loadEngineInput(db, { through: month, budgetId })).get(month)!.readyToAssign;
  return { db, ravi, hFood, rFun, loan, rta };
}

describe("MONEY-CORE-18 · funding a prepayment from another budget's envelope", () => {
  test("is refused, and nothing moves", () => {
    const { db, ravi, hFood, loan, rta } = setup();
    const before = [rta("budget-household"), rta(ravi)];
    assert.throws(
      () => recordPrepayment(db, actor, {
        loanId: loan.id, date: todayIST(), amount: 1_000_000 as Paise, mode: "tenure",
        fundingCategoryId: hFood,
      }),
      (err: unknown) => err instanceof Refusal && /another budget/.test(err.message),
    );
    assert.deepEqual([rta("budget-household"), rta(ravi)], before);
    db.close();
  });

  test("an envelope in the loan's own budget still funds it", () => {
    const { db, rFun, loan } = setup();
    assert.ok(paymentCategoryForLoan(db, loan.id));
    recordPrepayment(db, actor, {
      loanId: loan.id, date: todayIST(), amount: 1_000_000 as Paise, mode: "tenure",
      fundingCategoryId: rFun,
    });
    db.close();
  });

  test("the prepay form offers only the paying budget's envelopes", async () => {
    const { db, loan } = setup();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const page = await (await app.get(`/loans/${loan.id}/prepay`)).text();
      assert.match(page, /R Fun/);
      assert.doesNotMatch(page, /H Food/);
    } finally { await app.close(); }
  });
});
