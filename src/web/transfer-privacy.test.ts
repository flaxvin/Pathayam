/**
 * 15 · A transfer between a private account and a household one.
 *
 * The household leg is a real movement on an account everyone can see, so it
 * is shown to everyone. Its memo, though, was written as "Transfer from
 * <the other account's name>" — and the other account was private. Ravi's
 * register, his transaction page, Search and his CSV export all named Priya's
 * private account.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { createTransfer, getTransaction } from "../domain/transactions.ts";
import { freshHousehold, RAVI, PRIYA } from "../engine/identity.test-data.ts";
import { startTestApp } from "./harness.test-data.ts";

const priya: Actor = { memberId: PRIYA, source: "ui" };
const SECRET = "Zzyzx Private Account";

function household() {
  const db = freshHousehold();
  const joint = createAccount(db, priya, {
    name: "Joint Bank", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 1_000_000,
  }).id;
  const hers = ensurePersonalBudget(db, PRIYA, "Priya");
  const secret = createAccount(db, priya, {
    name: SECRET, kind: "budget", subtype: "savings", openingDate: "2026-01-01",
    openingBalance: 1_000_000, visibility: "private", holderMemberId: PRIYA, budgetId: hers.id,
  }).id;
  const fees = createCategory(db, priya, { groupId: createGroup(db, priya, "Bank").id, name: "Charges" }).id;
  return { db, joint, secret, fees };
}

describe("15 · the household leg of a transfer with a private account", () => {
  test("does not name the private account on any screen the other member reads", async () => {
    const { db, joint, secret, fees } = household();
    const [, into] = createTransfer(db, priya, {
      fromAccountId: secret, toAccountId: joint, amount: 100_000, date: "2026-09-05",
    });
    const [outOf] = createTransfer(db, priya, {
      fromAccountId: joint, toAccountId: secret, amount: 50_000, date: "2026-09-06",
      fee: { amount: 500, categoryId: fees },
    });
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      for (const path of [
        `/accounts/${joint}`, `/transaction/${into.id}`, `/transaction/${outOf.id}`,
        `/search?q=Zzyzx`, `/export.csv`,
      ]) {
        const res = await app.get(path);
        assert.equal(res.status, 200, path);
        assert.ok(!(await res.text()).includes(SECRET), `${path} names the private account`);
      }
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });

  test("the private leg still names the joint account, and its holder's own legs name each other", () => {
    const { db, joint, secret } = household();
    const [outOfSecret] = createTransfer(db, priya, {
      fromAccountId: secret, toAccountId: joint, amount: 100_000, date: "2026-09-05",
    });
    assert.equal(getTransaction(db, outOfSecret.id)!.memo, "Transfer to Joint Bank");

    const hers = ensurePersonalBudget(db, PRIYA, "Priya");
    const other = createAccount(db, priya, {
      name: "Her Other Account", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
      openingBalance: 0, visibility: "private", holderMemberId: PRIYA, budgetId: hers.id,
    }).id;
    const [, arrived] = createTransfer(db, priya, {
      fromAccountId: secret, toAccountId: other, amount: 1_000, date: "2026-09-05",
    });
    assert.equal(getTransaction(db, arrived.id)!.memo, `Transfer from ${SECRET}`);
  });
});
