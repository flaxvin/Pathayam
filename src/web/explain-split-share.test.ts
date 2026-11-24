/**
 * UI-2 (weekly 25-11) · "Explain this number" on an envelope that took one
 * line of a split says how much of the row was that envelope's.
 *
 * A ₹5,600 card purchase split ₹3,200 Household / ₹2,400 Personal: Household's
 * explanation, under "-₹700 · ₹2,500 assigned, ₹3,200 spent", listed "Spent
 * ₹5,600 on 25-11-2026" — and Personal's listed the same ₹5,600. Each now adds
 * "— ₹3,200 of it in Household" (and ₹2,400 in Personal). A row that is not
 * split keeps its line as it was.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../db/db.ts";
import { nowIST, todayIST, monthOf } from "../core/dates.ts";
import { freshHousehold, RAVI } from "../engine/identity.test-data.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransaction } from "../domain/transactions.ts";
import { startTestApp, type TestApp } from "./harness.test-data.ts";
import type { Actor } from "../core/events.ts";

const ravi: Actor = { memberId: RAVI, source: "ui" };
const NOW = monthOf(todayIST());

describe("UI-2 · a split line's share in the envelope's explanation", () => {
  let app: TestApp;
  let household: string, personal: string, groceries: string;
  before(async () => {
    const db = freshHousehold();
    const group = createGroup(db, ravi, "Living");
    household = createCategory(db, ravi, { groupId: group.id, name: "Household" }).id;
    personal = createCategory(db, ravi, { groupId: group.id, name: "Personal" }).id;
    groceries = createCategory(db, ravi, { groupId: group.id, name: "Groceries" }).id;
    const account = createAccount(db, ravi, {
      name: "ZZ Savings", kind: "budget", subtype: "savings", openingBalance: 10_000_00,
    }).id;
    createTransaction(db, ravi, {
      accountId: account, amount: -5_600_00, payeeName: "Amazon",
      splits: [{ categoryId: household, amount: -3_200_00 }, { categoryId: personal, amount: -2_400_00 }],
    });
    createTransaction(db, ravi, { accountId: account, amount: -1_250_00, payeeName: "Shop", categoryId: groceries });
    execute(db, `UPDATE household SET setup_completed_at = ? WHERE id = 1`, nowIST());
    app = await startTestApp(db, { memberId: RAVI });
  });
  after(() => app.close());

  const explain = async (id: string) =>
    (await app.get(`/explain/category/${id}?month=${NOW}`, { headers: { "X-Fragment": "1" } })).text();

  test("Household says ₹3,200 of the ₹5,600 row was its own", async () => {
    const body = await explain(household);
    assert.match(body, /₹5,600[^<]*— ₹3,200 of it in Household/);
    assert.doesNotMatch(body, /₹2,400 of it/);
  });

  test("Personal says ₹2,400 of the same row was its own", async () => {
    const body = await explain(personal);
    assert.match(body, /₹5,600[^<]*— ₹2,400 of it in Personal/);
  });

  test("a row that is not split keeps its plain line", async () => {
    const body = await explain(groceries);
    assert.match(body, /₹1,250/);
    assert.doesNotMatch(body, /of it in/);
  });
});
