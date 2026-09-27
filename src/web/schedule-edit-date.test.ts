/**
 * IMPORTS-SCHEDULES-25 · An unreadable due date on the edit form is refused, not dropped.
 *
 * /schedules/:id/edit read next_due with `parseDate(raw) ?? undefined`, so
 * "31/02/2027" or "someday" answered 303 "Rent updated." and kept the old
 * date — the person believed it had moved. /schedules/new refuses the same
 * values with a 400.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import type { IsoDate } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createSchedule, getSchedule } from "../domain/schedules.ts";
import { startTestApp, seedMember, freshDb } from "./harness.test-data.ts";

describe("IMPORTS-SCHEDULES-25 · editing a schedule's due date", () => {
  test("an impossible or unreadable date is refused and nothing changes; a good one moves it", async () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    const actor: Actor = { memberId: "m", source: "ui" };
    const acct = createAccount(db, actor, {
      name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
    }).id;
    const rent = createCategory(db, actor, { groupId: createGroup(db, actor, "ZZ G").id, name: "ZZ Rent" }).id;
    const s = createSchedule(db, actor, {
      name: "ZZ Rent", accountId: acct, categoryId: rent, amount: -2_500_000 as Paise,
      recurrence: "monthly", nextDue: "2026-10-05" as IsoDate,
    }).id;
    const app = await startTestApp(db, { memberId: "m" });
    const edit = (next_due: string, name = "ZZ Rent") => app.post(`/schedules/${s}/edit`, {
      name, amount: "25000", direction: "out", recurrence: "monthly", next_due,
      account_id: acct, split_category_0: rent,
    });
    try {
      for (const due of ["31/02/2027", "someday"]) {
        const res = await edit(due, "ZZ Rent renamed");
        assert.equal(res.status, 400, due);
        assert.match(await res.text(), /isn(&#39;|')t a date I can read/);
        assert.equal(getSchedule(db, s)!.next_due, "2026-10-05");
        assert.equal(getSchedule(db, s)!.name, "ZZ Rent");
      }
      assert.equal((await edit("07-11-2026")).status, 303);
      assert.equal(getSchedule(db, s)!.next_due, "2026-11-07");
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });
});
