/**
 * MONEY-CORE-10 / 11 / 27 · "Apply to existing transactions" files only what
 * the person applying it can see, and only where filing is allowed.
 *
 * It read every live transaction in the household and wrote `category_id`
 * with a raw UPDATE. Ravi's "Swiggy → Food" re-filed Priya's personal spend out
 * of her own envelope and an entry on her private tracking account, set an
 * envelope on a split row (changing nothing, counted as a change), and its
 * preview listed her private payee and her envelope's name. A rule naming a
 * card's payment envelope or a commitment envelope filed spending straight
 * into it. Each put a budget's identity out by the amount.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { queryOne, queryAll, execute } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { createAccount, paymentCategoryFor } from "../domain/accounts.ts";
import { createTransaction } from "../domain/transactions.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { startPersonalBudget, createGroup, createCategory } from "../domain/budget.ts";
import { previewRetroactive, applyRetroactive } from "./learning.ts";
import type { Rule } from "./rules.ts";
import { freshHousehold, identityProblems, RAVI, PRIYA } from "../engine/identity.test-data.ts";
import { startTestApp } from "../web/harness.test-data.ts";

const ravi: Actor = { memberId: RAVI, source: "ui" };
const priya: Actor = { memberId: PRIYA, source: "ui" };

function household() {
  const db = freshHousehold();
  const pb = ensurePersonalBudget(db, PRIYA, "Priya").id;
  startPersonalBudget(db, priya, pb);
  const hBank = createAccount(db, ravi, {
    name: "HBank", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 1_000_000,
  }).id;
  const pBank = createAccount(db, priya, {
    name: "PBank", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 500_000,
    budgetId: pb, holderMemberId: PRIYA,
  }).id;
  const pSecret = createAccount(db, priya, {
    name: "P private", kind: "tracking", subtype: "savings", openingDate: "2026-01-01", openingBalance: 0,
    holderMemberId: PRIYA, visibility: "private",
  }).id;
  const g = createGroup(db, ravi, "H");
  const food = createCategory(db, ravi, { groupId: g.id, name: "Food" }).id;
  const fun = createCategory(db, ravi, { groupId: g.id, name: "Fun" }).id;
  const pGift = createCategory(db, priya, { groupId: createGroup(db, priya, "P", "normal", pb).id, name: "Surprise gift for Ravi" }).id;
  // The row rule_applications points at; the rule's own action is passed in.
  execute(db, `INSERT INTO rules (id,name,stage,conditions_json,actions_json,enabled,proposed,created_at)
               VALUES ('r1','Swiggy is food','default','[]','[]',1,0,?)`, nowIST());
  return { db, pb, hBank, pBank, pSecret, food, fun, pGift };
}

const swiggyTo = (categoryId: string): Rule => ({
  id: "r1", name: "Swiggy is food", stage: "default", match: "all",
  conditions: [{ field: "payee", op: "contains", value: "Swiggy" }],
  actions: [{ type: "setCategory", categoryId }],
  enabled: true,
});

describe("MONEY-CORE-10 / 11 · only what the applier can see, and never a split row", () => {
  test("Ravi's rule leaves Priya's personal and private rows, and a split, alone", () => {
    const w = household();
    const split = createTransaction(w.db, ravi, {
      accountId: w.hBank, amount: -30_000, date: "2026-09-03", payeeName: "Swiggy Mart",
      splits: [{ categoryId: w.food, amount: -20_000 }, { categoryId: w.fun, amount: -10_000 }],
    });
    const personal = createTransaction(w.db, priya, {
      accountId: w.pBank, amount: -40_000, date: "2026-09-04", payeeName: "Swiggy Jewels", categoryId: w.pGift,
    });
    const hidden = createTransaction(w.db, priya, {
      accountId: w.pSecret, amount: -7_700, date: "2026-09-05", payeeName: "Swiggy Clinic",
    });
    const mine = createTransaction(w.db, ravi, {
      accountId: w.hBank, amount: -12_300, date: "2026-09-06", payeeName: "Swiggy", categoryId: w.fun,
    });

    const preview = previewRetroactive(w.db, swiggyTo(w.food), RAVI);
    assert.deepEqual(preview.matches.map((m) => m.payee), ["Swiggy"]);

    assert.equal(applyRetroactive(w.db, ravi, swiggyTo(w.food)), 1);
    const categoryOf = (id: string) =>
      queryOne<{ c: string | null; s: number }>(w.db, `SELECT category_id c, is_split s FROM transactions WHERE id = ?`, id)!;
    assert.equal(categoryOf(mine.id).c, w.food);
    assert.equal(categoryOf(personal.id).c, w.pGift);
    assert.equal(categoryOf(hidden.id).c, null);
    assert.deepEqual({ ...categoryOf(split.id) }, { c: null, s: 1 });
    assert.deepEqual(identityProblems(w.db, "2026-12"), []);
  });

  test("the preview page shows none of Priya's rows", async () => {
    const w = household();
    createTransaction(w.db, priya, {
      accountId: w.pBank, amount: -40_000, date: "2026-09-04", payeeName: "Swiggy Jewels", categoryId: w.pGift,
    });
    createTransaction(w.db, priya, {
      accountId: w.pSecret, amount: -7_700, date: "2026-09-05", payeeName: "Swiggy Clinic",
    });
    createTransaction(w.db, ravi, {
      accountId: w.hBank, amount: -12_300, date: "2026-09-06", payeeName: "Swiggy", categoryId: w.fun,
    });
    const app = await startTestApp(w.db, { memberId: RAVI });
    try {
      await app.post("/rules/new", { name: "Swiggy is food", field: "payee", op: "contains", value: "Swiggy", category_id: w.food });
      const rule = queryOne<{ id: string }>(w.db, `SELECT id FROM rules WHERE id <> 'r1'`)!.id;
      const page = await (await app.post(`/rules/${rule}/apply`, {})).text();
      assert.doesNotMatch(page, /Swiggy Clinic|Swiggy Jewels|Surprise gift/);
      assert.match(page, /Matches <strong>1<\/strong>/);
    } finally { await app.close(); }
  });

  test("a personal account's spend filed to a household envelope opens the claim between them", () => {
    const w = household();
    createTransaction(w.db, priya, {
      accountId: w.pBank, amount: -40_000, date: "2026-09-04", payeeName: "Swiggy",
    });
    assert.equal(applyRetroactive(w.db, priya, swiggyTo(w.food)), 1);
    assert.deepEqual(identityProblems(w.db, "2026-12"), []);
  });
});

describe("MONEY-CORE-27 · a rule never files to a payment or commitment envelope", () => {
  test("saving one is refused", async () => {
    const w = household();
    const card = createAccount(w.db, ravi, {
      name: "Card", kind: "credit", subtype: "credit-card", openingDate: "2026-01-01", openingBalance: 0,
    }).id;
    const app = await startTestApp(w.db, { memberId: RAVI });
    try {
      const res = await app.post("/rules/new", {
        name: "Swiggy to card", field: "payee", op: "contains", value: "Swiggy",
        category_id: paymentCategoryFor(w.db, card)!.id,
      });
      assert.equal(res.status, 422);
      assert.equal(queryAll(w.db, `SELECT 1 FROM rules WHERE id <> 'r1'`).length, 0);
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });

  test("one saved before the refusal applies to nothing", () => {
    const w = household();
    const card = createAccount(w.db, ravi, {
      name: "Card", kind: "credit", subtype: "credit-card", openingDate: "2026-01-01", openingBalance: 0,
    }).id;
    const envelope = paymentCategoryFor(w.db, card)!.id;
    createTransaction(w.db, ravi, {
      accountId: w.hBank, amount: -45_000, date: "2026-09-06", payeeName: "Swiggy", categoryId: w.fun,
    });
    assert.equal(applyRetroactive(w.db, ravi, swiggyTo(envelope)), 0);
    assert.equal(previewRetroactive(w.db, swiggyTo(envelope), RAVI).changing, 0);
    assert.deepEqual(identityProblems(w.db, "2026-12"), []);
  });
});

describe("MONEY-CORE-22 · \"Try it on my history\" reads only the tester's history", () => {
  test("a payee on another member's private account is neither counted nor listed", async () => {
    const w = household();
    createTransaction(w.db, ravi, {
      accountId: w.hBank, amount: -12_300, date: "2026-09-01", payeeName: "Swiggy", categoryId: w.fun,
    });
    createTransaction(w.db, priya, {
      accountId: w.pSecret, amount: -4_567_800, date: "2026-09-20", payeeName: "Swiggy Clinic",
    });
    const app = await startTestApp(w.db, { memberId: RAVI });
    try {
      const page = await (await app.post("/rules/test", {
        name: "Swiggy", field: "payee", op: "contains", value: "Swiggy", category_id: w.food,
      })).text();
      assert.doesNotMatch(page, /Swiggy Clinic|45,678/);
      assert.match(page, /Matches <strong>1<\/strong>/);
    } finally { await app.close(); }
  });
});
