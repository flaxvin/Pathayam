/**
 * The add form and the client script have to agree on names.
 *
 * Two conveniences on the add screen live in the client: picking a known payee
 * fills in where its money usually goes (B82), and choosing an account and an
 * envelope from different budgets says what that filing does (15 §3.4). Both
 * looked the envelope up as `#category_id` and read its budget from a
 * `data-budget` on each option. When the envelope became the first of the
 * split lines (`split_category_0`, with plain options), neither lookup found
 * anything, so both features went quiet with no error anywhere — found by
 * driving the form in a browser, typing "1mg" and watching the envelope stay
 * on "Choose where it came from…".
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, testConfig, type TestApp } from "./harness.test-data.ts";
import { CLIENT_SCRIPT } from "./client.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { householdBudgetId, ensurePersonalBudget } from "../domain/budgets.ts";
import { rupees } from "../core/money.ts";
import { todayIST } from "../core/dates.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };
let app: TestApp;
let html = "";
let groceries = "", pocket = "", household = "", mine = "";

/** The ids one block of the client script looks up with getElementById. */
function idsUsedBy(marker: string): string[] {
  const start = CLIENT_SCRIPT.indexOf(marker);
  assert.ok(start >= 0, `client script has ${marker}`);
  const body = CLIENT_SCRIPT.slice(start, CLIENT_SCRIPT.indexOf("\n  }", start));
  return [...body.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]!);
}

before(async () => {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  household = householdBudgetId(db);
  mine = ensurePersonalBudget(db, "m-ravi", "Ravi").id;
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(50_000),
  }).id;
  const shared = createGroup(db, actor, "Shared", "normal", household);
  groceries = createCategory(db, actor, { groupId: shared.id, name: "Groceries" }).id;
  const own = createGroup(db, actor, "Mine", "normal", mine);
  pocket = createCategory(db, actor, { groupId: own.id, name: "Pocket money" }).id;
  createTransaction(db, actor, {
    accountId: bank, date: todayIST(), amount: -rupees(800), payeeName: "1mg", categoryId: groceries,
  });
  app = await startTestApp(db, { memberId: "m-ravi", config: testConfig({}) });
  html = await (await app.get("/add")).text();
});
after(async () => { await app.close(); });

describe("the add form gives the client what it looks for", () => {
  test("B82 · every element the usual-category fill reads is on the page", () => {
    const ids = idsUsedBy("function applyUsualCategory");
    assert.ok(ids.length > 0);
    // Each id must be satisfiable: either it is rendered, or the lookup has a
    // rendered alternative beside it.
    const block = CLIENT_SCRIPT.slice(CLIENT_SCRIPT.indexOf("function applyUsualCategory"));
    for (const id of ids) {
      const rendered = html.includes(`id="${id}"`);
      const alternative = new RegExp(`getElementById\\("${id}"\\)\\s*\\|\\|\\s*document\\.getElementById\\("([^"]+)"\\)`).exec(block)
        ?? new RegExp(`getElementById\\("([^"]+)"\\)\\s*\\|\\|\\s*document\\.getElementById\\("${id}"\\)`).exec(block);
      assert.ok(
        rendered || (alternative && html.includes(`id="${alternative[1]}"`)),
        `the client reads #${id}, which /add does not render`,
      );
    }
    assert.match(html, /data-category-hint/, "the fill says what it did");
    assert.match(html, new RegExp(`<option value="1mg"[^>]*data-category="${groceries}"`));
  });

  test("15 §3.4 · the cross-budget note can tell the envelope's budget", () => {
    for (const id of idsUsedBy("(function explainCrossBudgetFiling")) {
      const block = CLIENT_SCRIPT.slice(CLIENT_SCRIPT.indexOf("(function explainCrossBudgetFiling"));
      const alternative = new RegExp(`getElementById\\("${id}"\\)\\s*\\|\\|\\s*document\\.getElementById\\("([^"]+)"\\)`).exec(block);
      assert.ok(
        html.includes(`id="${id}"`) || (alternative && html.includes(`id="${alternative[1]}"`)),
        `the client reads #${id}, which /add does not render`,
      );
    }
    const first = html.slice(html.indexOf('id="split_category_0"'), html.indexOf("</select>", html.indexOf('id="split_category_0"')));
    assert.match(first, new RegExp(`<option value="${groceries}"[^>]*data-budget="${household}"`));
    assert.match(first, new RegExp(`<option value="${pocket}"[^>]*data-budget="${mine}"`));
    assert.match(first, /<optgroup label="The household budget">/);
    assert.match(first, /<optgroup label="Ravi&#39;s budget">|<optgroup label="Ravi's budget">/);
  });
});
