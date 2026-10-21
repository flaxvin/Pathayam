/**
 * Undoing a schedule's split change puts back lines that name envelopes. One
 * merged or deleted since is nowhere to put a line: the undo restored it anyway,
 * so the schedule's next Mark paid was refused ("B" has been deleted), and where
 * the envelope's row was gone altogether the undo itself failed on the foreign
 * key — a 500. Refused instead, by name, as an assignment's undo is.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { todayIST, addDays } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import { undoEvent } from "../core/events.ts";
import { queryOne } from "../db/db.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, deleteCategory, mergeCategories } from "./budget.ts";
import { householdBudgetId } from "./budgets.ts";
import { createSchedule, setScheduleSplits, getScheduleSplits } from "./schedules.ts";
import { freshHousehold, PRIYA } from "../engine/identity.test-data.ts";

const actor = { memberId: PRIYA, source: "ui" as const };

function world() {
  const db = freshHousehold();
  const hh = householdBudgetId(db);
  const bank = createAccount(db, actor, {
    name: "Joint", kind: "budget", subtype: "savings", budgetId: hh,
    openingBalance: rupees(50_000), openingDate: addDays(todayIST(), -10),
  });
  const g = createGroup(db, actor, "Shared", "normal", hh);
  const [a, b, c] = ["Rent", "Upkeep", "Repairs"].map((name) => createCategory(db, actor, { groupId: g.id, name }).id);
  const s = createSchedule(db, actor, {
    name: "Flat", accountId: bank.id, categoryId: a!, amount: -rupees(1_000),
    recurrence: "monthly", nextDue: todayIST(),
  });
  setScheduleSplits(db, actor, s.id, [{ categoryId: a!, amount: -rupees(400) }, { categoryId: b!, amount: -rupees(600) }]);
  setScheduleSplits(db, actor, s.id, [{ categoryId: a!, amount: -rupees(400) }, { categoryId: c!, amount: -rupees(600) }]);
  const ev = queryOne<{ id: string }>(
    db, `SELECT id FROM events WHERE entity = 'schedule' AND action = 'split' ORDER BY seq DESC LIMIT 1`,
  )!.id;
  return { db, a: a!, b: b!, c: c!, s: s.id, ev };
}

for (const how of ["merged", "deleted"] as const) {
  test(`undoing a split change refuses to put back a line on an envelope ${how} since`, () => {
    const w = world();
    if (how === "merged") mergeCategories(w.db, actor, w.b, w.a);
    else deleteCategory(w.db, actor, w.b, { remapTo: w.a, currentBalance: 0 });

    assert.throws(() => undoEvent(w.db, w.ev, actor, { force: true }), (e: unknown) =>
      e instanceof Refusal && /Upkeep/.test((e as Error).message));
    // Nothing changed: the schedule still splits across Rent and Repairs.
    assert.deepEqual(getScheduleSplits(w.db, w.s).map((l) => l.category_id).sort(), [w.a, w.c].sort());
    w.db.close();
  });
}

test("a line whose envelope row is gone altogether is refused, not a foreign-key failure", () => {
  const w = world();
  // The state a removed category leaves behind: no row at all.
  w.db.exec("PRAGMA foreign_keys = OFF");
  w.db.prepare(`DELETE FROM categories WHERE id = ?`).run(w.b);
  w.db.exec("PRAGMA foreign_keys = ON");
  assert.throws(() => undoEvent(w.db, w.ev, actor, { force: true }), Refusal);
  w.db.close();
});
