/**
 * The startup repair for cross-budget card payments recorded before a transfer
 * opened its own claim.
 *
 * Paying the household's card from Ravi's own bank account is a claim Ravi now
 * holds on the household. The transfer used to record the two legs and nothing
 * else, so unless a commitment envelope already existed between the budgets,
 * both budgets' identities were out by the amount. createTransfer now opens the
 * envelope itself; payments made before that need it opened after the fact,
 * which SQL cannot do — hence code, run at startup, idempotent.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, queryOne } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { ensurePersonalBudget } from "./budgets.ts";
import { startPersonalBudget } from "./budget.ts";
import { createTransfer } from "./transactions.ts";
import { repairCrossBudgetClaims } from "./commitments.ts";
import { freshHousehold, identityProblems, RAVI } from "../engine/identity.test-data.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { IsoDate, MonthKey } from "../core/dates.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

describe("repairing claims that old cross-budget card payments never opened", () => {
  function oldShape() {
    const db = freshHousehold();
    const ravi = ensurePersonalBudget(db, RAVI, "Ravi").id;
    startPersonalBudget(db, actor, ravi);
    const hisBank = createAccount(db, actor, { name: "Ravi SB", kind: "budget", subtype: "savings",
      openingDate: "2026-08-01", openingBalance: rupees(50_000), budgetId: ravi, holderMemberId: RAVI }).id;
    const card = createAccount(db, actor, { name: "Household card", kind: "credit", subtype: "credit-card",
      openingDate: "2026-08-01", openingBalance: -rupees(5_000) as Paise, statementDay: 18, dueDay: 8 }).id;
    createTransfer(db, actor, { fromAccountId: hisBank, toAccountId: card,
      amount: rupees(2_000) as Paise, date: "2026-09-10" as IsoDate });
    // What the old code left: the payment, and no envelope carrying the claim.
    execute(db, `DELETE FROM assignments WHERE category_id IN (SELECT id FROM categories WHERE commits_to_budget_id IS NOT NULL)`);
    execute(db, `DELETE FROM categories WHERE commits_to_budget_id IS NOT NULL`);
    execute(db, `DELETE FROM month_rollups`);
    execute(db, `DELETE FROM month_rollup_state`);
    return db;
  }

  test("opens the missing envelope, and the identity holds in every budget again", () => {
    const db = oldShape();
    assert.notDeepEqual(identityProblems(db, "2026-12" as MonthKey), [], "the fixture is not the broken shape");
    const result = repairCrossBudgetClaims(db);
    assert.equal(result.opened, 1);
    assert.deepEqual(result.unresolved, []);
    assert.deepEqual(identityProblems(db, "2026-12" as MonthKey), []);
  });

  test("is a no-op the second time", () => {
    const db = oldShape();
    repairCrossBudgetClaims(db);
    const envelopes = () => queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM categories WHERE commits_to_budget_id IS NOT NULL`)!.n;
    const before = envelopes();
    assert.deepEqual(repairCrossBudgetClaims(db), { opened: 0, unresolved: [] });
    assert.equal(envelopes(), before, "a second run opened another envelope");
  });
});
