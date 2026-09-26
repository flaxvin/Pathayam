/**
 * The "Look like schedules" suggestions and what confirming one stores.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { detectSchedules } from "../domain/schedules.ts";
import { startTestApp, seedMember, freshDb } from "./harness.test-data.ts";
import { todayIST, addMonths, monthOf, type IsoDate } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const account = createAccount(db, actor, { name: "ZZ Savings", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(100_000) }).id;
  const g = createGroup(db, actor, "G");
  const category = createCategory(db, actor, { groupId: g.id, name: "Gym" }).id;
  return { db, account, category };
}

/*
 * IMPORTS-SCHEDULES-11 · /schedules/dismiss wrote the dismissal down and said
 * "Won't suggest that again." — and detectSchedules never read it.
 */
describe("'Not a schedule' is remembered", () => {
  test("a dismissed suggestion does not come back", async () => {
    const { db, account, category } = setup();
    for (let i = 1; i <= 4; i++) {
      createTransaction(db, actor, { accountId: account, amount: -rupees(1_500) as Paise,
        date: `${addMonths(monthOf(todayIST()), -i)}-03` as IsoDate, categoryId: category,
        payeeName: "ZZ Fitzone Gym" });
    }
    const suggestion = detectSchedules(db, todayIST(), "m-ravi")[0]!;
    assert.equal(suggestion.payeeName, "ZZ Fitzone Gym");

    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const r = await app.post("/schedules/dismiss", { payee_id: suggestion.payeeId, name: suggestion.payeeName });
      assert.equal(r.status, 303);
      assert.deepEqual(detectSchedules(db, todayIST(), "m-ravi"), []);
      assert.ok(!(await (await app.get("/schedules")).text()).includes("ZZ Fitzone Gym"));
    } finally {
      await app.close();
    }
  });
});
