/**
 * B74 · The month rollup, and the only question that matters about a cache:
 * does it ever disagree with the thing it summarises?
 *
 * The budget is derived from the whole ledger every time, which is what makes
 * R7.g possible — edit any past month and every figure since re-derives, with
 * no stored total to go stale. The cost was that opening the budget scanned
 * every transaction the household had ever made.
 *
 * Months older than six are now summarised once and read back. That is a cache,
 * and this file exists because a cache that can silently disagree with the
 * ledger would be a far worse bug than the slowness it fixes. So every test
 * here computes the same figures twice — once from the rollup, once from a
 * ledger with the rollup thrown away — and demands they match.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryAll, type DB } from "../db/db.ts";
import { nowIST, addMonths, monthOf, todayIST, type MonthKey } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned } from "../domain/budget.ts";
import { createTransaction, updateTransaction, deleteTransaction } from "../domain/transactions.ts";
import { loadEngineInput, accountBalances, ROLLUP_SEAL_AFTER_MONTHS } from "./repository.ts";
import { computeBudget } from "./engine.ts";

const actor: Actor = { memberId: "m", source: "ui" };

/** Four years back to today, so plenty of months are old enough to seal. */
function household(months = 48) {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());

  const now = monthOf(todayIST());
  const first = addMonths(now, -(months - 1));
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: `${first}-01` as never, openingBalance: rupees(200000),
  }).id;
  const card = createAccount(db, actor, {
    name: "Atlas", kind: "credit", subtype: "credit-card",
    openingDate: `${first}-01` as never, openingBalance: 0,
  }).id;

  const group = createGroup(db, actor, "Flexible");
  const cats = ["Groceries", "Fuel", "Eating out"].map(
    (n) => createCategory(db, actor, { groupId: group.id, name: n }).id,
  );

  for (let k = 0; k < months; k++) {
    const month = addMonths(first, k);
    for (const c of cats) setAssigned(db, actor, month, c, rupees(5000));
    createTransaction(db, actor, {
      accountId: bank, amount: rupees(80000), date: `${month}-01` as never, payeeName: "Salary",
    });
    for (let i = 0; i < 6; i++) {
      createTransaction(db, actor, {
        accountId: i % 2 === 0 ? bank : card,
        amount: -rupees(500 + i * 25),
        date: `${month}-${String(5 + i).padStart(2, "0")}` as never,
        categoryId: cats[i % cats.length],
        payeeName: `Shop ${i}`,
      });
    }
  }
  return { db, now, first, cats, bank, card };
}

/** Every figure the engine produces, flattened so two runs can be compared. */
function figures(db: DB, through: MonthKey): string {
  const budget = computeBudget(loadEngineInput(db, { through }));
  const months = [...budget.entries()].map(([month, state]) => ({
    month,
    rta: state.readyToAssign,
    categories: [...state.categories.entries()]
      .map(([id, c]) => `${id}:${c.assigned}:${c.activity}:${c.balance}`)
      .sort(),
  }));
  const balances = [...accountBalances(db).entries()]
    .map(([id, b]) => `${id}:${b.cleared}:${b.uncleared}:${b.working}`)
    .sort();
  return JSON.stringify({ months, balances });
}

function withoutRollup(db: DB, through: MonthKey): string {
  execute(db, `DELETE FROM month_rollups`);
  execute(db, `DELETE FROM month_rollup_state`);
  return figures(db, through);
}

