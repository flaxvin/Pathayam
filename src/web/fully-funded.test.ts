/**
 * UI-PASS-11 · "Fully funded — every target met and nothing left to assign"
 * sat above "Books and courses is over by ₹2,300". An envelope with no target
 * that has gone below zero is not funded, whatever the targets say.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember } from "./harness.test-data.ts";
import { buildBudgetView } from "./viewmodel.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, monthOf } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";

const RAVI = "m-ravi";
const ravi: Actor = { memberId: RAVI, source: "ui" };

describe("UI-PASS-11 · a month with an overspent envelope is not fully funded", () => {
  test("every rupee assigned, no targets, and one envelope below zero", () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    const month = monthOf(todayIST());
    const bank = createAccount(db, ravi, {
      name: "Joint current", kind: "budget", subtype: "savings",
      openingDate: `${month}-01`, openingBalance: rupees(1_000),
    });
    const group = createGroup(db, ravi, "Everyday");
    const groceries = createCategory(db, ravi, { groupId: group.id, name: "Groceries" });
    const books = createCategory(db, ravi, { groupId: group.id, name: "Books" });
    setAssigned(db, ravi, month, groceries.id, rupees(1_000) as Paise);

    const before = buildBudgetView(db, month, undefined, RAVI);
    assert.equal(before.monthState.readyToAssign, 0);
    assert.equal(before.fullyFunded, true, "the control: fully funded before anything is overspent");

    createTransaction(db, ravi, {
      accountId: bank.id, amount: -rupees(300) as Paise, date: todayIST(), categoryId: books.id,
    });
    const after = buildBudgetView(db, month, undefined, RAVI);
    assert.ok(after.categories.get(books.id)!.state.balance < 0);
    assert.equal(after.fullyFunded, false);
  });
});
