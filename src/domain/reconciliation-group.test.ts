/**
 * ENG-13 · The Reconciliation envelope gets its own group.
 *
 * It was put in the budget's first internal group, and the goals and the
 * household commitment are internal groups too: in a household that had made a
 * goal first, "Reconciliation" sat among the goals, under "Goals". It now goes
 * in an "Internal" group of its own, made if missing, never a goal's or the
 * commitment's.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup } from "./budget.ts";
import { reconcile } from "./reconciliation.ts";
import { GOAL_GROUP } from "./goals.ts";

const actor: Actor = { memberId: "m", source: "ui" };

test("an adjustment's envelope is not filed among the goals", () => {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  createGroup(db, actor, GOAL_GROUP, "internal");
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(10_000),
  }).id;
  const r = reconcile(db, actor, {
    accountId: bank, bankBalance: rupees(10_250), asOf: "2026-02-01", allowAdjustment: true,
  });
  assert.equal(r.status, "reconciled");
  const group = queryOne<{ name: string; kind: string }>(
    db,
    `SELECT g.name, g.kind FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE c.name = 'Reconciliation'`,
  )!;
  assert.equal(group.name, "Internal");
});
