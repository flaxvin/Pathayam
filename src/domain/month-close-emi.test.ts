/**
 * REV-21 · The month close spends an EMI-converted purchase once, as ENG-17
 * made the spending chart, FIRE and the buffer do.
 *
 * A ₹60,000 purchase on a card, converted to 12 instalments: January's close
 * counts the ₹60,000 when it was charged, and every later close counted each
 * instalment whole as well, principal included, so the year's closes added up
 * to the phone twice and each month's savings rate (written into month_closes)
 * was understated by the principal. Only the interest and GST are new.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createTransaction } from "./transactions.ts";
import { convertToEmi } from "./card-emi.ts";
import { recordInstalment, projectLoan, listPayments } from "./loans.ts";
import { monthCloseView } from "./month-close.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

test("an instalment on a converted purchase adds only its interest and GST to the close", () => {
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
  const charge = createTransaction(db, actor, {
    accountId: card.id, amount: -rupees(60_000) as Paise, date: "2026-01-10",
    categoryId: electronics.id, payeeName: "Fictional Store",
  });
  const plan = convertToEmi(db, actor, { transactionId: charge.id, tenureMonths: 12, annualRatePct: 15 });
  recordInstalment(db, actor, {
    loanId: plan.loan.id, date: "2026-02-10", fromAccountId: card.id,
    amount: projectLoan(db, plan.loan.id)!.emi,
  });

  const january = monthCloseView(db, "2026-01", "2026-11-12", undefined, null).outcome;
  assert.equal(january.spending, rupees(60_000), "the purchase, when it was charged");
  assert.equal(january.income, 0, "the conversion's credit on the card is borrowed, not earned");

  const cost = listPayments(db, plan.loan.id)
    .filter((p) => p.date.startsWith("2026-02"))
    .reduce((t, p) => t + p.amount - p.principal, 0);
  assert.ok(cost > 0);
  const february = monthCloseView(db, "2026-02", "2026-11-12", undefined, null).outcome;
  assert.equal(february.spending, cost, "interest and GST only: the principal repays January's purchase");
  assert.equal(february.biggestCategories[0]?.amount, cost);
});
