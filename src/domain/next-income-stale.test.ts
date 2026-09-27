/**
 * IMPORTS-SCHEDULES-14 · A payday that falls today is today's, however stale next_due is.
 *
 * A monthly salary on the 26th, next_due 26 Aug never ticked off: asked on
 * 25 Sep, nextIncome answered 26 Sep; asked on 26 Sep — payday itself — it
 * answered 26 Oct, and the budget screen put the money a month away.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import type { IsoDate } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createSchedule, nextIncome } from "./schedules.ts";
import { freshHousehold, RAVI } from "../engine/identity.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

describe("IMPORTS-SCHEDULES-14 · nextIncome on payday with a stale date", () => {
  test("a stale monthly salary is due today on its day, and tomorrow the day before", () => {
    const db = freshHousehold();
    const accountId = createAccount(db, actor, {
      name: "ZZ Bank", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 100_000,
    }).id;
    createSchedule(db, actor, {
      name: "ZZ Salary", accountId, amount: 8_500_000 as Paise, recurrence: "monthly",
      nextDue: "2026-08-26" as IsoDate,
    });
    const on = (today: string) => nextIncome(db, { today: today as IsoDate, viewerMemberId: RAVI })?.date;
    assert.equal(on("2026-09-25"), "2026-09-26");
    assert.equal(on("2026-09-26"), "2026-09-26");
    assert.equal(on("2026-09-27"), "2026-10-26");
  });
});
