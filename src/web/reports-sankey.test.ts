/**
 * BUDGET-19 · The Reports money-flow shows where this month's money was spent.
 *
 * Paying last month's card bill settles spending already counted in the month
 * it happened; drawn again as a flow out of this month's income, one purchase
 * was counted twice.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf, addMonths } from "../core/dates.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransaction, createTransfer } from "../domain/transactions.ts";
import { createGroup, createCategory, setAssigned } from "../domain/budget.ts";
import { freshHousehold, RAVI } from "../engine/identity.test-data.ts";
import { startTestApp } from "./harness.test-data.ts";

const ravi: Actor = { memberId: RAVI, source: "ui" };

test("paying last month's card bill is not this month's spending", async () => {
  const db = freshHousehold();
  const now = monthOf(todayIST());
  const prev = addMonths(now, -1);
  const bank = createAccount(db, ravi, { name: "Bank", kind: "budget", subtype: "savings", openingDate: `${prev}-01`, openingBalance: 0 });
  const card = createAccount(db, ravi, { name: "Fictional card", kind: "credit", subtype: "credit-card", openingDate: `${prev}-01`, openingBalance: 0 });
  const food = createCategory(db, ravi, { groupId: createGroup(db, ravi, "Living").id, name: "Food" });

  createTransaction(db, ravi, { accountId: bank.id, amount: 5_000_000, date: `${prev}-01` });
  setAssigned(db, ravi, prev, food.id, 2_000_000);
  createTransaction(db, ravi, { accountId: card.id, amount: -2_000_000, date: `${prev}-15`, categoryId: food.id });

  createTransaction(db, ravi, { accountId: bank.id, amount: 5_000_000, date: `${now}-01` });
  createTransfer(db, ravi, { fromAccountId: bank.id, toAccountId: card.id, amount: 2_000_000, date: `${now}-01` });
  createTransaction(db, ravi, { accountId: bank.id, amount: -300_000, date: `${now}-01`, categoryId: food.id });
  execute(db, `UPDATE household SET setup_completed_at = ? WHERE id = 1`, nowIST());

  const app = await startTestApp(db, { memberId: RAVI });
  try {
    const page = await (await app.get("/reports")).text();
    const flows = [...page.slice(page.indexOf("where it flowed")).matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]);
    assert.ok(flows.includes("Kept: ₹47,000"), flows.join(" | "));
    assert.ok(!flows.some((f) => f!.includes("Fictional card")), flows.join(" | "));
  } finally {
    await app.close();
  }
});
