/**
 * Money coming in, with no envelope on the first line.
 *
 * An expense has to name its envelope (B99), but income does not — it lands in
 * Ready to Assign, which is the whole shape of envelope budgeting: the money
 * arrives unassigned and the household decides afterwards. So on the entry
 * form, leaving the first line blank is not an omission. It is the ordinary
 * thing to do with a salary that has one piece worth naming — provident fund,
 * tax deducted — and a remainder that is simply *yours to assign*.
 *
 * That did not work. The create routes skipped a first line whose select was
 * empty, treating it as "no line sent" rather than "no envelope", which
 * promoted the second line to first and filed the **entire** amount into it: a
 * ₹50,000 salary with ₹5,000 named for PF put all ₹50,000 in PF and left
 * Ready to Assign at zero. The household's whole month of money vanished into
 * one envelope, and nothing refused it, because a single-envelope income is a
 * perfectly legal transaction.
 *
 * The remainder line is stored with a null `category_id`, which is what Ready
 * to Assign *is* — so the identity has to come out at exactly zero, or the
 * money has been counted somewhere it is not.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, testConfig } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { createSchedule } from "../domain/schedules.ts";
import { getSplits } from "../domain/transactions.ts";
import { getScheduleSplits } from "../domain/schedules.ts";
import { computeBudget, identityResidual } from "../engine/engine.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { rupees, formatPaise, type Paise } from "../core/money.ts";
import { queryAll, type DB } from "../db/db.ts";
import type { MonthKey } from "../core/dates.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

async function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(0),
  }).id;
  const g = createGroup(db, actor, "Home");
  const pf = createCategory(db, actor, { groupId: g.id, name: "Provident fund" }).id;
  const app = await startTestApp(db, { memberId: "m-ravi", config: testConfig({}) });
  return { db, bank, pf, app };
}

function assertIdentityHolds(db: DB, through: MonthKey) {
  const budget = computeBudget(loadEngineInput(db, { through, useRollup: false }));
  const broken = [...budget]
    .filter(([, state]) => identityResidual(state) !== 0)
    .map(([month, state]) => `${month} out by ${formatPaise(identityResidual(state))}`);
  assert.deepEqual(broken, [], "a null-envelope split line is not landing where it is counted");
  return budget;
}

describe("income with the first envelope left blank", () => {
  test("the remainder goes to Ready to Assign, not into the named envelope", async () => {
    const { db, bank, pf, app } = await setup();
    try {
      const res = await app.post("/add", {
        amount: "50000", direction: "in", date: "05-09-2026", payee: "Employer",
        account_id: bank,
        split_category_0: "",
        split_category_1: pf, split_amount_1: "5000",
      });
      assert.equal(res.status, 303);

      const [tx] = queryAll<{ id: string; is_split: number; category_id: string | null }>(
        db, `SELECT id, is_split, category_id FROM transactions`,
      );
      assert.equal(tx!.is_split, 1, "the whole salary was filed as one envelope");
      assert.equal(tx!.category_id, null);

      const splits = getSplits(db, tx!.id);
      assert.equal(splits.length, 2);
      assert.equal(
        splits.find((s) => s.category_id === null)!.amount, rupees(45_000),
        "the remainder is not the ₹45,000 left after PF",
      );
      assert.equal(splits.find((s) => s.category_id === pf)!.amount, rupees(5_000));

      const budget = assertIdentityHolds(db, "2026-09" as MonthKey);
      assert.equal(
        budget.get("2026-09" as MonthKey)!.readyToAssign, rupees(45_000),
        "the remainder never reached Ready to Assign",
      );
    } finally { await app.close(); }
  });

  test("a schedule does the same, so it is not wrong every month", async () => {
    const { db, bank, pf, app } = await setup();
    try {
      const res = await app.post("/schedules/new", {
        name: "Salary", amount: "50000", direction: "in",
        recurrence: "monthly", next_due: "2026-10-01", account_id: bank,
        split_category_0: "",
        split_category_1: pf, split_amount_1: "5000",
      });
      assert.equal(res.status, 303);

      const [sch] = queryAll<{ id: string; category_id: string | null }>(
        db, `SELECT id, category_id FROM schedules`,
      );
      const lines = getScheduleSplits(db, sch!.id);
      assert.equal(lines.length, 2, "the schedule was not split at all");
      assert.equal(
        lines.find((l) => l.category_id === null)!.amount, rupees(45_000),
        "the remainder line is not what is left after PF",
      );
    } finally { await app.close(); }
  });

  test("but money going out still has to name one", async () => {
    // The asymmetry is the point: an unassigned expense is the queue of
    // unrecorded spending B99 exists to prevent, while unassigned income is
    // just money waiting to be given a job.
    const { db, bank, pf, app } = await setup();
    try {
      const res = await app.post("/add", {
        amount: "5000", direction: "out", date: "05-09-2026", payee: "DMart",
        account_id: bank,
        split_category_0: "",
        split_category_1: pf, split_amount_1: "1000",
      });
      assert.equal(res.status, 400, "an expense was filed with an uncategorised remainder");
      assert.equal(queryAll(db, `SELECT id FROM transactions`).length, 0, "it wrote anyway");
    } finally { await app.close(); }
  });
});

describe("all four screens agree about a blank first line", () => {
  /*
   * The rule is the same everywhere or it is nowhere: an entry form and an
   * edit form for the same thing that disagree is how a household learns to
   * distrust the refusal. It was nowhere — /add refused an uncategorised
   * expense and the other three wrote one, and none of the four was tested for
   * income at all.
   *
   * The status codes differ by area, not by rule: transactions answer 400 as
   * that pair always has, schedules 422 as theirs always has.
   */
  const SCREENS = [
    ["/add", 400],
    ["/transaction/:id", 400],
    ["/schedules/new", 422],
    ["/schedules/:id/edit", 422],
  ] as const;

  async function post(screen: string, direction: "in" | "out") {
    const { db, bank, pf, app } = await setup();
    const other = createCategory(
      db, actor, { groupId: queryAll<{ id: string }>(db, `SELECT id FROM category_groups`)[0]!.id, name: "Other" },
    ).id;
    const sign = direction === "in" ? 1 : -1;
    const lines = { split_category_0: "", split_category_1: pf, split_amount_1: "5000" };

    const txId = createTransactionFixture(db, bank, other, (sign * rupees(50_000)) as Paise);
    const schId = createScheduleFixture(db, bank, other, (sign * rupees(50_000)) as Paise);

    const routes: Record<string, () => Promise<{ status: number }>> = {
      "/add": () => app.post("/add", {
        amount: "50000", direction, date: "05-09-2026", account_id: bank, ...lines }),
      "/transaction/:id": () => app.post(`/transaction/${txId}`, {
        amount: "50000", direction, date: "05-09-2026", payee: "", memo: "", tags: "",
        owner_member_id: "", ...lines }),
      "/schedules/new": () => app.post("/schedules/new", {
        name: "New", amount: "50000", direction, recurrence: "monthly",
        next_due: "2026-10-01", account_id: bank, ...lines }),
      "/schedules/:id/edit": () => app.post(`/schedules/${schId}/edit`, {
        name: "S", amount: "50000", direction, recurrence: "monthly",
        next_due: "2026-10-01", ...lines }),
    };

    const res = await routes[screen]!();
    const after = { txSplits: getSplits(db, txId), schLines: getScheduleSplits(db, schId) };
    await app.close();
    return { status: res.status, after };
  }

  for (const [screen, refusalStatus] of SCREENS) {
    test(`${screen} — money in keeps the remainder in Ready to Assign`, async () => {
      const { status } = await post(screen, "in");
      assert.equal(status, 303, "income with no first envelope was refused");
    });

    test(`${screen} — money out is refused, and writes nothing`, async () => {
      const { status, after } = await post(screen, "out");
      assert.equal(status, refusalStatus, "an uncategorised expense was accepted");
      assert.deepEqual(after.txSplits, [], "it wrote split lines anyway");
      assert.deepEqual(after.schLines, [], "it wrote schedule lines anyway");
    });
  }
});

function createTransactionFixture(db: DB, bank: string, categoryId: string, amount: Paise): string {
  return createTransaction(db, actor, {
    accountId: bank, amount, date: "2026-09-05", categoryId,
  }).id;
}

function createScheduleFixture(db: DB, bank: string, categoryId: string, amount: Paise): string {
  return createSchedule(db, actor, {
    name: "S", accountId: bank, categoryId, amount,
    recurrence: "monthly", nextDue: "2026-10-01",
  }).id;
}
