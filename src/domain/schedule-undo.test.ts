/**
 * Undoing what the schedule buttons did, from the activity log.
 *
 * "Mark paid" and "Skip" record only the due date they moved, and the undo
 * handler read that `{ nextDue }` as a whole schedule: NULL into its name, a
 * 500 on an Undo the activity page kept offering, and the posted rent stayed.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createSchedule, getSchedule, markPaid, skipOccurrence } from "./schedules.ts";
import { updateTransaction } from "./transactions.ts";
import { undoEvent } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";
import { queryOne, type DB } from "../db/db.ts";
import type { IsoDate } from "../core/dates.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const bank = createAccount(db, actor, { name: "ZZ Bank", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(100_000) }).id;
  const g = createGroup(db, actor, "Home");
  const rent = createCategory(db, actor, { groupId: g.id, name: "Rent" }).id;
  const s = createSchedule(db, actor, { name: "Rent", accountId: bank, categoryId: rent,
    amount: -rupees(25_000) as Paise, recurrence: "monthly", nextDue: "2026-09-05" as IsoDate });
  return { db, id: s.id };
}

const lastEvent = (db: DB, action: string) => queryOne<{ id: string }>(db,
  `SELECT id FROM events WHERE entity = 'schedule' AND action = ? ORDER BY seq DESC LIMIT 1`, action)!.id;
const live = (db: DB) => queryOne<{ n: number }>(db,
  `SELECT COUNT(*) AS n FROM transactions WHERE deleted_at IS NULL`)!.n;

describe("IMPORTS-SCHEDULES-9 · undoing Mark paid and Skip", () => {
  test("undoing Mark paid removes the payment and puts the due date back", () => {
    const { db, id } = setup();
    markPaid(db, actor, id, "2026-09-05" as IsoDate);
    assert.equal(getSchedule(db, id)!.next_due, "2026-10-05");
    assert.equal(live(db), 1);

    const r = undoEvent(db, lastEvent(db, "mark-paid"), actor);
    assert.equal(r.ok, true);
    assert.equal(getSchedule(db, id)!.name, "Rent");
    assert.equal(getSchedule(db, id)!.next_due, "2026-09-05");
    assert.equal(live(db), 0, "the ₹25,000 it recorded is gone");
  });

  test("undoing Skip puts the occurrence back", () => {
    const { db, id } = setup();
    skipOccurrence(db, actor, id);
    const r = undoEvent(db, lastEvent(db, "skip"), actor);
    assert.equal(r.ok, true);
    assert.equal(getSchedule(db, id)!.next_due, "2026-09-05");
  });

  test("a payment edited since is not thrown away", () => {
    const { db, id } = setup();
    markPaid(db, actor, id, "2026-09-05" as IsoDate);
    const tx = queryOne<{ id: string }>(db, `SELECT id FROM transactions`)!.id;
    updateTransaction(db, actor, tx, { memo: "paid by cheque" });
    assert.throws(() => undoEvent(db, lastEvent(db, "mark-paid"), actor), /changed since/);
    assert.equal(getSchedule(db, id)!.next_due, "2026-10-05", "nothing half-undone");
    assert.equal(live(db), 1);
  });
});
