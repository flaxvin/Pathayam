/**
 * `06` §7.4 · Converting a card purchase to EMI.
 *
 * The property the design singles out is the one tested hardest: the household
 * must not be asked to fund the same purchase twice. Charging ₹60,000 to a card
 * already reserves ₹60,000 in its payment envelope (R6); if the conversion left
 * the card's outstanding alone, the household would owe twelve instalments *and*
 * a ₹60,000 card bill for the same thing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne, type DB } from "../db/db.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned } from "./budget.ts";
import { createTransaction, createTransfer } from "./transactions.ts";
import { loadEngineInput, accountBalances } from "../engine/repository.ts";
import { computeBudget, identityResidual, cardFunding } from "../engine/engine.ts";
import { convertToEmi, GST_PCT } from "./card-emi.ts";
import {
  projectLoan, listLoans, listPayments, recordInstalment, createLoan, gstOnInterest, scheduleGst,
} from "./loans.ts";
import { buildSchedule } from "../loans/amortisation.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };
const MONTH = monthOf(todayIST());

/** A card carrying a ₹60,000 purchase, with the spending envelope funded for it. */
function cardWithCharge() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());

  createAccount(db, actor, {
    name: "Joint current", kind: "budget", subtype: "savings",
    openingBalance: rupees(2_00_000), openingDate: todayIST(),
  });
  const card = createAccount(db, actor, {
    name: "HDFC Regalia", kind: "credit", subtype: "credit-card",
    institution: "HDFC Bank", openingDate: todayIST(), statementDay: 18, dueDay: 5,
  });
  const group = createGroup(db, actor, "Spending");
  const electronics = createCategory(db, actor, { groupId: group.id, name: "Electronics" });
  const fees = createCategory(db, actor, { groupId: group.id, name: "Bank charges" });

  setAssigned(db, actor, MONTH, electronics.id, rupees(60_000));
  const charge = createTransaction(db, actor, {
    accountId: card.id, amount: -rupees(60_000), date: todayIST(),
    categoryId: electronics.id, payeeName: "Croma",
  });

  return { db, card, charge, electronics: electronics.id, fees: fees.id };
}

function state(db: DB) {
  return computeBudget(loadEngineInput(db, { through: MONTH })).get(MONTH)!;
}

function paymentEnvelope(db: DB, cardId: string) {
  const row = queryOne<{ id: string }>(
    db, `SELECT id FROM categories WHERE payment_account_id = ?`, cardId,
  )!;
  return state(db).categories.get(row.id)!;
}