describe("B74 · the rollup never disagrees with the ledger", () => {
  test("a warm read matches a cold one, figure for figure", () => {
    const { db, now } = household();
    const cold = withoutRollup(db, now);   // built during this call
    const warm = figures(db, now);         // served from what it built
    assert.equal(warm, cold);
    db.close();
  });

  test("it actually sealed something — otherwise this file proves nothing", () => {
    const { db, now } = household();
    figures(db, now);
    const sealed = queryAll<{ month: string }>(db, `SELECT month FROM month_rollup_state`);
    assert.ok(sealed.length > 0, "no month was sealed, so the cold and warm paths are identical");
    const cutoff = addMonths(monthOf(todayIST()), -ROLLUP_SEAL_AFTER_MONTHS);
    for (const row of sealed) {
      assert.ok(row.month <= cutoff, `${row.month} was sealed but is inside the live window`);
    }
    db.close();
  });

  test("editing a sealed month drops it, and the figures still match", () => {
    const { db, now, first } = household();
    figures(db, now);
    assert.ok(queryAll(db, `SELECT 1 FROM month_rollup_state WHERE month = ?`, first).length === 1);

    const old = queryAll<{ id: string }>(
      db, `SELECT id FROM transactions WHERE date LIKE ? AND category_id IS NOT NULL LIMIT 1`,
      `${first}%`,
    )[0]!;
    updateTransaction(db, actor, old.id, { amount: -rupees(99999) });

    assert.equal(
      queryAll(db, `SELECT 1 FROM month_rollup_state WHERE month = ?`, first).length, 0,
      "the trigger must drop the month it changed",
    );
    assert.equal(figures(db, now), withoutRollup(db, now));
    db.close();
  });

  test("deleting inside a sealed month drops it too", () => {
    const { db, now, first } = household();
    figures(db, now);
    const old = queryAll<{ id: string }>(
      db, `SELECT id FROM transactions WHERE date LIKE ? LIMIT 1`, `${first}%`,
    )[0]!;
    deleteTransaction(db, actor, old.id);
    assert.equal(figures(db, now), withoutRollup(db, now));
    db.close();
  });

  test("moving a transaction between months drops both", () => {
    const { db, now, first } = household();
    figures(db, now);
    const old = queryAll<{ id: string }>(
      db, `SELECT id FROM transactions WHERE date LIKE ? LIMIT 1`, `${first}%`,
    )[0]!;
    const second = addMonths(first, 1);
    updateTransaction(db, actor, old.id, { date: `${second}-15` as never });

    for (const month of [first, second]) {
      assert.equal(
        queryAll(db, `SELECT 1 FROM month_rollup_state WHERE month = ?`, month).length, 0,
        `${month} should have been dropped`,
      );
    }
    assert.equal(figures(db, now), withoutRollup(db, now));
    db.close();
  });

  test("adding an account rebuilds everything, because kind re-colours history", () => {
    const { db, now, first } = household();
    figures(db, now);
    createAccount(db, actor, {
      name: "Cash", kind: "budget", subtype: "cash",
      openingDate: `${first}-01` as never, openingBalance: rupees(5000),
    });
    assert.equal(queryAll(db, `SELECT 1 FROM month_rollup_state`).length, 0);
    assert.equal(figures(db, now), withoutRollup(db, now));
    db.close();
  });

  test("a past month reads the same whether or not later months are sealed", () => {
    const { db, now } = household();
    const past = addMonths(now, -12);
    const cold = withoutRollup(db, past);
    const warm = figures(db, past);
    assert.equal(warm, cold);
    db.close();
  });
});

describe("B74 · old history costs months, not rows", () => {
  test("quadrupling the transactions in sealed months does not slow the read", () => {
    // The claim the rollup exists to make. Kept deliberately loose — this
    // asserts a shape, not a machine.
    const measure = (perMonth: number) => {
      const db = openDatabase({ path: ":memory:", verbose: false });
      ensureHousehold(db);
      execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
        "m", "f@e.com", "F", nowIST());
      const now = monthOf(todayIST());
      const first = addMonths(now, -35);
      const acc = createAccount(db, actor, {
        name: "HDFC", kind: "budget", subtype: "savings",
        openingDate: `${first}-01` as never, openingBalance: rupees(200000),
      }).id;
      const group = createGroup(db, actor, "Flexible");
      const cat = createCategory(db, actor, { groupId: group.id, name: "Groceries" }).id;
      for (let k = 0; k < 36; k++) {
        const month = addMonths(first, k);
        setAssigned(db, actor, month, cat, rupees(5000));
        for (let i = 0; i < perMonth; i++) {
          createTransaction(db, actor, {
            accountId: acc, amount: -rupees(100),
            date: `${month}-${String((i % 28) + 1).padStart(2, "0")}` as never,
            categoryId: cat, payeeName: "Shop",
          });
        }
      }
      figures(db, now); // seal

      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const started = process.hrtime.bigint();
        figures(db, now);
        best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
      }
      db.close();
      return best;
    };

    const light = measure(10);
    const heavy = measure(40);

    // Four times the rows in the same months. Without the rollup this was
    // linear; with it the sealed months are a fixed number of summed rows.
    assert.ok(
      heavy < light * 2.5 + 20,
      `expected sealed history to be insensitive to row count, got ${light.toFixed(0)}ms vs ${heavy.toFixed(0)}ms`,
    );
  });
});
