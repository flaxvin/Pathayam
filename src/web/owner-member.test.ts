/**
 * MONEY-CORE-15 · "Who spent it" naming nobody in the household is an answer,
 * not a server fault.
 *
 * A stale form after a member was removed, or a crafted post, sent an
 * owner_member_id that is not a member; both /add and the edit route passed it
 * straight to the insert, which failed on the members foreign key — a 500,
 * recorded as a fault.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransaction, getTransaction } from "../domain/transactions.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { freshHousehold, RAVI, PRIYA } from "../engine/identity.test-data.ts";
import { startTestApp } from "./harness.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

describe("MONEY-CORE-15 · an owner who is not a member", () => {
  test("is refused on add and on edit, and a real member still saves", async () => {
    const db = freshHousehold();
    const bank = createAccount(db, actor, {
      name: "Bank", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 1_000_000,
    }).id;
    const food = createCategory(db, actor, { groupId: createGroup(db, actor, "H").id, name: "Food" }).id;
    const t = createTransaction(db, actor, {
      accountId: bank, amount: -5_000, date: "2026-09-06", payeeName: "Shop", categoryId: food,
    });
    const form = {
      account_id: bank, date: "06-09-2026", amount: "50", direction: "out", payee: "Shop", split_category_0: food,
    };
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const add = await app.post("/add", { ...form, owner_member_id: "m-nobody" });
      assert.equal(add.status, 422);
      const edit = await app.post(`/transaction/${t.id}`, { ...form, owner_member_id: "m-nobody" });
      assert.equal(edit.status, 422);
      assert.match(await edit.text(), /not in this household/);
      assert.deepEqual(app.failures, [], "a refusal, not a server fault");

      assert.equal((await app.post(`/transaction/${t.id}`, { ...form, owner_member_id: PRIYA })).status, 303);
      assert.equal(getTransaction(db, t.id)!.owner_member_id, PRIYA);
    } finally { await app.close(); }
  });
});
