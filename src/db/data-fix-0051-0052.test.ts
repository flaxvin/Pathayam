/**
 * 0051 · the rollup cache is dropped when an account moves budget.
 * 0052 · envelopes deleted with spending still filed to them come back hidden,
 *        which puts back the ₹1,000 of Ready to Assign that deleting invented.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, queryOne, migrate, type DB } from "./db.ts";
import { MIGRATIONS } from "./schema.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { computeBudget, identityResidual } from "../engine/engine.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { IsoDate, MonthKey } from "../core/dates.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

function residuals(db: DB): number[] {
  return [...computeBudget(loadEngineInput(db, { through: "2026-12" as MonthKey, useRollup: false })).values()]
    .map((state) => identityResidual(state)).filter((r) => r !== 0);
}

describe("0051 · a budget move drops the rollup cache", () => {
  test("the trigger fires on budget_id", () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const his = ensurePersonalBudget(db, "m-ravi", "Ravi").id;
    const acct = createAccount(db, actor, { name: "B", kind: "budget", subtype: "savings",
      openingDate: "2026-01-01", openingBalance: rupees(1_000) }).id;
    execute(db, `INSERT INTO month_rollup_state (month, built_at) VALUES ('2026-01', '2026-02-01T00:00:00.000+05:30')`);
    execute(db, `UPDATE accounts SET budget_id = ? WHERE id = ?`, his, acct);
    assert.equal(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM month_rollup_state`)!.n, 0,
      "moving an account to another budget left sealed months in place");
  });
});

describe("0052 · a deleted envelope with spending comes back hidden", () => {
  test("and Ready to Assign stops counting money that was spent", () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const bank = createAccount(db, actor, { name: "B", kind: "budget", subtype: "savings",
      openingDate: "2026-08-01", openingBalance: rupees(10_000) }).id;
    const g = createGroup(db, actor, "Home");
    const gift = createCategory(db, actor, { groupId: g.id, name: "Gifts" }).id;
    setAssigned(db, actor, "2026-09" as MonthKey, gift, rupees(1_000) as Paise);
    createTransaction(db, actor, { accountId: bank, amount: -rupees(1_000) as Paise,
      date: "2026-09-05" as IsoDate, categoryId: gift });
    // What the old delete did: assignments gone, the envelope soft-deleted,
    // the spending still filed to it.
    execute(db, `DELETE FROM assignments WHERE category_id = ?`, gift);
    execute(db, `UPDATE categories SET deleted_at = '2026-09-10T00:00:00.000+05:30' WHERE id = ?`, gift);
    assert.notDeepEqual(residuals(db), [], "the fixture is not the broken shape");

    db.exec("PRAGMA user_version = 51");
    migrate(db, false, 52);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);

    const row = queryOne<{ deleted_at: string | null; hidden_at: string | null }>(
      db, `SELECT deleted_at, hidden_at FROM categories WHERE id = ?`, gift)!;
    assert.equal(row.deleted_at, null);
    assert.notEqual(row.hidden_at, null, "it came back visible, not hidden");
    assert.deepEqual(residuals(db), [], "the identity is still out after the repair");
  });
});
