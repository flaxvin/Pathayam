/**
 * 0047 · An envelope back in a group of its own budget — and, from the same
 * privacy review, a session that only its owner can sign out.
 *
 * Deleting a personal goal used to move its envelope into a "Savings" group in
 * the *household* budget, while the envelope kept its own budget_id. Everyone
 * else then saw it on their budget and categories screens. The fix stops new
 * cases; this migration repairs the ones already stored.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, queryOne, migrate, type DB } from "./db.ts";
import { freshDb, seedMember, startTestApp, testConfig } from "../web/harness.test-data.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createSession } from "../auth/sessions.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

describe("0047 · a stranded envelope goes home", () => {
  test("an envelope of Ravi's budget sitting in a household group moves to a group of his", () => {
    const db: DB = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const his = ensurePersonalBudget(db, "m-ravi", "Ravi");
    const household = createGroup(db, actor, "Savings").id; // household budget
    const cat = createCategory(db, actor, { groupId: household, name: "Jabberwock goal" }).id;
    // What the old goal delete left behind: his envelope, the household's group.
    execute(db, `UPDATE categories SET budget_id = ? WHERE id = ?`, his.id, cat);

    db.exec("PRAGMA user_version = 46");
    migrate(db, false);

    const row = queryOne<{ cat_budget: string; group_budget: string; group_name: string }>(db,
      `SELECT c.budget_id AS cat_budget, g.budget_id AS group_budget, g.name AS group_name
         FROM categories c JOIN category_groups g ON g.id = c.group_id WHERE c.id = ?`, cat)!;
    assert.equal(row.group_budget, his.id, "the envelope is still in another budget's group");
    assert.equal(row.cat_budget, his.id);
    assert.equal(row.group_name, "Savings");
  });

  test("an envelope already where it belongs is not touched", () => {
    const db: DB = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const g = createGroup(db, actor, "Home").id;
    const cat = createCategory(db, actor, { groupId: g, name: "Rent" }).id;
    db.exec("PRAGMA user_version = 46");
    migrate(db, false);
    assert.equal(queryOne<{ group_id: string }>(db, `SELECT group_id FROM categories WHERE id = ?`, cat)!.group_id, g);
  });
});

describe("a session is signed out only by its owner", () => {
  test("another member's session id answers like one that does not exist", async () => {
    const db: DB = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    seedMember(db, "m-priya", "Priya");
    const { session } = createSession(db, "m-ravi", { days: 30 });
    const app = await startTestApp(db, { memberId: "m-priya", config: testConfig({}) });
    try {
      const res = await app.post("/sessions/revoke", { session_id: session.id });
      assert.equal(res.status, 404, `Priya signed Ravi out (${res.status})`);
      assert.equal(queryOne<{ revoked_at: string | null }>(db,
        `SELECT revoked_at FROM sessions WHERE id = ?`, session.id)!.revoked_at, null);
    } finally { await app.close(); }
  });
});
