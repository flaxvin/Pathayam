/**
 * 0054 · a closed month's stored income and spending are its own budget's.
 *
 * Before BUDGET-25 the close read every budget's transactions, so the
 * household's row carried Priya's private salary and spending, and hers carried
 * the household's.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, queryAll, migrate } from "./db.ts";
import { MIGRATIONS } from "./schema.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { IsoDate } from "../core/dates.ts";

const ravi = { memberId: "m-ravi", source: "ui" as const };
const priya = { memberId: "m-priya", source: "ui" as const };

describe("0054 · month closes record their own budget", () => {
  test("the household's close loses Priya's money, and hers gains only hers", () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    seedMember(db, "m-priya", "Priya");
    const joint = createAccount(db, ravi, { name: "Joint", kind: "budget", subtype: "savings",
      openingDate: "2026-07-01", openingBalance: rupees(1_000) }).id;
    const g = createGroup(db, ravi, "Home");
    const food = createCategory(db, ravi, { groupId: g.id, name: "Food" }).id;
    createTransaction(db, ravi, { accountId: joint, amount: -rupees(500) as Paise,
      date: "2026-08-05" as IsoDate, categoryId: food });
    const hers = ensurePersonalBudget(db, "m-priya", "Priya").id;
    const secret = createAccount(db, priya, { name: "Mine", kind: "budget", subtype: "savings",
      openingDate: "2026-07-01", openingBalance: 0, budgetId: hers,
      holderMemberId: "m-priya", visibility: "private" }).id;
    createTransaction(db, priya, { accountId: secret, amount: rupees(90_000) as Paise,
      date: "2026-08-02" as IsoDate });
    createTransaction(db, priya, { accountId: secret, amount: -rupees(25_000) as Paise,
      date: "2026-08-06" as IsoDate });
    // What the old close stored for both budgets: everybody's money.
    for (const budget of ["budget-household", hers]) {
      execute(db,
        `INSERT INTO month_closes (month, budget_id, closed_at, closed_by, income, spending, assigned)
         VALUES ('2026-08', ?, '2026-09-01T09:00:00.000+05:30', 'm-ravi', ?, ?, 0)`,
        budget, rupees(90_000), rupees(25_500));
    }

    db.exec("PRAGMA user_version = 53");
    migrate(db, false, 54);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);

    const rows = new Map(queryAll<{ budget_id: string; income: number; spending: number }>(
      db, `SELECT budget_id, income, spending FROM month_closes`).map((r) => [r.budget_id, r]));
    assert.deepEqual({ ...rows.get("budget-household") }, {
      budget_id: "budget-household", income: 0, spending: rupees(500) });
    assert.deepEqual({ ...rows.get(hers) }, {
      budget_id: hers, income: rupees(90_000), spending: rupees(25_000) });
  });
});
