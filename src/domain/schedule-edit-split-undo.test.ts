/**
 * IMPORTS-SCHEDULES-24 · Undoing an amount edit of a split schedule leaves
 * lines that add up.
 *
 * The edit form writes the amount (one /activity entry) and then the lines
 * (another). Undoing the lines entry put the old ₹25,000 / ₹5,000 back under
 * the new ₹32,000 amount; forcing the amount entry alone put ₹30,000 back over
 * ₹27,000 / ₹5,000. Either way every Mark paid after it was refused, since the
 * lines no longer made up the amount.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { getSchedule, getScheduleSplits, listSchedules } from "./schedules.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

async function editedSplit() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const account = createAccount(db, actor, {
    name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 10_000_000,
  }).id;
  const g = createGroup(db, actor, "ZZ Home");
  const rent = createCategory(db, actor, { groupId: g.id, name: "ZZ Rent" }).id;
  const upkeep = createCategory(db, actor, { groupId: g.id, name: "ZZ Upkeep" }).id;
  const app = await startTestApp(db, { memberId: "m-ravi" });
  const form = (amount: string) => ({
    name: "ZZ Flat", amount, direction: "out", recurrence: "monthly", next_due: "2026-10-05",
    account_id: account, split_category_0: rent, split_amount_0: "", split_category_1: upkeep, split_amount_1: "5000",
  });
  await app.post("/schedules/new", form("30000"));
  const id = listSchedules(db)[0]!.id;
  assert.equal((await app.post(`/schedules/${id}/edit`, form("32000"))).status, 303);
  const state = () => ({
    amount: getSchedule(db, id)!.amount,
    lines: getScheduleSplits(db, id).map((l) => l.amount),
  });
  assert.deepEqual(state(), { amount: -3_200_000, lines: [-2_700_000, -500_000] });
  return { db, app, id, state };
}

const eventId = (db: DB, action: string) => queryOne<{ id: string }>(db,
  `SELECT id FROM events WHERE entity = 'schedule' AND action = ? ORDER BY seq DESC LIMIT 1`, action)!.id;

describe("IMPORTS-SCHEDULES-24 · a split schedule's edit, undone", () => {
  test("undoing the lines puts back the amount they added up to", async () => {
    const { db, app, id, state } = await editedSplit();
    try {
      assert.equal((await app.post(`/activity/${eventId(db, "split")}/undo`, {})).status, 303);
      assert.deepEqual(state(), { amount: -3_000_000, lines: [-2_500_000, -500_000] });
      assert.equal((await app.post(`/schedules/${id}/paid`, {})).status, 303);
    } finally {
      await app.close();
    }
  });

  test("forcing the amount back alone is refused, and nothing changes", async () => {
    const { db, app, id, state } = await editedSplit();
    try {
      const res = await app.post(`/activity/${eventId(db, "update")}/undo`, { force: "1" });
      assert.equal(res.status, 422);
      assert.match(await res.text(), /Undo the newer change to its lines first/);
      assert.deepEqual(state(), { amount: -3_200_000, lines: [-2_700_000, -500_000] });
      assert.equal((await app.post(`/schedules/${id}/paid`, {})).status, 303);
    } finally {
      await app.close();
    }
  });
});
