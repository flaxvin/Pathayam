/**
 * 0048 backfills a month-based schedule's anchor day; 0049 re-files split
 * schedules whose lines no longer add up to the amount (which left them unable
 * to post). Same approach as the other data-fix tests: today's code builds the
 * rows, SQL bends them into the old shape, and only these migrations replay.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, queryOne, migrate, type DB } from "./db.ts";
import { MIGRATIONS } from "./schema.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createSchedule, setScheduleSplits, getScheduleSplits, markPaid } from "../domain/schedules.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { IsoDate } from "../core/dates.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

function setup() {
  const db: DB = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const bank = createAccount(db, actor, { name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(500_000) }).id;
  const g = createGroup(db, actor, "Home");
  const rent = createCategory(db, actor, { groupId: g.id, name: "Rent" }).id;
  const upkeep = createCategory(db, actor, { groupId: g.id, name: "Upkeep" }).id;
  return { db, bank, rent, upkeep };
}

describe("0048 · the anchor day is backfilled", () => {
  test("from next_due, for month-based schedules only", () => {
    const { db, bank, rent } = setup();
    const monthly = createSchedule(db, actor, { name: "Rent", accountId: bank, categoryId: rent,
      amount: -rupees(100) as Paise, recurrence: "monthly", nextDue: "2026-10-31" as IsoDate }).id;
    const weekly = createSchedule(db, actor, { name: "Help", accountId: bank, categoryId: rent,
      amount: -rupees(100) as Paise, recurrence: "weekly", nextDue: "2026-10-05" as IsoDate }).id;
    // As a database from before 0048 would be: no column at all.
    db.exec("ALTER TABLE schedules DROP COLUMN recurrence_day");
    db.exec("PRAGMA user_version = 47");
    migrate(db, false, 48);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    const day = (id: string) => queryOne<{ d: number | null }>(db, `SELECT recurrence_day AS d FROM schedules WHERE id = ?`, id)!.d;
    assert.equal(day(monthly), 31);
    assert.equal(day(weekly), null, "a weekly schedule has no day of the month");
  });
});

describe("0049 · stranded split lines are re-filed", () => {
  test("the first line takes the remainder, and the schedule can be paid again", () => {
    const { db, bank, rent, upkeep } = setup();
    const id = createSchedule(db, actor, { name: "Flat", accountId: bank, categoryId: rent,
      amount: -rupees(32_000) as Paise, recurrence: "monthly", nextDue: "2026-10-05" as IsoDate }).id;
    setScheduleSplits(db, actor, id, [
      { categoryId: rent, amount: -rupees(30_000) as Paise },
      { categoryId: upkeep, amount: -rupees(2_000) as Paise },
    ]);
    // What the old amount change did: new amount, old lines.
    execute(db, `UPDATE schedules SET amount = ? WHERE id = ?`, -rupees(35_000), id);
    assert.throws(() => markPaid(db, actor, id, "2026-10-05" as IsoDate), "the fixture is not stuck");

    db.exec("PRAGMA user_version = 48");
    migrate(db, false, 49);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);

    assert.deepEqual(getScheduleSplits(db, id).map((l) => [l.category_id, l.amount]),
      [[rent, -rupees(33_000)], [upkeep, -rupees(2_000)]]);
    markPaid(db, actor, id, "2026-10-05" as IsoDate);
  });
});
