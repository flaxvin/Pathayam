/**
 * D8b · Income arrives; it is not paid.
 *
 * The schedules list offers an income schedule an "Arrived" button and a bill
 * a "Paid" one — but both answered "Marked paid.", so pressing Arrived on a
 * salary was confirmed in the words of a bill.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createCategory, createGroup } from "../domain/budget.ts";
import { createSchedule } from "../domain/schedules.ts";
import { todayIST } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";

const RAVI = "m-ravi";
const actor = { memberId: RAVI, source: "ui" as const };

function notice(res: Response): string {
  const location = res.headers.get("location") ?? "";
  return new URL(location, "http://x").searchParams.get("notice") ?? "";
}

describe("D8b · the confirmation matches the button", () => {
  test("income marked arrived says arrived; a bill marked paid says paid", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    const bank = createAccount(db, actor, {
      name: "Bank", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 1_000_000,
    }).id;
    const rent = createCategory(db, actor, { groupId: createGroup(db, actor, "Bills").id, name: "Rent" }).id;
    const salary = createSchedule(db, actor, {
      name: "Salary", accountId: bank, amount: 5_000_000 as Paise, recurrence: "monthly", nextDue: todayIST(),
    });
    const bill = createSchedule(db, actor, {
      name: "Flat", accountId: bank, categoryId: rent, amount: -2_000_000 as Paise,
      recurrence: "monthly", nextDue: todayIST(),
    });

    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const arrived = await app.post(`/schedules/${salary.id}/paid`, {});
      assert.equal(arrived.status, 303);
      assert.equal(notice(arrived), "Marked arrived.");

      const paid = await app.post(`/schedules/${bill.id}/paid`, {});
      assert.equal(paid.status, 303);
      assert.equal(notice(paid), "Marked paid.");
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