describe("06 §7.4 · converting a card purchase to EMI", () => {
  test("before conversion, the card asks to be cleared in full", () => {
    const { db, card } = cardWithCharge();
    assert.equal(paymentEnvelope(db, card.id).balance, rupees(60_000));
    assert.equal(accountBalances(db).get(card.id)?.working, -rupees(60_000));
  });

  test("the card's outstanding falls, so nothing is funded twice", () => {
    const { db, card, charge } = cardWithCharge();

    convertToEmi(db, actor, {
      transactionId: charge.id, tenureMonths: 12, annualRatePct: 15,
    });

    // The revolving balance is gone: the bank moved it onto the plan.
    assert.equal(accountBalances(db).get(card.id)?.working, 0);

    // And the card stops asking. The envelope still holds the money, which the
    // household can move to the EMI's own envelope — but nothing is *unfunded*,
    // which is the figure R6 puts in front of them.
    const funding = cardFunding(card.id, 0, paymentEnvelope(db, card.id).balance, 0);
    assert.equal(funding.unfunded, 0, "the same purchase is not asked for twice");
  });

  test("the plan exists, with its own envelope and a schedule", () => {
    const { db, charge } = cardWithCharge();
    const result = convertToEmi(db, actor, {
      transactionId: charge.id, tenureMonths: 12, annualRatePct: 15,
    });

    const loan = listLoans(db).find((l) => l.id === result.loan.id)!;
    assert.equal(loan.loan_type, "credit-card-emi");
    assert.ok(loan.payment_category_id, "its own payment envelope (R14, symmetric with R6)");

    const projection = projectLoan(db, loan.id)!;
    assert.equal(projection.outstanding, rupees(60_000));
    assert.equal(projection.schedule.months, 12);
  });

  test("§7.4's worked example: ₹60,000 over 12 months at 15% with a ₹199 fee", () => {
    const { db, charge, fees } = cardWithCharge();
    const result = convertToEmi(db, actor, {
      transactionId: charge.id, tenureMonths: 12, annualRatePct: 15,
      processingFee: rupees(199), feeCategoryId: fees,
    });

    /*
     * The document quotes whole rupees: EMI ₹5,415, interest ₹4,986, GST on the
     * interest ₹897, fee ₹235, total cost ₹6,118. The engine works in paise and
     * lands on each of them — ₹5,415.50, ₹4,985.98, ₹897.46, ₹234.82, ₹6,118.26
     * — so these are the exact figures, and the assertion that they are within a
     * rupee of §7.4 is what ties the two together. The EMI is a genuine
     * half-rupee, which is why rounding it reads as ₹5,416 and the document as
     * ₹5,415; neither is wrong.
     *
     * EMI-GST-1 · The total was ₹5,221 until the GST on the interest was
     * counted: 18% of each instalment's interest, which the issuer charges
     * beside every instalment and the old figure left out.
     */
    assert.equal(result.emi, 541_550, "₹5,415.50");
    assert.equal(result.interest, 498_598, "₹4,985.98");
    assert.equal(result.gstOnInterest, 89_746, "18% GST on each instalment's interest = ₹897.46");
    assert.equal(result.feeWithGst, 23_482, "₹199 + 18% GST = ₹234.82");
    assert.equal(result.totalCostOfBorrowing, 611_826, "₹6,118.26");
    assert.equal(
      result.totalCostOfBorrowing, result.interest + result.gstOnInterest + result.feeWithGst,
      "the total is its parts",
    );
    assert.equal(GST_PCT, 18);

    const withinARupee = (paise: number, documented: number) =>
      Math.abs(paise - documented * 100) <= 100;
    assert.ok(withinARupee(result.emi, 5_415), "§7.4's EMI");
    assert.ok(withinARupee(result.interest, 4_986), "§7.4's interest");
    assert.ok(withinARupee(result.gstOnInterest, 897), "§7.4's GST on interest");
    assert.ok(withinARupee(result.feeWithGst, 235), "§7.4's fee");
    assert.ok(withinARupee(result.totalCostOfBorrowing, 6_118), "§7.4's total cost");
  });

  test("the fee is charged to the card and budgeted like any purchase", () => {
    const { db, card, charge, fees } = cardWithCharge();
    convertToEmi(db, actor, {
      transactionId: charge.id, tenureMonths: 12, annualRatePct: 15,
      processingFee: rupees(199), feeCategoryId: fees,
    });

    // It is on the card, not conjured: the balance is the fee alone now.
    // ₹199 + 18% GST, to the paisa.
    assert.equal(accountBalances(db).get(card.id)?.working, -23_482);
    assert.equal(state(db).categories.get(fees)!.activity, -23_482);
  });

  test("a fee with nowhere to go is refused", () => {
    const { db, charge } = cardWithCharge();
    assert.throws(
      () => convertToEmi(db, actor, {
        transactionId: charge.id, tenureMonths: 12, annualRatePct: 15,
        processingFee: rupees(199),
      }),
      /needs an envelope/,
    );
  });

  test("converting more than was charged is refused", () => {
    const { db, charge } = cardWithCharge();
    assert.throws(
      () => convertToEmi(db, actor, {
        transactionId: charge.id, amount: rupees(90_000),
        tenureMonths: 12, annualRatePct: 15,
      }),
      /cannot be converted from it/,
    );
  });

  test("a bank account does not convert to EMI", () => {
    const { db } = cardWithCharge();
    const bank = queryOne<{ id: string }>(
      db, `SELECT id FROM accounts WHERE kind = 'budget' LIMIT 1`,
    )!;
    assert.throws(
      () => convertToEmi(db, actor, {
        accountId: bank.id, amount: rupees(1_000), tenureMonths: 6, annualRatePct: 15,
      }),
      /Only a card balance/,
    );
  });

  test("the books close, before and after", () => {
    const { db, charge, fees } = cardWithCharge();
    assert.equal(identityResidual(state(db)), 0, "before");

    convertToEmi(db, actor, {
      transactionId: charge.id, tenureMonths: 12, annualRatePct: 15,
      processingFee: rupees(199), feeCategoryId: fees,
    });
    assert.equal(identityResidual(state(db)), 0, "and after");
  });

  test("it records which card the purchase was made on (R6.c)", () => {
    const { db, card, charge } = cardWithCharge();
    const result = convertToEmi(db, actor, {
      transactionId: charge.id, tenureMonths: 12, annualRatePct: 15,
    });
    const row = queryOne<{ card_id: string | null; converted_from_transaction_id: string | null }>(
      db, `SELECT card_id, converted_from_transaction_id FROM loans WHERE id = ?`, result.loan.id,
    )!;
    assert.equal(row.converted_from_transaction_id, charge.id, "traceable to the purchase");
    assert.ok(card.id);
  });
});

