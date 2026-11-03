/**
 * UI-2 · The register flags only what Review would ask about.
 *
 * Weekly UI pass 04-11-2026: in the demo household's HDFC Savings register 90
 * of 300 rows carried the yellow "Uncategorised" chip — card payments,
 * transfers between the household's own accounts, salary credits, and a
 * split dinner whose every rupee was filed. Review (the screen whose job is
 * to list what needs a category) asked about none of them, because none of
 * them needs one: a transfer moves money between budget accounts, income
 * lands in Ready to Assign, a split's lines carry the categories. A warning
 * on a third of the rows is one a household learns to read past.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction, createTransfer } from "../domain/transactions.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";

const RAVI = "m-ravi";
const ravi: Actor = { memberId: RAVI, source: "ui" };

describe("UI-2 · the register's Uncategorised chip", () => {
  test("is on the one row that needs a category, not on transfers, income or splits", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    const today = todayIST();
    const savings = createAccount(db, ravi, {
      name: "SBI Savings", kind: "budget", subtype: "savings",
      openingDate: "2026-01-01", openingBalance: rupees(1_00_000),
    });
    const card = createAccount(db, ravi, {
      name: "HDFC Regalia", kind: "credit", subtype: "credit-card",
      openingDate: "2026-01-01", openingBalance: 0 as Paise,
      creditLimit: rupees(1_00_000), dueDay: 5, statementDay: 20,
    });
    const g = createGroup(db, ravi, "Flexible");
    const groceries = createCategory(db, ravi, { groupId: g.id, name: "Groceries" });
    const eating = createCategory(db, ravi, { groupId: g.id, name: "Eating out" });

    createTransaction(db, ravi, { accountId: savings.id, amount: rupees(85_000), date: today, payeeName: "Salary" });
    createTransaction(db, ravi, {
      accountId: savings.id, amount: -rupees(2_000) as Paise, date: today, payeeName: "Big Bazaar",
      splits: [
        { categoryId: groceries.id, amount: -rupees(1_500) as Paise },
        { categoryId: eating.id, amount: -rupees(500) as Paise },
      ],
    });
    createTransfer(db, ravi, { fromAccountId: savings.id, toAccountId: card.id, amount: rupees(3_000), date: today });
    createTransaction(db, ravi, { accountId: savings.id, amount: -rupees(700) as Paise, date: today, payeeName: "Mystery shop" });

    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const page = await (await app.get(`/accounts/${savings.id}`)).text();
      const rows = [...page.matchAll(/<tr class="[^"]*">([\s\S]*?)<\/tr>/g)].map((m) => m[1]!.replace(/<!--[\s\S]*?-->/g, ""));
      const flagged = rows.filter((r) => /chip-warning">Uncategorised/.test(r));
      assert.equal(flagged.length, 1, `flagged: ${flagged.map((r) => r.replace(/<[^>]+>|\s+/g, " ").trim()).join(" || ")}`);
      assert.match(flagged[0]!, /Mystery shop/);
      const split = rows.find((r) => r.includes("Big Bazaar"))!;
      assert.match(split, /Split/, "a split row says it is split");
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
