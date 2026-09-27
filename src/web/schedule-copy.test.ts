/**
 * IMPORTS-SCHEDULES-15 · Schedule copy says what happens: nothing posts until marked paid.
 *
 * The /schedules/new hint and the envelope refusals said a scheduled payment
 * "posts itself every month", while the same page's intro says it "does not
 * move money on its own" — and nothing does post a schedule except POST
 * /schedules/:id/paid.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createSchedule } from "../domain/schedules.ts";
import { Refusal } from "../core/refusal.ts";
import type { IsoDate } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";

const RAVI = "m-ravi";
const POSTS_ITSELF = /posts? itself/;

describe("IMPORTS-SCHEDULES-15 · schedules are recorded when marked paid", () => {
  test("the form and its refusals never say a schedule posts itself", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    const bank = createAccount(db, { memberId: RAVI, source: "ui" }, {
      name: "ZZ Bank", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
    }).id;
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const page = await (await app.get("/schedules/new")).text();
      assert.doesNotMatch(page, POSTS_ITSELF);
      assert.match(page, /mark it paid/);

      const res = await app.post("/schedules/new", {
        name: "ZZ Rent", amount: "20000", direction: "out", recurrence: "monthly",
        next_due: "2026-10-05", account_id: bank, split_category_0: "",
      });
      assert.equal(res.status, 422);
      assert.doesNotMatch(await res.text(), POSTS_ITSELF);
    } finally { await app.close(); }

    assert.throws(
      () => createSchedule(db, { memberId: RAVI, source: "ui" }, {
        name: "ZZ Rent", accountId: bank, amount: -2_000_000 as Paise,
        recurrence: "monthly", nextDue: "2026-10-05" as IsoDate,
      }),
      (e: unknown) => e instanceof Refusal && !POSTS_ITSELF.test(e.message) && /mark .*paid/.test(e.message),
    );
  });
});