describe("06 §7.4 · recording the monthly instalment", () => {
  /**
   * *"The EMI instalment appears on the card statement, so its payment is
   * recorded against the card, while the EMI loan's outstanding reduces. Both
   * views must agree."*
   *
   * So it is an ordinary card charge filed to the plan's own envelope — the R6
   * idiom exactly. The plan's envelope falls by the instalment, the card's
   * payment envelope rises by it, and the household funds the plan once, monthly,
   * in the envelope that exists for it.
   */
  function converted() {
    const fixture = cardWithCharge();
    const result = convertToEmi(fixture.db, actor, {
      transactionId: fixture.charge.id, tenureMonths: 12, annualRatePct: 15,
    });
    const planEnvelope = queryOne<{ id: string }>(
      fixture.db,
      `SELECT c.id FROM loans l JOIN categories c ON c.id = l.payment_category_id WHERE l.id = ?`,
      result.loan.id,
    )!.id;
    return { ...fixture, loan: result.loan, emi: result.emi, planEnvelope };
  }

  test("it is a charge on the card, not a debit from a bank account", () => {
    const { db, card, loan, emi } = converted();
    const bankBefore = accountBalances(db).get(
      queryOne<{ id: string }>(db, `SELECT id FROM accounts WHERE kind='budget' LIMIT 1`)!.id,
    )?.working;

    recordInstalment(db, actor, {
      loanId: loan.id, date: todayIST(), amount: emi, fromAccountId: card.id,
    });

    // EMI-GST-1 · With the GST on the month's ₹750 of interest beside it.
    assert.equal(
      accountBalances(db).get(card.id)?.working, -(emi + gstOnInterest(75_000)),
      "the card carries it, and the GST on its interest",
    );
    assert.equal(
      accountBalances(db).get(
        queryOne<{ id: string }>(db, `SELECT id FROM accounts WHERE kind='budget' LIMIT 1`)!.id,
      )?.working,
      bankBefore,
      "and no bank account was touched",
    );
  });

  test("the plan's envelope pays it, and the card's envelope receives it", () => {
    const { db, card, loan, emi, planEnvelope } = converted();

    // Fund the plan's envelope the way a household would, then let the bank charge it.
    // EMI-GST-1 · The month's bill is the instalment and the GST on its interest.
    const due = emi + gstOnInterest(75_000);
    setAssigned(db, actor, MONTH, planEnvelope, due);
    recordInstalment(db, actor, {
      loanId: loan.id, date: todayIST(), amount: emi, fromAccountId: card.id,
    });

    const after = state(db);
    assert.equal(after.categories.get(planEnvelope)!.balance, 0, "the plan's envelope paid it");
    assert.equal(
      paymentEnvelope(db, card.id).balance, due,
      "and the card's now holds exactly what the bank will ask for",
    );
  });

  test("both views agree: the plan's outstanding falls by the principal", () => {
    const { db, card, loan, emi } = converted();
    const before = projectLoan(db, loan.id)!.outstanding;

    recordInstalment(db, actor, {
      loanId: loan.id, date: todayIST(), amount: emi, fromAccountId: card.id,
    });

    const after = projectLoan(db, loan.id)!;
    assert.ok(after.outstanding < before, "the debt fell");
    // Interest is a cost, not repayment, so only the principal part comes off.
    assert.ok(before - after.outstanding < emi, "by the principal, not the whole instalment");
    assert.equal(after.schedule.months, 11, "eleven to go");
  });

  test("the books close after the instalment", () => {
    const { db, card, loan, emi, planEnvelope } = converted();
    setAssigned(db, actor, MONTH, planEnvelope, emi);
    recordInstalment(db, actor, {
      loanId: loan.id, date: todayIST(), amount: emi, fromAccountId: card.id,
    });
    assert.equal(identityResidual(state(db)), 0);
  });

  test("an ordinary loan is still paid from a bank account", () => {
    const { db } = cardWithCharge();
    const bank = queryOne<{ id: string }>(db, `SELECT id FROM accounts WHERE kind='budget' LIMIT 1`)!;
    const loan = createLoan(db, actor, {
      lender: "Axis", loanType: "personal", sanctioned: rupees(1_00_000),
      sanctionDate: todayIST(), interestModel: "reducing", annualRatePct: 12,
      tenureMonths: 12, currentOutstanding: rupees(1_00_000), repaymentAccountId: bank.id,
    });
    const before = accountBalances(db).get(bank.id)!.working;

    recordInstalment(db, actor, {
      loanId: loan.id, date: todayIST(), amount: rupees(8_885), fromAccountId: bank.id,
    });

    assert.ok(
      accountBalances(db).get(bank.id)!.working < before,
      "cash left the account, as a transfer",
    );
  });
});

