/**
 * The accounting identity, checked the way an auditor would: in every scope
 * (all budgets at once, and each budget alone), in every month, derived live
 * from the ledger AND through the rollup — and the two must agree.
 *
 * Not a test file itself (the name keeps it out of the `*.test.ts` glob); the
 * engine-defect suites share it so each one asserts the same thing.
 */

import type { DB } from "../db/db.ts";
import { openDatabase, ensureHousehold, execute, queryAll } from "../db/db.ts";
import type { MonthKey } from "../core/dates.ts";
import { nowIST } from "../core/dates.ts";
import { loadEngineInput } from "./repository.ts";
import { computeBudget, identityResidual } from "./engine.ts";

export const RAVI = "m-ravi";
export const PRIYA = "m-priya";

/** A household with two members and nothing else. */
export function freshHousehold(): DB {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  for (const [id, name] of [[RAVI, "Ravi"], [PRIYA, "Priya"]] as const) {
    execute(
      db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
      id, `${name.toLowerCase()}@example.com`, name, nowIST(),
    );
  }
  return db;
}

/**
 * Every way the identity can be broken, as readable lines; empty when it holds.
 * `through` should reach past the latest dated row.
 */
export function identityProblems(db: DB, through: MonthKey): string[] {
  const scopes: (string | undefined)[] = [
    undefined,
    ...queryAll<{ id: string }>(db, `SELECT id FROM budgets`).map((r) => r.id),
  ];
  const out: string[] = [];
  for (const scope of scopes) {
    const name = scope ?? "all";
    const live = computeBudget(loadEngineInput(db, { through, budgetId: scope, useRollup: false }));
    const rolled = computeBudget(loadEngineInput(db, { through, budgetId: scope, useRollup: true }));
    for (const [month, state] of live) {
      const residual = identityResidual(state);
      if (residual !== 0) out.push(`${name} ${month} live residual ${residual}`);
      const other = rolled.get(month);
      if (!other) { out.push(`${name} ${month} missing from rollup`); continue; }
      const r2 = identityResidual(other);
      if (r2 !== 0) out.push(`${name} ${month} rollup residual ${r2}`);
      if (other.readyToAssign !== state.readyToAssign) {
        out.push(`${name} ${month} RTA live ${state.readyToAssign} rollup ${other.readyToAssign}`);
      }
    }
  }
  return out;
}

/** Ready to Assign for one budget and month, derived live. */
export function rtaOf(db: DB, month: MonthKey, budgetId?: string): number {
  return computeBudget(loadEngineInput(db, { through: month, budgetId, useRollup: false }))
    .get(month)!.readyToAssign;
}
