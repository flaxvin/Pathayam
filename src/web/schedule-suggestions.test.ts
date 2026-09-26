/**
 * The "Look like schedules" suggestions and what confirming one stores.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { detectSchedules, createSchedule } from "../domain/schedules.ts";
import { queryAll } from "../db/db.ts";
import { Refusal } from "../core/refusal.ts";
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

/*
 * IMPORTS-SCHEDULES-12 · /schedules/confirm took its hidden fields on trust:
 * "12.5" stored twelve and a half paise, "abc" a NULL amount, "" zero,
 * "2026-02-31" verbatim, and "someday" was a 500 from a CHECK constraint.
 */
describe("confirming a suggestion checks what it was sent", () => {
  test("bad amounts and dates are refused, and nothing is stored", async () => {
    const { db, account, category } = setup();
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const base = { name: "ZZ Junk", recurrence: "monthly", category_id: category, account_id: account };
      for (const amount of ["12.5", "abc", "-1e3", ""]) {
        const r = await app.post("/schedules/confirm", { ...base, amount, next_due: "2026-10-03" });
        assert.equal(r.status, 422, `amount ${JSON.stringify(amount)}`);
      }
      for (const next_due of ["someday", "2026-02-31"]) {
        const r = await app.post("/schedules/confirm", { ...base, amount: "-150000", next_due });
        assert.ok(r.status >= 400 && r.status < 500, `next_due ${next_due} answered ${r.status}`);
      }
      const r = await app.post("/schedules/confirm", { ...base, amount: "-150000", next_due: "2026-10-03", payee_id: "no-such-payee" });
      assert.equal(r.status, 422);
      assert.deepEqual(queryAll(db, `SELECT id FROM schedules`), []);
      assert.deepEqual(app.failures, []);

      const ok = await app.post("/schedules/confirm", { ...base, amount: "-150000", next_due: "2026-10-03" });
      assert.equal(ok.status, 303);
      assert.equal(queryAll(db, `SELECT id FROM schedules`).length, 1);
    } finally {
      await app.close();
    }
  });

  test("the domain refuses fractional paise and impossible dates too", () => {
    const { db, account, category } = setup();
    const base = { name: "ZZ", accountId: account, categoryId: category, recurrence: "monthly" as const };
    assert.throws(() => createSchedule(db, actor, { ...base, amount: 12.5 as Paise, nextDue: "2026-10-03" as IsoDate }), Refusal);
    assert.throws(() => createSchedule(db, actor, { ...base, amount: -100 as Paise, nextDue: "2026-02-31" as IsoDate }), Refusal);
  });
});
