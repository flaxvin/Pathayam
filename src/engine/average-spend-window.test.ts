/**
 * DEBUG-ENGINE-5 · "The trailing 90 days" is 90 days.
 *
 * The window ran from 90 days before `asOf` to `asOf`, both ends included —
 * 91 days of spending — and was divided by 90. A household spending exactly
 * ₹90 every day was told it spends ₹91 a day, so the buffer read short and
 * the digest's month of spending (this × 30) was ₹30 too high.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, addDays } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { averageDailySpend } from "./repository.ts";

const actor: Actor = { memberId: "m", source: "ui" };

test("₹90 a day, every day, averages ₹90 a day", () => {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "ravi@example.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(100_000),
  }).id;
  const group = createGroup(db, actor, "Everyday");
  const food = createCategory(db, actor, { groupId: group.id, name: "Food" }).id;

  const asOf = "2026-08-26";
  for (let i = 0; i < 120; i++) {
    createTransaction(db, actor, {
      accountId: bank, amount: -rupees(90), categoryId: food, date: addDays(asOf, -i),
    });
  }

  assert.equal(averageDailySpend(db, asOf, 90), rupees(90));
  assert.equal(averageDailySpend(db, asOf, 30), rupees(90));
  db.close();
});
