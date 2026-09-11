/**
 * B77/B78 · What "spent" means, and what a rupee looks like once it is text.
 *
 * Two faults the Overview showed at once. It reported "Spent this month ₹1,060"
 * in a month the household spent ₹22,010, because the figure counted cash
 * leaving budget accounts and 95% of the spending was on a credit card. And it
 * printed a three-month average as "₹13,666.66.66666666674428", because an
 * average of three integers was cast to Paise rather than rounded to one.
 *
 * The first mattered more than a wrong tile: the same measure was the
 * denominator of months-of-runway, so the app reported months of safety the
 * household did not have.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, formatPaise, type Paise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createTransaction, createTransfer } from "./transactions.ts";
import { incomeVsExpense, envelopeSpendByMonth } from "./reports.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function household() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(100000),
  }).id;
  const card = createAccount(db, actor, {
    name: "Atlas", kind: "credit", subtype: "credit-card",
    openingDate: "2026-08-01", openingBalance: 0,
  }).id;
  const group = createGroup(db, actor, "Flexible");
  const groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" }).id;
  return { db, bank, card, groceries };
}

describe("B78 · spending is money leaving an envelope, whatever paid for it", () => {
  test("card spending counts; it is invisible to the cashflow measure", () => {
    const { db, bank, card, groceries } = household();
    createTransaction(db, actor, {
      accountId: bank, amount: -rupees(1000), date: "2026-09-05",
      categoryId: groceries, payeeName: "Kirana",
    });
    createTransaction(db, actor, {
      accountId: card, amount: -rupees(20000), date: "2026-09-06",
      categoryId: groceries, payeeName: "Big Basket",
    });

    const cashflow = incomeVsExpense(db, "2026-09-01", "2026-09-30").at(-1)!.spending;
    const spent = envelopeSpendByMonth(db, "2026-09-01", "2026-09-30").at(-1)!.spent;

    assert.equal(cashflow, rupees(1000), "the cashflow measure sees only the bank");
    assert.equal(spent, rupees(21000), "spending is everything that left an envelope");
    db.close();
  });

  test("paying the card off is not a second act of spending", () => {
    const { db, bank, card, groceries } = household();
    createTransaction(db, actor, {
      accountId: card, amount: -rupees(20000), date: "2026-09-06",
      categoryId: groceries, payeeName: "Big Basket",
    });
    // R6 · Settling the card moves money between accounts; the spend already
    // happened when the charge did.
    createTransfer(db, actor, {
      fromAccountId: bank, toAccountId: card, amount: rupees(20000), date: "2026-09-28",
    });

    assert.equal(
      envelopeSpendByMonth(db, "2026-09-01", "2026-09-30").at(-1)!.spent,
      rupees(20000),
      "counting the payment as well would double it",
    );
    db.close();
  });

  test("income and transfers are not spending", () => {
    const { db, bank, groceries } = household();
    createTransaction(db, actor, {
      accountId: bank, amount: rupees(150000), date: "2026-09-01", payeeName: "Salary",
    });
    createTransaction(db, actor, {
      accountId: bank, amount: -rupees(2500), date: "2026-09-05",
      categoryId: groceries, payeeName: "Kirana",
    });
    assert.equal(
      envelopeSpendByMonth(db, "2026-09-01", "2026-09-30").at(-1)!.spent,
      rupees(2500),
    );
    db.close();
  });

  test("a month with no spending simply does not appear", () => {
    const { db } = household();
    assert.deepEqual(envelopeSpendByMonth(db, "2026-09-01", "2026-09-30"), []);
    db.close();
  });
});

describe("B77 · an amount never renders as a fraction of a paisa", () => {
  test("a non-integer that reaches the formatter is rounded, not split raw", () => {
    // What the Overview did: an average of three integers, cast not rounded.
    const average = ((rupees(10000) + rupees(15000) + rupees(16000)) / 3) as Paise;
    assert.ok(!Number.isInteger(average), "the fixture must actually be fractional");

    const text = formatPaise(average);
    assert.doesNotMatch(text, /\.\d+\./, `two decimal points in "${text}"`);
    assert.match(text, /^₹[\d,]+(\.\d{2})?$/);
  });

  test("whole amounts are untouched", () => {
    assert.equal(formatPaise(rupees(13666)), "₹13,666");
    assert.equal(formatPaise(1366666 as Paise), "₹13,666.66");
    assert.equal(formatPaise(-1366666 as Paise), "-₹13,666.66");
  });
});
