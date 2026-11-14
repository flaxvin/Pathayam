/**
 * UI-14 · A private loan's payment envelope lives in its holder's own budget.
 *
 * Meera added her car loan "Swift" as "Private to me", repaid from the shared
 * SBI account. /loans hid it from Arjun, but its envelope — name, EMI target and
 * spending — sat in the household budget, so it was on his budget, every
 * envelope picker, reports, activity, payees and the SBI register. The form
 * promises "Private means nobody else sees it at all".
 *
 * The envelope now goes in the holder's personal budget (created if need be),
 * moves with the loan when it is switched between shared and private while it
 * has no money or history, and every budget's identity still holds.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount } from "./accounts.ts";
import { setAssigned } from "./budget.ts";
import {
  createLoan, paymentCategoryForLoan, recordInstalment, setLoanVisibility,
  movePrivateLoanEnvelopes, getLoan,
} from "./loans.ts";
import { householdBudgetId, personalBudgetFor } from "./budgets.ts";
import { commitmentEnvelope } from "./commitments.ts";
import { getAccount } from "./accounts.ts";
import { execute, queryOne, type DB } from "../db/db.ts";
import { freshHousehold, identityProblems, rtaOf, RAVI, PRIYA } from "../engine/identity.test-data.ts";
import { computeBudget } from "../engine/engine.ts";
import { loadEngineInput } from "../engine/repository.ts";

const priya: Actor = { memberId: PRIYA, source: "ui" };
const MONTH = "2026-11";
const DAY = "2026-11-05";

function envelopeBudget(db: DB, loanId: string): string | null {
  const payment = paymentCategoryForLoan(db, loanId)!;
  return queryOne<{ budget_id: string | null }>(
    db, `SELECT budget_id FROM categories WHERE id = ?`, payment.id,
  )!.budget_id;
}

function setup() {
  const db = freshHousehold();
  const sbi = createAccount(db, priya, {
    name: "SBI Savings", kind: "budget", subtype: "savings",
    openingDate: "2026-11-01", openingBalance: rupees(2_00_000) as Paise,
  }).id;
  return { db, sbi };
}

function swift(db: DB, sbi: string, visibility: "private" | "household") {
  return createLoan(db, priya, {
    lender: "Fictional Auto Finance", nickname: "Swift", loanType: "car",
    sanctioned: rupees(6_00_000) as Paise, sanctionDate: "2026-11-01",
    interestModel: "reducing", annualRatePct: 9, tenureMonths: 60,
    currentOutstanding: rupees(6_00_000) as Paise,
    repaymentAccountId: sbi, holderMemberId: PRIYA, visibility,
  });
}

describe("UI-14 · a new private loan", () => {
  test("puts its envelope in the holder's own budget, creating it", () => {
    const { db, sbi } = setup();
    assert.equal(personalBudgetFor(db, PRIYA), null);
    const loan = swift(db, sbi, "private");
    const own = personalBudgetFor(db, PRIYA);
    assert.ok(own, "Priya's budget was created");
    assert.equal(envelopeBudget(db, loan.id), own.id);
    // The envelope for the household comes with the budget, as on /budgets/personal.
    assert.ok(commitmentEnvelope(db, own.id), "her commitment envelope exists");
    assert.deepEqual(identityProblems(db, MONTH), []);
  });

  test("a shared loan's envelope stays in the household budget", () => {
    const { db, sbi } = setup();
    const loan = swift(db, sbi, "household");
    assert.equal(envelopeBudget(db, loan.id), householdBudgetId(db));
    assert.equal(personalBudgetFor(db, PRIYA), null);
  });

  test("a private loan with no holder is refused", () => {
    const { db } = setup();
    assert.throws(() => createLoan(db, priya, {
      lender: "Fictional Auto Finance", loanType: "car", sanctioned: rupees(1_00_000) as Paise,
      sanctionDate: "2026-11-01", interestModel: "reducing", annualRatePct: 9, tenureMonths: 12,
      visibility: "private",
    }), Refusal);
  });

  test("the EMI paid from the shared account files to her envelope; both budgets balance", () => {
    const { db, sbi } = setup();
    const loan = swift(db, sbi, "private");
    const own = personalBudgetFor(db, PRIYA)!;
    // Her own money, in her own budget, funds the instalment.
    createAccount(db, priya, {
      name: "Her savings", kind: "budget", subtype: "savings", budgetId: own.id,
      visibility: "private", holderMemberId: PRIYA,
      openingDate: "2026-11-01", openingBalance: rupees(50_000) as Paise,
    });
    const payment = paymentCategoryForLoan(db, loan.id)!;
    setAssigned(db, priya, MONTH, payment.id, rupees(12_455) as Paise);

    const householdBefore = rtaOf(db, MONTH, householdBudgetId(db));
    const ownBefore = rtaOf(db, MONTH, own.id);
    assert.equal(ownBefore, rupees(50_000 - 12_455));

    recordInstalment(db, priya, {
      loanId: loan.id, date: DAY, amount: rupees(12_455) as Paise, fromAccountId: sbi,
    });

    // The household's cash fell by the EMI and it is owed exactly that by her:
    // its Ready to Assign does not move, and neither does hers.
    assert.equal(rtaOf(db, MONTH, householdBudgetId(db)), householdBefore);
    assert.equal(rtaOf(db, MONTH, own.id), ownBefore);
    const hers = computeBudget(loadEngineInput(db, { through: MONTH, budgetId: own.id })).get(MONTH)!;
    assert.equal(hers.categories.get(payment.id)!.balance, 0, "the instalment emptied her envelope");
    const household = computeBudget(
      loadEngineInput(db, { through: MONTH, budgetId: householdBudgetId(db) }),
    ).get(MONTH)!;
    // The engine is handed every envelope; one from another budget has no facts here.
    const there = household.categories.get(payment.id);
    assert.equal(there?.assigned ?? 0, 0);
    assert.equal(there?.activity ?? 0, 0);
    assert.deepEqual(identityProblems(db, MONTH), []);
  });

  test("a card EMI plan still puts its envelope beside the card (ENG-14)", () => {
    const { db } = setup();
    const loan = createLoan(db, priya, {
      lender: "Fictional Bank", nickname: "Card EMI", loanType: "credit-card-emi",
      sanctioned: rupees(30_000) as Paise, sanctionDate: "2026-11-01", interestModel: "reducing",
      annualRatePct: 15, tenureMonths: 6, currentOutstanding: rupees(30_000) as Paise,
      envelopeBudgetId: householdBudgetId(db),
    });
    assert.equal(envelopeBudget(db, loan.id), householdBudgetId(db));
  });
});

describe("UI-14 · switching a loan between shared and private", () => {
  test("moves an envelope with no money or history, both ways", () => {
    const { db, sbi } = setup();
    const loan = swift(db, sbi, "household");
    setLoanVisibility(db, priya, loan.id, { holderMemberId: PRIYA, visibility: "private" });
    const own = personalBudgetFor(db, PRIYA)!;
    assert.equal(envelopeBudget(db, loan.id), own.id);
    assert.equal(getAccount(db, getLoan(db, loan.id)!.account_id)!.visibility, "private");

    setLoanVisibility(db, priya, loan.id, { holderMemberId: PRIYA, visibility: "household" });
    assert.equal(envelopeBudget(db, loan.id), householdBudgetId(db));
    assert.equal(getAccount(db, getLoan(db, loan.id)!.account_id)!.visibility, "household");
    assert.deepEqual(identityProblems(db, MONTH), []);
  });

  test("refuses, and changes nothing, once the envelope has money or history", () => {
    const { db, sbi } = setup();
    const loan = swift(db, sbi, "household");
    const payment = paymentCategoryForLoan(db, loan.id)!;
    setAssigned(db, priya, MONTH, payment.id, rupees(12_455) as Paise);
    recordInstalment(db, priya, {
      loanId: loan.id, date: DAY, amount: rupees(12_455) as Paise, fromAccountId: sbi,
    });
    assert.throws(
      () => setLoanVisibility(db, priya, loan.id, { holderMemberId: PRIYA, visibility: "private" }),
      (e: unknown) => e instanceof Refusal && /already holds money or payments/.test(e.message),
    );
    assert.equal(envelopeBudget(db, loan.id), householdBudgetId(db));
    assert.equal(getAccount(db, getLoan(db, loan.id)!.account_id)!.visibility, "household");
    assert.deepEqual(identityProblems(db, MONTH), []);
  });

  test("a holder change on a shared loan does not move anything", () => {
    const { db, sbi } = setup();
    const loan = swift(db, sbi, "household");
    setLoanVisibility(db, priya, loan.id, { holderMemberId: RAVI, visibility: "household" });
    assert.equal(envelopeBudget(db, loan.id), householdBudgetId(db));
    assert.equal(personalBudgetFor(db, RAVI), null);
  });
});

describe("UI-14 · existing private loans", () => {
  test("the startup move takes clean envelopes to the holder's budget and leaves the rest", () => {
    const { db, sbi } = setup();
    const clean = swift(db, sbi, "household");
    const used = swift(db, sbi, "household");
    const usedPayment = paymentCategoryForLoan(db, used.id)!;
    setAssigned(db, priya, MONTH, usedPayment.id, rupees(1_000) as Paise);
    // As every private loan was stored before UI-14: private, envelope in the household.
    for (const l of [clean, used]) {
      execute(db, `UPDATE accounts SET visibility = 'private', holder_member_id = ? WHERE id = ?`,
        PRIYA, l.account_id);
    }

    const first = movePrivateLoanEnvelopes(db);
    assert.equal(first.moved, 1);
    assert.equal(first.left.length, 1);
    const own = personalBudgetFor(db, PRIYA)!;
    assert.equal(envelopeBudget(db, clean.id), own.id);
    assert.equal(envelopeBudget(db, used.id), householdBudgetId(db));
    assert.deepEqual(identityProblems(db, MONTH), []);

    // Idempotent.
    assert.equal(movePrivateLoanEnvelopes(db).moved, 0);
  });
});