/**
 * B123 · Dated from the charge, not from the button.
 *
 * Converting a charge from last year used to create a plan starting today and
 * move the envelope money in today's month — so the household's funding for
 * *this* month's card bill walked out of the door to pay for a purchase made
 * fifteen months ago, and this month's payment envelope went ₹84,000 into the
 * red. The plan belongs where the charge is.
 */
describe("06 §7.4 · the plan is dated from the charge it replaces", () => {
  test("an old charge makes an old plan, not one starting today", () => {
    const { db, charge } = cardWithCharge();
    const old = "2026-02-11";
    createTransaction(db, actor, {
      accountId: charge.account_id, amount: -rupees(30_000) as Paise, date: old,
      categoryId: charge.category_id, payeeName: "Croma", cleared: true,
    });
    const older = queryOne<{ id: string }>(
      db, `SELECT id FROM transactions WHERE date = ? LIMIT 1`, old,
    )!;

    const result = convertToEmi(db, actor, {
      transactionId: older.id, tenureMonths: 6, annualRatePct: 14,
    });

    const loan = queryOne<{ sanction_date: string }>(
      db, `SELECT sanction_date FROM loans WHERE id = ?`, result.loan.id,
    )!;
    assert.equal(loan.sanction_date, old, "the plan starts where the purchase was");
  });

  test("and the envelope move lands in the charge's month, not this one", () => {
    const { db, charge } = cardWithCharge();
    const old = "2026-02-11";
    createTransaction(db, actor, {
      accountId: charge.account_id, amount: -rupees(30_000) as Paise, date: old,
      categoryId: charge.category_id, payeeName: "Croma", cleared: true,
    });
    const older = queryOne<{ id: string }>(
      db, `SELECT id FROM transactions WHERE date = ? LIMIT 1`, old,
    )!;

    convertToEmi(db, actor, { transactionId: older.id, tenureMonths: 6, annualRatePct: 14 });

    const movedThisMonth = queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM assignments a
         JOIN categories c ON c.id = a.category_id
        WHERE a.month = ? AND c.payment_account_id IS NOT NULL AND a.amount < 0`,
      MONTH,
    )!.n;
    assert.equal(
      movedThisMonth, 0,
      "this month's card funding was taken to pay for a purchase made months ago",
    );
  });

  test("an explicit date still wins", () => {
    const { db, charge } = cardWithCharge();
    const result = convertToEmi(db, actor, {
      transactionId: charge.id, tenureMonths: 6, annualRatePct: 14, date: "2026-05-02",
    });
    assert.equal(
      queryOne<{ sanction_date: string }>(
        db, `SELECT sanction_date FROM loans WHERE id = ?`, result.loan.id,
      )!.sanction_date,
      "2026-05-02",
    );
  });
});

/*
 * WEALTH-40 / MONEY-CORE-24 · One purchase, one conversion.
 *
 * The only check was that the amount did not exceed the charge, so the same
 * ₹60,000 converted twice made two ₹60,000 plans and credited the card twice;
 * a refund and the card side of a payment converted too. And undoing a
 * conversion from the log was a no-op marked done.
 */
describe("WEALTH-40 · a charge converts once, and only a charge converts", () => {
  const balance = (db: DB, id: string) => accountBalances(db).get(id)?.working ?? 0;

  test("converting the same charge again is refused, and the card is credited once", () => {
    const { db, card, charge } = cardWithCharge();
    convertToEmi(db, actor, { transactionId: charge.id, tenureMonths: 6, annualRatePct: 15 });
    assert.throws(
      () => convertToEmi(db, actor, { transactionId: charge.id, tenureMonths: 6, annualRatePct: 15 }),
      /already on an EMI plan/,
    );
    assert.equal(listLoans(db).length, 1);
    assert.equal(balance(db, card.id), 0);
  });

  test("a part conversion leaves only the rest to convert", () => {
    const { db, charge } = cardWithCharge();
    convertToEmi(db, actor, { transactionId: charge.id, amount: rupees(40_000), tenureMonths: 6, annualRatePct: 15 });
    assert.throws(
      () => convertToEmi(db, actor, { transactionId: charge.id, amount: rupees(30_000), tenureMonths: 6, annualRatePct: 15 }),
      /only ₹20,000 is left/,
    );
    const rest = convertToEmi(db, actor, { transactionId: charge.id, tenureMonths: 6, annualRatePct: 15 });
    assert.equal(rest.loan.sanctioned, rupees(20_000), "the default is what is left, not the whole charge");
  });

  test("a refund and the card side of a payment do not convert", () => {
    const { db, card, electronics } = cardWithCharge();
    const refund = createTransaction(db, actor, {
      accountId: card.id, amount: rupees(5_000), date: todayIST(), categoryId: electronics, payeeName: "Croma",
    });
    assert.throws(
      () => convertToEmi(db, actor, { transactionId: refund.id, tenureMonths: 6, annualRatePct: 15 }),
      /Only a charge converts/,
    );
    const bank = queryOne<{ id: string }>(db, `SELECT id FROM accounts WHERE kind = 'budget'`)!.id;
    createTransfer(db, actor, { fromAccountId: bank, toAccountId: card.id, amount: rupees(10_000), date: todayIST() });
    const leg = queryOne<{ id: string }>(
      db, `SELECT id FROM transactions WHERE account_id = ? AND transfer_pair_id IS NOT NULL`, card.id)!.id;
    assert.throws(
      () => convertToEmi(db, actor, { transactionId: leg, tenureMonths: 6, annualRatePct: 15 }),
      /Only a charge converts|one side of a transfer/,
    );
    assert.equal(listLoans(db).length, 0);
  });

  test("undoing a conversion takes back the plan, the card credit, the fee and the envelope move", () => {
    const { db, card, charge, fees } = cardWithCharge();
    const before = paymentEnvelope(db, card.id).balance;
    convertToEmi(db, actor, {
      transactionId: charge.id, tenureMonths: 12, annualRatePct: 15,
      processingFee: rupees(199), feeCategoryId: fees,
    });
    const event = queryOne<{ id: string }>(
      db, `SELECT id FROM events WHERE entity = 'loan' AND action = 'convert-to-emi'`)!.id;
    const result = undoEvent(db, event, actor, { force: true });
    assert.ok(result.ok, result.reason);

    assert.equal(listLoans(db, { includeClosed: true }).length, 0);
    assert.equal(balance(db, card.id), -rupees(60_000), "the card credit or the fee stayed");
    assert.equal(paymentEnvelope(db, card.id).balance, before, "the envelope move stayed");
    assert.equal(identityResidual(state(db)), 0);
    // And the charge can be converted again, properly this time.
    convertToEmi(db, actor, { transactionId: charge.id, tenureMonths: 6, annualRatePct: 15 });
  });
});

/*
 * EMI-GST-1 · A card EMI's interest carries 18% GST.
 *
 * Notification 9/2017-IT(Rate) Sr.28 keeps "interest involved in credit card
 * services" out of the exemption every other loan's interest enjoys, so each
 * card-EMI statement has a second line beside the instalment: 18% of that
 * month's interest. The plan's cost counted the GST on the processing fee and
 * not this, which on §7.4's example is ₹897 left out of a ₹6,118 cost.
 */
describe("EMI-GST-1 · GST on each instalment's interest", () => {
  function converted() {
    const fixture = cardWithCharge();
    const result = convertToEmi(fixture.db, actor, {
      transactionId: fixture.charge.id, tenureMonths: 12, annualRatePct: 15,
    });
    const planEnvelope = queryOne<{ id: string }>(
      fixture.db, `SELECT payment_category_id AS id FROM loans WHERE id = ?`, result.loan.id,
    )!.id;
    return { ...fixture, result, loan: result.loan, planEnvelope };
  }
  const gstLines = (db: DB, loanId: string) =>
    listPayments(db, loanId).filter((p) => p.kind === "charge" && /GST 18% on EMI interest/.test(p.note ?? ""));

  test("rounded to the paisa per instalment, not once on the total", () => {
    const schedule = buildSchedule({ principal: rupees(60_000), annualRatePct: 15, months: 12 });
    const lines = schedule.instalments.map((i) => gstOnInterest(i.interest));
    // The first month's ₹750 of interest carries ₹135; every line is whole paise.
    assert.equal(lines[0], 13_500);
    assert.ok(lines.every((g) => Number.isInteger(g)));
    assert.equal(scheduleGst(schedule), lines.reduce((a, b) => a + b, 0), "the total is the sum of the lines");
    assert.equal(scheduleGst(schedule), 89_746, "₹897.46");
    // 18% of the total, rounded once, is two paise more: not what the bank charges.
    assert.equal(Math.round(schedule.totalInterest * 0.18), 89_748);
  });

  test("each instalment posts its GST as its own line on the card, from the plan's envelope", () => {
    const { db, card, loan, result, planEnvelope } = converted();
    const before = state(db).categories.get(planEnvelope)!.activity;

    const payment = recordInstalment(db, actor, {
      loanId: loan.id, date: todayIST(), amount: result.emi, fromAccountId: card.id,
    });

    // The instalment is unchanged: the bank's split, with no GST in it.
    assert.equal(payment.amount, result.emi);
    assert.equal(payment.interest, 75_000);
    assert.equal(payment.principal + payment.interest, result.emi);

    const [line] = gstLines(db, loan.id);
    assert.ok(line, "a GST line was recorded against the plan");
    assert.equal(line!.amount, 13_500, "18% of ₹750, to the paisa");
    assert.equal(line!.principal, 0, "it repays nothing");
    assert.equal(line!.interest, 0, "and is not interest");

    const charge = queryOne<{ amount: number; memo: string; category_id: string }>(
      db, `SELECT amount, memo, category_id FROM transactions WHERE id = ?`, line!.transaction_id,
    )!;
    assert.equal(charge.amount, -13_500, "charged to the card");
    assert.match(charge.memo, /GST 18% on EMI interest/);
    assert.equal(charge.category_id, planEnvelope, "and budgeted with the instalment");
    assert.equal(state(db).categories.get(planEnvelope)!.activity, before - result.emi - 13_500);
    assert.equal(identityResidual(state(db)), 0);
  });

  test("the lender's own interest figure is what the GST is charged on", () => {
    const { db, card, loan, result } = converted();
    recordInstalment(db, actor, {
      loanId: loan.id, date: todayIST(), amount: result.emi, interest: 74_999, fromAccountId: card.id,
    });
    assert.equal(gstLines(db, loan.id)[0]!.amount, 13_500, "₹134.9982 rounds to ₹135.00");
    recordInstalment(db, actor, {
      loanId: loan.id, date: todayIST(), amount: result.emi, interest: 69_163, fromAccountId: card.id,
    });
    assert.equal(gstLines(db, loan.id)[1]!.amount, 12_449, "₹124.4934 rounds to ₹124.49");
  });

  test("the whole plan's GST lines sum to the cost quoted at conversion, and the schedule is untouched", () => {
    const { db, card, loan, result } = converted();
    const schedule = projectLoan(db, loan.id)!.schedule.instalments;

    for (const i of schedule) {
      recordInstalment(db, actor, {
        loanId: loan.id, date: todayIST(), amount: i.payment,
        principal: i.principal, interest: i.interest, fromAccountId: card.id,
      });
      // The plan runs down the schedule quoted at conversion, to the paisa: the
      // GST is charged beside it and never feeds back into the amortisation.
      assert.equal(projectLoan(db, loan.id)!.outstanding, i.closing, `after instalment ${i.number}`);
    }

    const lines = gstLines(db, loan.id);
    assert.equal(lines.length, 12, "one line per instalment");
    assert.deepEqual(lines.map((l) => l.amount), schedule.map((i) => gstOnInterest(i.interest)));
    assert.equal(lines.reduce((sum, l) => sum + l.amount, 0), result.gstOnInterest, "₹897.46 in all");

    const after = projectLoan(db, loan.id)!;
    assert.equal(after.outstanding, 0, "the plan is repaid");
    assert.equal(after.interestGst!.remaining, 0, "and nothing is left to charge");
    assert.equal(
      after.metrics.totalCostOfBorrowing, result.interest + result.gstOnInterest,
      "the lifetime cost is the interest and the GST on it",
    );
    assert.equal(identityResidual(state(db)), 0);
  });

  test("the projection and the envelope's target include it", () => {
    const { db, loan, result, planEnvelope } = converted();
    const p = projectLoan(db, loan.id)!;
    assert.deepEqual(p.interestGst, { next: 13_500, remaining: 89_746 });
    assert.equal(p.metrics.totalCostOfBorrowing, result.interest + 89_746);
    const target = queryOne<{ amount: number }>(
      db, `SELECT amount FROM targets WHERE category_id = ?`, planEnvelope,
    )!;
    assert.equal(target.amount, result.emi + 13_500, "the envelope asks for the instalment and its GST");
  });

  test("undoing an instalment takes its GST line and card charge with it", () => {
    const { db, card, loan, result } = converted();
    recordInstalment(db, actor, {
      loanId: loan.id, date: todayIST(), amount: result.emi, fromAccountId: card.id,
    });
    const event = queryOne<{ id: string }>(
      db, `SELECT id FROM events WHERE entity = 'loan' AND action = 'instalment' ORDER BY seq DESC LIMIT 1`,
    )!.id;
    const undone = undoEvent(db, event, actor, { force: true });
    assert.ok(undone.ok, undone.reason);

    assert.equal(listPayments(db, loan.id).length, 0, "neither the instalment nor its GST is left");
    assert.equal(accountBalances(db).get(card.id)?.working ?? 0, 0, "the GST charge is off the card");
    assert.equal(identityResidual(state(db)), 0);
  });

  test("no other loan's interest carries GST", () => {
    const { db } = cardWithCharge();
    const bank = queryOne<{ id: string }>(db, `SELECT id FROM accounts WHERE kind='budget' LIMIT 1`)!;
    const loan = createLoan(db, actor, {
      lender: "Axis", loanType: "personal", sanctioned: rupees(1_00_000),
      sanctionDate: todayIST(), interestModel: "reducing", annualRatePct: 12,
      tenureMonths: 12, currentOutstanding: rupees(1_00_000), repaymentAccountId: bank.id,
    });
    recordInstalment(db, actor, {
      loanId: loan.id, date: todayIST(), amount: rupees(8_885), fromAccountId: bank.id,
    });
    assert.equal(listPayments(db, loan.id).length, 1, "the instalment, and nothing beside it");
    assert.equal(projectLoan(db, loan.id)!.interestGst, null);
  });
});
