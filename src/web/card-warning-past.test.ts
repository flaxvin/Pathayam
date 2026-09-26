/**
 * WEBUX-2 · A past month's card warning weighs that month's debt.
 *
 * The budget screen says "₹X of your <card> balance isn't funded yet" by setting
 * the card's debt against its payment envelope. The envelope was the viewed
 * month's and the debt was today's, so September 2023 — before the card was even
 * opened — warned about all of today's debt, with a "Fund it" link that moved
 * money in September 2023, and a month the card was fully funded in warned about
 * whatever had been charged since.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { buildBudgetView } from "./viewmodel.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, monthOf, addMonths, type IsoDate } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";

const RAVI = "m-ravi";
const ravi: Actor = { memberId: RAVI, source: "ui" };

function household() {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  const now = monthOf(todayIST());
  const last = addMonths(now, -1);
  const beforeCard = addMonths(now, -3);
  createAccount(db, ravi, {
    name: "Joint current", kind: "budget", subtype: "savings",
    openingDate: `${addMonths(now, -6)}-01` as IsoDate, openingBalance: rupees(1_00_000),
  });
  const card = createAccount(db, ravi, {
    name: "Swiggy HDFC", kind: "credit", subtype: "credit-card",
    openingDate: `${addMonths(now, -2)}-01` as IsoDate, openingBalance: 0 as Paise,
    creditLimit: rupees(1_00_000), dueDay: 5, statementDay: 20,
  });
  const group = createGroup(db, ravi, "Everyday");
  const groceries = createCategory(db, ravi, { groupId: group.id, name: "Groceries" });

  // Last month: ₹3,000 on the card, and ₹3,000 given to Groceries to cover it.
  setAssigned(db, ravi, last, groceries.id, rupees(3_000) as Paise);
  createTransaction(db, ravi, {
    accountId: card.id, amount: -rupees(3_000), date: `${last}-10` as IsoDate, categoryId: groceries.id,
  });
  // Today: ₹5,000 more, nothing assigned to it yet.
  createTransaction(db, ravi, {
    accountId: card.id, amount: -rupees(5_000), date: todayIST(), categoryId: groceries.id,
  });
  return { db, card, now, last, beforeCard };
}

describe("WEBUX-2 · the card warning on a past month", () => {
  test("a month that funded its card in full has nothing to warn about", () => {
    const { db, card, last } = household();
    const funding = buildBudgetView(db, last).cards.find((c) => c.accountId === card.id)!;
    assert.equal(funding.unfunded, 0, "last month was warned about today's spending");
  });

  test("a month before the card existed has no card debt at all", () => {
    const { db, card, beforeCard } = household();
    const funding = buildBudgetView(db, beforeCard).cards.find((c) => c.accountId === card.id);
    assert.equal(funding?.unfunded ?? 0, 0, "a month before the card was opened warned about today's debt");
  });

  test("today's month still weighs today's debt", () => {
    const { db, card, now } = household();
    const funding = buildBudgetView(db, now).cards.find((c) => c.accountId === card.id)!;
    assert.ok(funding.unfunded > 0, "the charge nobody has funded went unmentioned");
  });

  test("and the screens agree", async () => {
    const { db, last, beforeCard } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      for (const month of [last, beforeCard]) {
        for (const path of [`/?month=${month}`, `/review?month=${month}`]) {
          const body = (await (await app.get(path)).text()).replace(/\s+/g, " ");
          assert.doesNotMatch(body, /balance isn't funded yet/, `${path} warned about today's debt`);
        }
      }
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
