/**
 * An id in a form body is a suggestion, exactly like an id in a URL.
 *
 * `member-privacy.test.ts` aims every id-addressed *route* at another member's
 * private things. This file is the other half: ids that arrive in a form
 * field — a budget to file an account into, a group to add an envelope to, a
 * payee to merge, a rule to confirm, a member to name as holder. Each of these
 * was taken as given. Another member's private one was written to (answering
 * 303, which confirms it is real), and a made-up one reached the database,
 * failed a foreign key and answered 500, recorded as a fault.
 *
 * Every refusal here is the same 404 for a private id and a made-up one, and
 * no route may 500.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";
import { queryOne, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, addDays } from "../core/dates.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi: Actor = { memberId: RAVI, source: "ui" };
const priya: Actor = { memberId: PRIYA, source: "ui" };

interface World {
  db: DB;
  ids: {
    household: string; householdCategory: string;
    budget: string; account: string; group: string; category: string;
    hisPayee: string; herPayee: string;
  };
}

/** Ravi's personal budget with a private account, envelope and payee in it. */
function build(): World {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, PRIYA, "Priya");
  const today = todayIST();

  const household = createAccount(db, ravi, {
    name: "Joint current", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(50_000) as Paise,
  });
  const everyday = createGroup(db, ravi, "Everyday");
  const groceries = createCategory(db, ravi, { groupId: everyday.id, name: "Groceries" });

  const his = ensurePersonalBudget(db, RAVI, "Ravi");
  const account = createAccount(db, ravi, {
    name: "Zzyzx Private Account", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(3_00_000) as Paise,
    holderMemberId: RAVI, visibility: "private", budgetId: his.id,
  });
  const group = createGroup(db, ravi, "Mine", "normal", his.id);
  const category = createCategory(db, ravi, { groupId: group.id, name: "Qwertyuiop Envelope" });
  const hisTx = createTransaction(db, ravi, {
    accountId: account.id, amount: -rupees(999) as Paise, date: addDays(today, -3),
    categoryId: category.id, payeeName: "Grimalkin Therapy Clinic", cleared: true,
    ownerMemberId: RAVI,
  });
  const herTx = createTransaction(db, priya, {
    accountId: household.id, amount: -rupees(250) as Paise, date: addDays(today, -2),
    categoryId: groceries.id, payeeName: "Corner Store", cleared: true,
  });

  return {
    db,
    ids: {
      household: household.id, householdCategory: groceries.id,
      budget: his.id, account: account.id, group: group.id, category: category.id,
      hisPayee: hisTx.payee_id!, herPayee: herTx.payee_id!,
    },
  };
}

/** As Priya, against a fresh world; no route may 500. */
async function asPriya(fn: (app: TestApp, w: World) => Promise<void>): Promise<void> {
  const w = build();
  const app = await startTestApp(w.db, { memberId: PRIYA });
  try {
    await fn(app, w);
    assert.deepEqual(app.failures, [], "a route 500ed");
  } finally {
    await app.close();
  }
}

