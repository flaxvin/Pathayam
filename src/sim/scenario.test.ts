/**
 * The top-down test.
 *
 * Every other test in this suite asks whether one function is right. This one
 * asks whether the whole thing still adds up after thirty-six months of a
 * household of four actually using it — including the two months where the
 * household changes shape, which is where the arithmetic is hardest and where
 * nothing else looks.
 *
 * What it checks, in the order that matters:
 *
 * 1. **The identity holds after every month, in every budget.** Not at the end:
 *    after each month as the history grows, so a break names the month it
 *    started in rather than the month you happened to look.
 * 2. **The cache agrees with the arithmetic.** Every month is computed twice,
 *    once from the rollup and once from the ledger, and the two must match. A
 *    rollup that disagrees with a cold compute is a rollup that will one day be
 *    the only thing anybody reads.
 * 3. **Everything got exercised.** Every mutating function the domain exports is
 *    called by the scenario, checked against the source rather than a list
 *    somebody maintains by hand. A new domain mutation that nothing simulates
 *    fails this test on the day it is written, which is the point.
 * 4. **Removing a member is a state, not a deletion** (F1.6): their name stays
 *    on everything they entered, and adding them back finds them again.
 *
 * `scenario.ts` holds the household. This holds the questions.
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openDatabase, ensureHousehold, queryOne, queryAll, type DB } from "../db/db.ts";
import { formatPaise } from "../core/money.ts";
import type { MonthKey } from "../core/dates.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget, identityResidual } from "../engine/engine.ts";
import { listBudgets } from "../domain/budgets.ts";
import { listMembers } from "../auth/sessions.ts";
import { netWorthStatement } from "../domain/networth.ts";
import {
  simulateHousehold, DEPARTURE_AT, RETURN_AT, SIGNED_IN_AS, type SimResult,
} from "./scenario.ts";

const here = dirname(fileURLToPath(import.meta.url));

let db: DB;
let sim: SimResult;
/** Months whose identity did not close, collected as the history was built. */
const brokeDuringBuild: string[] = [];

before(() => {
  db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  sim = simulateHousehold(db, {
    afterMonth: (month) => {
      // Only the month just built, because re-deriving all of history after
      // every month is quadratic and the full sweep below covers the rest.
      for (const budget of listBudgets(db)) {
        const state = computeBudget(
          loadEngineInput(db, { through: month, budgetId: budget.id }),
        ).get(month);
        if (state && identityResidual(state) !== 0) {
          brokeDuringBuild.push(
            `${month} · ${budget.name} · off by ${formatPaise(identityResidual(state))}`,
          );
        }
      }
    },
  });
});

describe("top-down · thirty-six months of a household of four", () => {
  test("the identity closed after every month it was built in", () => {
    assert.deepEqual(
      brokeDuringBuild.slice(0, 8), [],
      "a month's books did not balance at the moment it was written",
    );
  });

  test("and still closes now, in every month of every budget", () => {
    const broken: string[] = [];
    for (const budget of listBudgets(db)) {
      const states = computeBudget(
        loadEngineInput(db, { through: sim.months.at(-1)!, budgetId: budget.id }),
      );
      for (const [month, state] of states) {
        const residual = identityResidual(state);
        if (residual !== 0) broken.push(`${month} · ${budget.name} · ${formatPaise(residual)}`);
      }
    }
    assert.deepEqual(broken.slice(0, 8), []);
  });

  test("the rollup cache agrees with the ledger, month for month", () => {
    const disagreements: string[] = [];
    for (const budget of listBudgets(db)) {
      const through = sim.months.at(-1)!;
      const warm = computeBudget(loadEngineInput(db, { through, budgetId: budget.id, useRollup: true }));
      const cold = computeBudget(loadEngineInput(db, { through, budgetId: budget.id, useRollup: false }));
      for (const [month, hot] of warm) {
        const raw = cold.get(month);
        if (!raw) { disagreements.push(`${month} missing from the cold compute`); continue; }
        if (hot.readyToAssign !== raw.readyToAssign) {
          disagreements.push(
            `${month} · ${budget.name} · RTA ${formatPaise(hot.readyToAssign)} cached, ` +
            `${formatPaise(raw.readyToAssign)} derived`,
          );
        }
      }
    }
    assert.deepEqual(disagreements.slice(0, 8), []);
  });
});

