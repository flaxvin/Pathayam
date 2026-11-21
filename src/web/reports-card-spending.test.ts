/**
 * DECA-2 · Reports' "Income and spending" counts card spending in Out, the
 * same as the Overview's "Spent this month" (B78). Its Out was cash leaving
 * budget accounts, which a card swipe never is: a first month showed ₹5.28K
 * out and ₹1.33L "net saved" against ₹43,478.82 spent.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import { todayIST } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction, createTransfer } from "../domain/transactions.ts";
import { incomeAndSpending, envelopeSpendByMonth } from "../domain/reports.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function household() {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  const today = todayIST();
  const month = today.slice(0, 7);
  const bank = createAccount(db, actor, {
    name: "SBI", kind: "budget", subtype: "savings", openingDate: `${month}-01`, openingBalance: 0,
  }).id;
  const card = createAccount(db, actor, {
    name: "HDFC card", kind: "credit", subtype: "credit-card", openingDate: `${month}-01`, openingBalance: 0,
  }).id;
  const group = createGroup(db, actor, "Flexible");
  const groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" }).id;
  // Salary in, a small cash spend, a card purchase, and the card paid off.
  createTransaction(db, actor, { accountId: bank, amount: rupees(1_00_000), date: `${month}-01`, payeeName: "Employer" });
  createTransaction(db, actor, { accountId: bank, amount: -rupees(1_000), date: `${month}-01`, categoryId: groceries, payeeName: "Kirana" });
  createTransaction(db, actor, { accountId: card, amount: -rupees(36_000), date: `${month}-01`, categoryId: groceries, payeeName: "Croma" });
  createTransfer(db, actor, { fromAccountId: bank, toAccountId: card, amount: rupees(36_000), date: today });
  return { db, month };
}

describe("DECA-2 · Reports' Out is envelope spending", () => {
  test("a card purchase is in Out once, and the card payment is not counted again", () => {
    const { db, month } = household();
    const [point] = incomeAndSpending(db, `${month}-01`, todayIST());
    assert.equal(point!.income, rupees(1_00_000));
    assert.equal(point!.spending, rupees(37_000));
    assert.equal(point!.net, rupees(63_000));
    // The same basis as the Overview's "Spent this month".
    assert.equal(point!.spending, envelopeSpendByMonth(db, `${month}-01`, todayIST()).at(-1)!.spent);
    db.close();
  });

  test("a month with spending and no income still has a row", () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    const month = todayIST().slice(0, 7);
    const card = createAccount(db, actor, {
      name: "Card", kind: "credit", subtype: "credit-card", openingDate: `${month}-01`, openingBalance: 0,
    }).id;
    const group = createGroup(db, actor, "Flexible");
    const fun = createCategory(db, actor, { groupId: group.id, name: "Fun" }).id;
    createTransaction(db, actor, { accountId: card, amount: -rupees(2_500), date: `${month}-01`, categoryId: fun, payeeName: "PVR" });
    assert.deepEqual(incomeAndSpending(db, `${month}-01`, todayIST()), [
      { month, income: 0, spending: rupees(2_500), net: -rupees(2_500) },
    ]);
    db.close();
  });

  test("the Reports page shows it, and says what Out counts", async () => {
    const { db } = household();
    const app = await startTestApp(db);
    try {
      const page = await (await app.get("/reports?period=this-month")).text();
      assert.match(page, /data-testid="income-spending-basis"/);
      assert.match(page, /a card purchase counts on the day it was made/);
      // Out ₹37K (₹1,000 cash + ₹36,000 on the card), net ₹63K — not ₹1K / ₹99K.
      assert.match(page, /amount-negative">₹37K</);
      assert.match(page, /₹63K/);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
      db.close();
    }
  });
});
