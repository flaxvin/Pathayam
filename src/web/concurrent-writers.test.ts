/**
 * N7 · Two people editing the same month at once.
 *
 * Everything else in this suite runs single-threaded: one call, then the next,
 * in the order somebody wrote them. The app is used by a household, which means
 * Ravi is on the budget screen while Priya is filing from her phone, both
 * looking at August, both about to press a button computed from what they saw a
 * minute ago. That state is reachable every evening and nothing tested it.
 *
 * What is actually at risk is not the database — SQLite serialises writes and
 * the app takes them through one handle. It is the arithmetic on either side of
 * the write:
 *
 * - **A lost update.** Two assignments to one envelope in one month, and the
 *   result has to be one of them, not a mixture and not a sum.
 * - **The rollup.** A month's cache is invalidated by a trigger on write. A
 *   burst of interleaved writes is exactly when a cache goes stale silently,
 *   and a rollup that disagrees with the ledger is a rollup that will one day be
 *   the only thing anybody reads.
 * - **The identity.** Whatever order the writes land in, every rupee still has
 *   to be in exactly one place.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget, identityResidual } from "../engine/engine.ts";
import { queryOne, queryAll, type DB } from "../db/db.ts";
import { rupees, formatPaise, type Paise } from "../core/money.ts";
import { todayIST, monthOf } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi: Actor = { memberId: RAVI, source: "ui" };
const MONTH = monthOf(todayIST());

let db: DB;
let ravisApp: TestApp;
let priyasApp: TestApp;
let account: string;
let groceries: string;
let fuel: string;

before(async () => {
  db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, PRIYA, "Priya");

  account = createAccount(db, ravi, {
    name: "Joint current", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(5_00_000),
  }).id;
  const group = createGroup(db, ravi, "Everyday");
  groceries = createCategory(db, ravi, { groupId: group.id, name: "Groceries" }).id;
  fuel = createCategory(db, ravi, { groupId: group.id, name: "Fuel" }).id;

  // The same database, two people signed in, as it is in the house.
  ravisApp = await startTestApp(db, { memberId: RAVI });
  priyasApp = await startTestApp(db, { memberId: PRIYA });
});

after(async () => {
  await ravisApp.close();
  await priyasApp.close();
});

/** The identity, from the ledger rather than the cache. */
function residual(): Paise {
  const state = computeBudget(loadEngineInput(db, { through: MONTH, useRollup: false })).get(MONTH)!;
  return identityResidual(state);
}

function assignedTo(categoryId: string): Paise {
  return (queryOne<{ amount: number }>(
    db, `SELECT amount FROM assignments WHERE month = ? AND category_id = ?`, MONTH, categoryId,
  )?.amount ?? 0) as Paise;
}

describe("N7 · two members editing the same month at once", () => {
  test("two assignments to one envelope leave one of them, not a mixture", async () => {
    await Promise.all([
      ravisApp.post("/assign", { month: MONTH, category_id: groceries, amount: "12000" }),
      priyasApp.post("/assign", { month: MONTH, category_id: groceries, amount: "9000" }),
    ]);

    const landed = assignedTo(groceries);
    assert.ok(
      landed === rupees(12_000) || landed === rupees(9_000),
      `the envelope holds ${formatPaise(landed)}, which is neither figure — the two ` +
      "writes were blended rather than one winning",
    );
    assert.equal(residual(), 0, "the identity broke under two writers");
  });

  test("a burst of filing from both phones loses nothing and duplicates nothing", async () => {
    const spends = Array.from({ length: 24 }, (_, i) => {
      const app = i % 2 === 0 ? ravisApp : priyasApp;
      return app.post("/add", {
        account_id: account,
        amount: `${100 + i}`,
        direction: "out",
        date: todayIST(),
        category_id: i % 3 === 0 ? fuel : groceries,
        payee: `Shop ${i}`,
        cleared: "1",
      });
    });
    await Promise.all(spends);

    const rows = queryAll<{ payee: string; n: number }>(
      db,
      `SELECT p.name AS payee, COUNT(*) AS n
         FROM transactions t JOIN payees p ON p.id = t.payee_id
        WHERE t.deleted_at IS NULL AND p.name LIKE 'Shop %'
        GROUP BY p.name`,
    );
    assert.equal(rows.length, 24, "some of the filing went missing");
    assert.deepEqual(
      rows.filter((r) => r.n !== 1), [],
      "a transaction was written twice, which is money counted twice",
    );
    assert.equal(residual(), 0, "the identity broke under a burst of writes");
  });

  test("the month's cache still agrees with its ledger afterwards", () => {
    /*
     * The rollup is invalidated by a trigger. Interleaved writes are exactly
     * when an invalidation is missed, and the failure is silent: every screen
     * reads the cache, so a stale one is simply believed.
     */
    const cold = computeBudget(loadEngineInput(db, { through: MONTH, useRollup: false })).get(MONTH)!;
    const cached = computeBudget(loadEngineInput(db, { through: MONTH, useRollup: true })).get(MONTH)!;

    assert.equal(formatPaise(cached.readyToAssign), formatPaise(cold.readyToAssign));
    for (const [id, state] of cold.categories) {
      assert.equal(
        formatPaise(cached.categories.get(id)?.balance ?? (0 as Paise)),
        formatPaise(state.balance),
        `the cache and the ledger disagree about ${id}`,
      );
    }
  });

  test("moving money out of one envelope twice at once cannot invent it", async () => {
    // Both see ₹12,000 in Groceries and both move "all of it" to Fuel. One of
    // them is acting on a figure that is no longer true, which is the ordinary
    // case, not the exotic one.
    const before = assignedTo(groceries);
    await Promise.all([
      ravisApp.post("/move", {
        month: MONTH, from_category_id: groceries, to_category_id: fuel, amount: "3000",
      }),
      priyasApp.post("/move", {
        month: MONTH, from_category_id: groceries, to_category_id: fuel, amount: "3000",
      }),
    ]);

    const moved = before - assignedTo(groceries);
    assert.equal(
      assignedTo(fuel), moved,
      "what left Groceries is not what arrived in Fuel",
    );
    assert.ok(
      moved === rupees(3_000) || moved === rupees(6_000),
      `₹${moved / 100} left Groceries, which is neither one move nor two`,
    );
    assert.equal(residual(), 0, "money was invented or lost between two envelopes");
    assert.deepEqual([...ravisApp.failures, ...priyasApp.failures], [], "a write 500ed");
  });
});
