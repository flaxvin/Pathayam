/**
 * td-UI-9 · A card EMI's loan page said its ₹30,000 was "Credited to an
 * account — arrived as money to assign". It was credited to the card: it paid
 * that balance down and Ready to Assign never moved. Only a budget account's
 * disbursement is money to assign.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransaction } from "../domain/transactions.ts";
import { createGroup, createCategory, setAssigned } from "../domain/budget.ts";
import { convertToEmi } from "../domain/card-emi.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, monthOf } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";

const actor: Actor = { memberId: "m-meera", source: "ui" };
const flat = (s: string) => s.replace(/\s+/g, " ");

test("a card EMI's disbursement is not called money to assign", async () => {
  const db = freshDb();
  seedMember(db, "m-meera", "Meera");
  const month = monthOf(todayIST());
  createAccount(db, actor, {
    name: "Savings", kind: "budget", subtype: "savings",
    openingDate: `${month}-01`, openingBalance: rupees(1_00_000),
  });
  const card = createAccount(db, actor, {
    name: "Fictional Card", kind: "credit", subtype: "credit-card", openingDate: `${month}-01`,
  });
  const group = createGroup(db, actor, "Flexible");
  const personal = createCategory(db, actor, { groupId: group.id, name: "Personal" });
  setAssigned(db, actor, month, personal.id, rupees(30_000));
  const charge = createTransaction(db, actor, {
    accountId: card.id, amount: -rupees(30_000) as Paise, categoryId: personal.id,
    payeeName: "Croma", date: todayIST(),
  });
  const { loan } = convertToEmi(db, actor, { transactionId: charge.id, annualRatePct: 15, tenureMonths: 6 });

  const app = await startTestApp(db, { memberId: "m-meera" });
  try {
    const page = flat(await (await app.get(`/loans/${loan.id}`)).text());
    assert.match(page, /Disbursements/);
    assert.doesNotMatch(page, /arrived as money to assign/);
    assert.match(page, /Credited to Fictional Card — it paid that balance down and never entered Ready to Assign/);
    assert.deepEqual(app.failures, []);
  } finally {
    await app.close();
  }
});
