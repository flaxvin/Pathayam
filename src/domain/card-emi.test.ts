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
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned } from "./budget.ts";
import { createTransaction } from "./transactions.ts";
import { loadEngineInput, accountBalances } from "../engine/repository.ts";
import { computeBudget, identityResidual, cardFunding } from "../engine/engine.ts";
import { convertToEmi, GST_PCT } from "./card-emi.ts";
import { projectLoan, listLoans } from "./loans.ts";

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
     * The document quotes whole rupees: EMI ₹5,415, interest ₹4,986, fee ₹235,
     * total cost ₹5,221. The engine works in paise and lands on each of them —
     * ₹5,415.50, ₹4,985.98, ₹234.82, ₹5,220.80 — so these are the exact figures,
     * and the assertion that they are within a rupee of §7.4 is what ties the
     * two together. The EMI is a genuine half-rupee, which is why rounding it
     * reads as ₹5,416 and the document as ₹5,415; neither is wrong.
     */
    assert.equal(result.emi, 541_550, "₹5,415.50");
    assert.equal(result.interest, 498_598, "₹4,985.98");
    assert.equal(result.feeWithGst, 23_482, "₹199 + 18% GST = ₹234.82");
    assert.equal(result.totalCostOfBorrowing, 522_080, "₹5,220.80");
    assert.equal(GST_PCT, 18);

    const withinARupee = (paise: number, documented: number) =>
      Math.abs(paise - documented * 100) <= 100;
    assert.ok(withinARupee(result.emi, 5_415), "§7.4's EMI");
    assert.ok(withinARupee(result.interest, 4_986), "§7.4's interest");
    assert.ok(withinARupee(result.feeWithGst, 235), "§7.4's fee");
    assert.ok(withinARupee(result.totalCostOfBorrowing, 5_221), "§7.4's total cost");
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
