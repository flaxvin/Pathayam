/**
 * Demo data — the standing scenario, seeded into a throwaway database.
 *
 *   DATABASE_PATH=./demo.sqlite DEMO_MODE=1 npm run demo
 *
 * This used to be six hundred lines of its own household, which meant the data
 * the public sees and the data the suite hammers were two different households
 * that drifted apart: the demo grew a case the tests had never seen, and the
 * tests grew a case the demo could not show. Both now come from
 * `sim/scenario.ts` — four members, thirty-six months, two of them leaving at
 * month 24 and one returning at month 30 — so the first screen anybody sees is
 * the exact household the top-down test balances after every month.
 *
 * Two properties this file must keep:
 *
 * 1. **It ends today.** Every date is derived from `todayIST()` at run time, so
 *    the newest month is always the current one however long from now it runs.
 *    A demo whose latest transaction is eight months old reads as abandoned.
 * 2. **Every figure is invented.** No real person, account, card or balance
 *    appears here or anywhere in this repository.
 *
 * It refuses to run against a database that already has accounts, so it can
 * never be pointed at a household's real data by accident.
 */

import { loadConfig } from "./config.ts";
import { openDatabase, ensureHousehold, queryOne } from "./db/db.ts";
import {
  simulateHousehold, SCENARIO_MONTHS, DEPARTURE_AT, RETURN_AT, SIGNED_IN_AS,
} from "./sim/scenario.ts";

function main(): void {
  const config = loadConfig();
  const db = openDatabase({ path: config.databasePath });
  ensureHousehold(db);

  if ((queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM accounts`)?.n ?? 0) > 0) {
    console.error("This database already has accounts. Point DATABASE_PATH somewhere empty.");
    process.exit(1);
  }

  const started = Date.now();
  const sim = simulateHousehold(db);

  const n = (table: string): number =>
    queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;

  console.log(
    `Demo household seeded across ${SCENARIO_MONTHS} months, ` +
    `${sim.months[0]} → ${sim.months.at(-1)}, in ${((Date.now() - started) / 1000).toFixed(1)}s:\n` +
    `  ${n("transactions")} transactions · ${n("accounts")} accounts · ` +
    `${n("categories")} categories · ${n("budgets")} budgets\n` +
    `  ${n("loan_payments")} loan payments · ${n("lots")} investment lots · ` +
    `${n("month_closes")} month closes\n` +
    `  ${n("net_worth_snapshots")} net-worth snapshots · ${n("schedules")} schedules · ` +
    `${n("goals")} goals · ${n("family_loans")} family arrangements`,
  );
  console.log(
    `\nThe household changed shape twice, which is the point of the scenario:\n` +
    sim.log.map((line) => `  ${line}`).join("\n") +
    `\n  (month ${DEPARTURE_AT + 1} and month ${RETURN_AT + 1} of ${SCENARIO_MONTHS})`,
  );
  console.log(
    `\nRun with DEMO_MODE=true and open /signin. ` +
    `You will be signed in as ${sim.members[SIGNED_IN_AS].name}, who is still here.`,
  );
  db.close();
}

main();
