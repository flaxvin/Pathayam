/**
 * 15 · Budgets — the unit that owns money.
 *
 * One household budget always exists; personal budgets are created per member.
 * Everything that belongs to a budget — accounts that hold money, and the
 * envelopes that money is assigned to — defaults to the household one, so a
 * household that never uses the feature keeps exactly the app it had.
 */

import type { DB } from "../db/db.ts";
import { queryOne, queryAll, execute } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { newId } from "../db/db.ts";

export interface Budget {
  id: string;
  kind: "household" | "personal";
  member_id: string | null;
  name: string;
  created_at: string;
}

export const HOUSEHOLD_BUDGET_ID = "budget-household";

export function householdBudgetId(db: DB): string {
  const row = queryOne<{ id: string }>(db, `SELECT id FROM budgets WHERE kind = 'household'`);
  return row?.id ?? HOUSEHOLD_BUDGET_ID;
}

export function listBudgets(db: DB): Budget[] {
  return queryAll<Budget>(
    db,
    `SELECT * FROM budgets ORDER BY CASE kind WHEN 'household' THEN 0 ELSE 1 END, name`,
  );
}

export function getBudget(db: DB, id: string): Budget | null {
  return queryOne<Budget>(db, `SELECT * FROM budgets WHERE id = ?`, id);
}

/** The budgets a member may look at: the household's, and their own. */
export function budgetsFor(db: DB, memberId: string | null): Budget[] {
  return listBudgets(db).filter((b) => b.kind === "household" || b.member_id === memberId);
}

export function personalBudgetFor(db: DB, memberId: string): Budget | null {
  return queryOne<Budget>(db, `SELECT * FROM budgets WHERE member_id = ?`, memberId);
}

/** Idempotent: a member has at most one personal budget, enforced by an index. */
export function ensurePersonalBudget(db: DB, memberId: string, name: string): Budget {
  const existing = personalBudgetFor(db, memberId);
  if (existing) return existing;
  const id = newId();
  execute(
    db,
    `INSERT INTO budgets (id, kind, member_id, name, created_at) VALUES (?, 'personal', ?, ?, ?)`,
    id, memberId, name, nowIST(),
  );
  return getBudget(db, id)!;
}