describe("top-down · the household changes shape", () => {
  test("four to begin with, two after the departures, three after the return", () => {
    assert.equal(listMembers(db).length, 3, "Ravi, Priya and Anil are here at the end");
    assert.equal(
      listMembers(db, { includeRemoved: true }).length, 4,
      "and Meera is still on the books, because removal is a state (F1.6)",
    );
  });

  test("what a departed member entered keeps their name", () => {
    const meera = sim.members.meera.id;
    const theirs = queryOne<{ n: number }>(
      db, `SELECT COUNT(*) AS n FROM transactions WHERE owner_member_id = ?`, meera,
    )!.n;
    assert.ok(theirs > 0, "Meera's transactions are still attributed to Meera");
    const removed = queryOne<{ removed_at: string | null }>(
      db, `SELECT removed_at FROM members WHERE id = ?`, meera,
    )!;
    assert.ok(removed.removed_at, "and she is marked removed rather than deleted");
  });

  test("the member who came back is the same member", () => {
    const anil = sim.members.anil.id;
    const row = queryOne<{ removed_at: string | null; name: string }>(
      db, `SELECT removed_at, name FROM members WHERE id = ?`, anil,
    )!;
    assert.equal(row.removed_at, null, "re-inviting the same address cleared the removal");
    assert.equal(row.name, "Anil");
    assert.ok(
      DEPARTURE_AT < RETURN_AT,
      "the scenario's own arc: they leave before they come back",
    );
  });

  /**
   * The demo signs everybody into the oldest member who has not been removed.
   * If the simulation removed that member, a demo instance would open on a
   * person the household no longer has — their name in the corner, their budget
   * on screen, and no row for them on the page that lists who is here.
   */
  test("the member a demo signs you in as is still in the household", () => {
    const chosen = queryOne<{ id: string; name: string }>(
      db,
      `SELECT id, name FROM members WHERE removed_at IS NULL ORDER BY created_at LIMIT 1`,
    );
    assert.ok(chosen, "a demo instance would have nobody to sign in as");
    assert.equal(
      chosen.id, sim.members[SIGNED_IN_AS].id,
      `the demo would sign in as ${chosen.name}, not the scenario's ${SIGNED_IN_AS}`,
    );

    // And they are a real participant, not a bystander: a budget of their own
    // and a standing commitment, which is what the demo is there to show.
    assert.equal(sim.budgets.ravi.length > 0, true);
    const committed = queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM categories WHERE commits_to_budget_id IS NOT NULL
        AND budget_id = ?`,
      sim.budgets.ravi,
    )!.n;
    assert.ok(committed > 0, "the signed-in member has no commitment to show");
  });

  test("their budget survived them, with its history intact", () => {
    const budget = sim.budgets.anil;
    const state = computeBudget(
      loadEngineInput(db, { through: sim.months.at(-1)!, budgetId: budget }),
    );
    assert.ok(state.size > 0, "Anil's budget still computes");
    assert.equal(
      identityResidual(state.get(sim.months.at(-1)!)!), 0,
      "and it balances in the month after he came back",
    );
  });
});

describe("top-down · nothing in the domain went unexercised", () => {
  /**
   * Read straight from the source rather than kept as a list: a domain mutation
   * added tomorrow is in this set tomorrow, and fails until the scenario does
   * something with it.
   */
  function mutatingDomainFunctions(): string[] {
    const found: string[] = [];
    for (const file of readdirSync(join(here, "..", "domain"))) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const source = readFileSync(join(here, "..", "domain", file), "utf8");
      for (const m of source.matchAll(
        /export function ([A-Za-z0-9_]+)\s*\(\s*\n?\s*db: DB,\s*actor/g,
      )) {
        found.push(m[1]!);
      }
    }
    return [...new Set(found)].sort();
  }

  /**
   * Mutations the scenario reaches through another one rather than calling
   * directly, or that only a repair script would ever run. Each needs a reason,
   * the same rule `reachability.test.ts` uses.
   */
  const REACHED_INDIRECTLY: Record<string, string> = {
    ensureGoalEnvelope: "createGoal makes the envelope; calling it directly would " +
      "be testing the helper rather than the feature.",
    syncLoanPaymentTarget: "Every loan write calls it — createLoan, a disbursement, " +
      "a rate change, a prepayment. It has no caller of its own by design.",
    prepareClaim: "Called by createTransaction whenever an account and a category " +
      "sit in different budgets, which the scenario does every month.",
    backfillMonthlySnapshots: "A one-off repair for databases that predate dated " +
      "net-worth history. It rewrites history and is run from a console.",
    reanchorToLenderBalance: "Drift is surfaced and reconciled through the statement " +
      "form; re-anchoring directly bypasses the reconciliation it exists to record.",
    editReconciledHistory: "Editing behind a checkpoint is a deliberate, warned act " +
      "in the UI, not something a simulated household does by accident.",
    breakCheckpoints: "The consequence of editReconciledHistory, above.",
    startBlank: "The other half of applyStartingTemplate: a household picks one.",
    setCategoryHidden: "Exercised — but on a category the scenario later deletes, " +
      "so it is called before the deletion rather than after.",
  };

  test("every mutating domain function is called by the scenario", () => {
    const all = mutatingDomainFunctions();
    const missing = all.filter((fn) => !sim.calls.has(fn) && !(fn in REACHED_INDIRECTLY));
    assert.deepEqual(
      missing, [],
      "the scenario never does these, so nothing here is tested end to end — " +
      `add them to the scenario, or to REACHED_INDIRECTLY with a reason: ${missing.join(", ")}`,
    );
  });

  test("the indirection list has no stale entries", () => {
    const all = new Set(mutatingDomainFunctions());
    const stale = Object.keys(REACHED_INDIRECTLY).filter((fn) => !all.has(fn));
    assert.deepEqual(stale, [], `no longer domain mutations: ${stale.join(", ")}`);
  });

  test("the scenario did a great deal of it", () => {
    const total = [...sim.calls.values()].reduce((a, b) => a + b, 0);
    assert.ok(total > 1_500, `only ${total} domain calls; the scenario has thinned out`);
    assert.ok(sim.calls.size > 60, `only ${sim.calls.size} distinct functions exercised`);
  });
});

describe("top-down · the ledger is internally consistent", () => {
  test("no transaction points at an account that does not exist", () => {
    const orphans = queryAll<{ id: string }>(
      db,
      `SELECT t.id FROM transactions t
         LEFT JOIN accounts a ON a.id = t.account_id
        WHERE a.id IS NULL`,
    );
    assert.deepEqual(orphans, []);
  });

  test("every transfer has both of its legs, and they cancel", () => {
    const lonely = queryAll<{ transfer_pair_id: string; legs: number; total: number }>(
      db,
      `SELECT transfer_pair_id, COUNT(*) AS legs, SUM(amount) AS total
         FROM transactions
        WHERE transfer_pair_id IS NOT NULL AND deleted_at IS NULL
        GROUP BY transfer_pair_id
       HAVING COUNT(*) <> 2 OR SUM(amount) <> 0`,
    );
    assert.deepEqual(
      lonely.slice(0, 5), [],
      "a transfer with one leg, or two legs that do not cancel, is money that went nowhere",
    );
  });

  test("net worth computes, and its parts sum to its total", () => {
    const statement = netWorthStatement(db);
    const assets = statement.assetGroups
      .flatMap((g) => g.lines).reduce((sum, line) => sum + line.value, 0);
    const liabilities = statement.liabilityGroups
      .flatMap((g) => g.lines).reduce((sum, line) => sum + line.value, 0);
    assert.equal(statement.totalAssets, assets, "the asset total is not its lines");
    assert.equal(statement.totalLiabilities, liabilities, "the liability total is not its lines");
    assert.equal(
      statement.netWorth, assets - liabilities,
      "the headline is not what the lines under it add up to",
    );
  });

  test("a private account stays out of another member's net worth", () => {
    const hers = netWorthStatement(db, undefined, "INR", { viewerMemberId: sim.members.priya.id });
    const named = [...hers.assetGroups, ...hers.liabilityGroups]
      .flatMap((g) => g.lines).map((l) => l.label);
    assert.ok(
      !named.some((label) => label.includes("IDFC")),
      `Ravi's private account is on Priya's statement: ${named.join(", ")}`,
    );

    // And the total moves with it, because a total that includes what you
    // cannot see publishes it by subtraction (H2.2).
    const his = netWorthStatement(db, undefined, "INR", { viewerMemberId: sim.members.ravi.id });
    assert.notEqual(hers.totalAssets, his.totalAssets);
  });

  test("every month of every budget was closed except the current one", () => {
    const closes = queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM month_closes`)!.n;
    assert.ok(closes >= (sim.months.length - 1), `only ${closes} months were ever closed`);
  });
});
