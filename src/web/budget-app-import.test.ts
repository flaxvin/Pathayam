/**
 * IMPORT-1 · A YNAB export, end to end: pasted on the ordinary import screen,
 * recognised, its accounts chosen, and its rows through dedupe, rules and
 * Review — transfers as transfers, a split as a split, and no envelope's
 * assignment touched.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, queryAll, queryOne, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { listStaged } from "../import/pipeline.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { YNAB_DAY_FIRST, YNAB_AMBIGUOUS, ACTUAL_EXPORT } from "../import/budget-apps.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  seedMember(db, "m-priya", "Priya");
  const savings = createAccount(db, actor, {
    name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01", openingBalance: 10_000_000,
  }).id;
  const card = createAccount(db, actor, {
    name: "ZZ Visa", kind: "credit", subtype: "credit-card", openingDate: "2026-08-01",
  }).id;
  const priyas = createAccount(db, { memberId: "m-priya", source: "ui" }, {
    name: "Priya's own", kind: "tracking", subtype: "asset", openingDate: "2026-08-01",
    visibility: "private", holderMemberId: "m-priya",
  }).id;
  const everyday = createGroup(db, actor, "Everyday");
  const groceries = createCategory(db, actor, { groupId: everyday.id, name: "Groceries" }).id;
  const home = createGroup(db, actor, "Home");
  const cleaning = createCategory(db, actor, { groupId: home.id, name: "Cleaning" }).id;
  const health = createGroup(db, actor, "Wellbeing");
  const gym = createCategory(db, actor, { groupId: health.id, name: "Fitness" }).id;
  return { db, savings, card, priyas, groceries, cleaning, gym };
}

const assignments = (db: DB) =>
  queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM assignments WHERE amount <> 0`)?.n ?? 0;

describe("IMPORT-1 · importing a YNAB export", () => {
  test("recognised on /import, its accounts asked for, and nothing written yet", async () => {
    const { db, savings, priyas } = setup();
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const res = await app.post("/import", { account_id: savings, csv: YNAB_DAY_FIRST, file_name: "ynab.csv" });
      assert.equal(res.status, 200);
      const page = await res.text();
      assert.match(page, /Import from YNAB/);
      assert.match(page, /Budget assignments are not imported/);
      assert.match(page, /ZZ Card/);
      // The exact name is suggested; the card, named differently, is the person's call.
      assert.ok(page.includes(`<option value="${savings}" selected>`));
      assert.ok(!page.includes(priyas), "another member's private account is not offered");
      assert.ok(!page.includes('name="date_order"'), "the file proves its own date order");
      assert.equal(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM import_batches`)!.n, 0);
    } finally {
      await app.close();
    }
  });

  test("rows reach Review through rules and dedupe; a transfer pairs, a split stays a split", async () => {
    const { db, savings, card, groceries, cleaning, gym } = setup();
    // A rule the household already had: it files the gym, which no envelope's name matches.
    execute(db,
      `INSERT INTO rules (id,name,stage,conditions_json,actions_json,enabled,proposed,created_at)
       VALUES ('rule-gym','Gym','default',?,?,1,0,?)`,
      JSON.stringify([{ field: "payee", op: "contains", value: "gym" }]),
      JSON.stringify([{ type: "setCategory", categoryId: gym }]), nowIST());
    const before = assignments(db);
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const res = await app.post("/import/budget-app", {
        csv: YNAB_DAY_FIRST, file_name: "ynab.csv", account_0: savings, account_1: card,
      });
      assert.equal(res.status, 303);
      const notice = decodeURIComponent(res.headers.get("location") ?? "");
      assert.match(notice, /2 marked as transfers/);
      assert.match(notice, /Budget assignments were not imported/);

      const staged = listStaged(db);
      assert.equal(staged.length, 6, "the starting balance is left out");
      assert.equal(new Set(staged.map((r) => r.batch_id)).size, 2, "one batch per account, each undoable");

      const shop = staged.find((r) => r.proposed_payee === "ZZ Kirana")!;
      assert.equal(shop.category_id, groceries, "Everyday: Groceries matched by group and name");
      assert.equal(shop.memo, "weekly shop");
      assert.equal(shop.raw_amount, "Outflow ₹1,250.50");
      assert.equal(staged.find((r) => r.proposed_payee === "ZZ Gym")!.category_id, gym, "the rule applied");

      // Review: the transfer is chosen already, the split shown line by line.
      const review = await (await app.get("/review")).text();
      assert.ok(review.includes(`<option value="transfer:${card}" selected>`));
      assert.match(review, /No envelope yet/);

      const bankLeg = staged.find((r) => r.account_id === savings && r.transfer_account_id)!;
      assert.equal(bankLeg.transfer_account_id, card);
      const approve = await app.post("/review/approve", { staged_id: bankLeg.id, category_id: `transfer:${card}` });
      assert.equal(approve.status, 303);
      const legs = queryAll<{ account_id: string; amount: number; category_id: string | null }>(db,
        `SELECT account_id, amount, category_id FROM transactions
          WHERE transfer_pair_id IS NOT NULL AND deleted_at IS NULL ORDER BY amount`);
      assert.deepEqual(legs.map((l) => [l.account_id, l.amount, l.category_id]), [
        [savings, -500_000, null], [card, 500_000, null],
      ], "a transfer, not an expense on one side and income on the other");
      assert.ok(!listStaged(db).some((r) => r.transfer_account_id), "the card's leg was paired, not left waiting");

      // The split: its kite line matched nothing, so approving needs an envelope for it.
      const split = listStaged(db).find((r) => r.splits_json)!;
      assert.equal((await app.post("/review/approve", { staged_id: split.id })).status, 422);
      assert.equal((await app.post("/review/approve", { staged_id: split.id, category_id: cleaning })).status, 303);
      const tx = queryOne<{ id: string; amount: number; is_split: number; category_id: string | null }>(db,
        `SELECT id, amount, is_split, category_id FROM transactions WHERE payee_id = (SELECT id FROM payees WHERE name = 'ZZ Supermart')`)!;
      assert.equal(tx.is_split, 1);
      assert.equal(tx.amount, -100_000);
      const lines = queryAll<{ category_id: string; amount: number; memo: string }>(db,
        `SELECT category_id, amount, memo FROM transaction_splits WHERE transaction_id = ? ORDER BY sort`, tx.id);
      assert.deepEqual(lines.map((l) => [l.category_id, l.amount, l.memo]), [
        [groceries, -60_000, "veg"], [cleaning, -25_000, "soap"], [cleaning, -15_000, "kite"],
      ]);

      // Importing the same file again adds nothing (dedupe's exact tier).
      const pending = listStaged(db).length;
      await app.post("/import/budget-app", {
        csv: YNAB_DAY_FIRST, file_name: "ynab-again.csv", account_0: savings, account_1: card,
      });
      assert.equal(listStaged(db).length, pending);

      assert.equal(assignments(db), before, "no envelope's assignment was touched");
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("an account left out is left out, and its transfers are ordinary rows", async () => {
    const { db, savings } = setup();
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const res = await app.post("/import/budget-app", {
        csv: YNAB_DAY_FIRST, account_0: savings, account_1: "skip",
      });
      assert.equal(res.status, 303);
      const staged = listStaged(db);
      assert.ok(staged.every((r) => r.account_id === savings));
      assert.ok(staged.every((r) => r.transfer_account_id === null));
      assert.equal(new Set(staged.map((r) => r.batch_id)).size, 1);
    } finally {
      await app.close();
    }
  });

  test("ambiguous dates are asked about, and an unanswered question imports nothing", async () => {
    const { db, savings } = setup();
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const page = await (await app.post("/import", { account_id: savings, csv: YNAB_AMBIGUOUS })).text();
      assert.ok(page.includes('name="date_order"'));
      assert.match(page, /reads either way round/);

      const unanswered = await app.post("/import/budget-app", { csv: YNAB_AMBIGUOUS, account_0: savings });
      assert.equal(unanswered.status, 400);
      assert.equal(listStaged(db).length, 0);

      await app.post("/import/budget-app", { csv: YNAB_AMBIGUOUS, account_0: savings, date_order: "mm-dd-yyyy" });
      assert.deepEqual(listStaged(db).map((r) => r.date).sort(), ["2026-03-04", "2026-05-06"]);
    } finally {
      await app.close();
    }
  });

  test("an account choice must be one the viewer can see, and every account must be answered", async () => {
    const { db, savings, priyas } = setup();
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      assert.equal((await app.post("/import/budget-app", {
        csv: YNAB_DAY_FIRST, account_0: savings, account_1: priyas,
      })).status, 404);
      assert.equal((await app.post("/import/budget-app", { csv: YNAB_DAY_FIRST, account_0: savings })).status, 400);
      assert.equal(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM import_batches`)!.n, 0);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("an Actual Budget export goes the same way [unverified columns]", async () => {
    const { db, savings, card } = setup();
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const page = await (await app.post("/import", { account_id: savings, csv: ACTUAL_EXPORT })).text();
      assert.match(page, /Import from Actual Budget/);
      await app.post("/import/budget-app", { csv: ACTUAL_EXPORT, account_0: savings, account_1: card });
      const staged = listStaged(db);
      assert.equal(staged.filter((r) => r.transfer_account_id).length, 2);
      assert.equal(staged.filter((r) => r.splits_json).length, 1);
    } finally {
      await app.close();
    }
  });
});