describe("ids posted in form fields", () => {
  test("SECURITY-OPS-4 · an account is filed only into a budget this member can see", () =>
    asPriya(async (app, w) => {
      for (const budget of [w.ids.budget, "no-such-budget"]) {
        const res = await app.post("/accounts/new", {
          name: "Planted", subtype: "budget:savings", opening_balance: "12345", budget_id: budget,
        });
        assert.equal(res.status, 404, `budget_id=${budget}`);
      }
      assert.equal(queryOne(w.db, `SELECT 1 FROM accounts WHERE name = 'Planted'`), null);

      for (const budget of [w.ids.budget, "no-such-budget"]) {
        const res = await app.post(`/accounts/${w.ids.household}/edit`, {
          name: "Joint current", budget_id: budget,
        });
        assert.equal(res.status, 404, `edit budget_id=${budget}`);
      }
      assert.notEqual(
        queryOne<{ budget_id: string | null }>(
          w.db, `SELECT budget_id FROM accounts WHERE id = ?`, w.ids.household,
        )!.budget_id,
        w.ids.budget,
      );

      // Her own choices still work.
      const ok = await app.post("/accounts/new", {
        name: "Hers", subtype: "budget:savings", opening_balance: "100",
      });
      assert.equal(ok.status, 303);
    }));

  test("SECURITY-OPS-7 · a payee merge takes only payees this member can see", () =>
    asPriya(async (app, w) => {
      for (const [loser, winner] of [
        [w.ids.herPayee, w.ids.hisPayee],
        [w.ids.hisPayee, w.ids.herPayee],
        [w.ids.herPayee, "no-such-payee"],
        ["no-such-payee", w.ids.herPayee],
      ]) {
        const res = await app.post("/payees/merge", { loser_id: loser, winner_id: winner });
        assert.equal(res.status, 404, `${loser} → ${winner}`);
        assert.doesNotMatch(await res.text(), /Grimalkin/);
      }
      // Nothing moved in either direction.
      assert.equal(
        queryOne<{ n: number }>(
          w.db, `SELECT COUNT(*) AS n FROM transactions WHERE payee_id = ?`, w.ids.hisPayee,
        )!.n,
        1,
      );
      assert.equal(
        queryOne(w.db, `SELECT 1 FROM payees WHERE merged_into_id IS NOT NULL`), null,
      );
    }));

  test("SECURITY-OPS-6 / BUDGET-7 · an envelope is added only to a group this member can see", () =>
    asPriya(async (app, w) => {
      for (const group of [w.ids.group, "no-such-group"]) {
        const res = await app.post("/categories/new", { group_id: group, name: "Planted" });
        assert.equal(res.status, 404, `group_id=${group}`);
      }
      // The app's own groups are not offered by the form, and not taken from it.
      const cards = createGroup(w.db, priya, "Kept by the app", "internal");
      assert.equal((await app.post("/categories/new", { group_id: cards.id, name: "Planted" })).status, 422);
      assert.equal(queryOne(w.db, `SELECT 1 FROM categories WHERE name = 'Planted'`), null);

      const household = queryOne<{ group_id: string }>(
        w.db, `SELECT group_id FROM categories WHERE id = ?`, w.ids.householdCategory,
      )!.group_id;
      assert.equal((await app.post("/categories/new", { group_id: household, name: "Hers" })).status, 303);
    }));

  test("SECURITY-OPS-8 · a proposed rule is confirmed or dismissed only if this member can see it", () =>
    asPriya(async (app, w) => {
      const propose = (id: string, categoryId: string) => execute(
        w.db,
        `INSERT INTO rules (id,name,stage,conditions_json,actions_json,enabled,proposed,created_at)
           VALUES (?,?,'default',?,?,1,1,?)`,
        id, `Proposal ${id}`,
        JSON.stringify([{ field: "payee", op: "contains", value: "CLINIC" }]),
        JSON.stringify([{ type: "setCategory", categoryId }]),
        "2025-01-01T00:00:00+05:30",
      );
      propose("rule-his", w.ids.category);
      propose("rule-hers", w.ids.householdCategory);
      const events = () => queryOne<{ n: number }>(w.db, `SELECT COUNT(*) AS n FROM events`)!.n;
      const before = events();

      for (const path of ["/rules/confirm", "/rules/dismiss"]) {
        for (const id of ["rule-his", "no-such-rule"]) {
          assert.equal((await app.post(path, { rule_id: id })).status, 404, `${path} ${id}`);
        }
      }
      assert.deepEqual(
        { ...queryOne(w.db, `SELECT proposed, dismissed_at FROM rules WHERE id = 'rule-his'`) },
        { proposed: 1, dismissed_at: null },
      );
      assert.equal(events(), before, "no event for a refused confirm or dismiss");

      assert.equal((await app.post("/rules/confirm", { rule_id: "rule-hers" })).status, 303);
      assert.equal(
        queryOne<{ proposed: number }>(w.db, `SELECT proposed FROM rules WHERE id = 'rule-hers'`)!.proposed, 0,
      );
    }));
});
