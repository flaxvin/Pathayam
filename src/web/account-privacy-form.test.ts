/**
 * "Private to me", as the account forms say it.
 *
 * Both forms offer one visibility choice with that label, and neither route
 * held to it. The create form never sent a holder, so the domain's "private to
 * whom?" refused every private account a member tried to make (FRESH-WEB-2).
 * The edit form took the visibility and the holder as two separate fields, so
 * a member could mark somebody else's account private to themselves — Priya
 * taking Ravi's account, in Ravi's own budget, out of his sight, with nothing
 * left on any screen of his to undo it from (FRESH-WEB-3).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import type { Actor } from "../core/events.ts";
import { rupees } from "../core/money.ts";
import { createAccount, getAccount, listAccounts } from "../domain/accounts.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi: Actor = { memberId: RAVI, source: "ui" };

describe("making an account private from the forms", () => {
  test("FRESH-WEB-2 · 'Private to me' on the new-account form makes it private to me", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    seedMember(db, PRIYA, "Priya");
    const mine = ensurePersonalBudget(db, RAVI, "Ravi");
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const res = await app.post("/accounts/new", {
        name: "My own savings", subtype: "budget:savings", budget_id: mine.id,
        visibility: "private", opening_balance: "1000",
      });
      assert.equal(res.status, 303, await res.text());
      const created = listAccounts(db, { viewerMemberId: RAVI }).find((a) => a.name === "My own savings");
      assert.ok(created, "not created");
      assert.equal(created.visibility, "private");
      assert.equal(created.holder_member_id, RAVI);
      assert.ok(
        !listAccounts(db, { viewerMemberId: PRIYA }).some((a) => a.id === created.id),
        "Priya can see it",
      );
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("FRESH-WEB-3 · another member's account cannot be made private to me", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    seedMember(db, PRIYA, "Priya");
    const his = ensurePersonalBudget(db, RAVI, "Ravi");
    const account = createAccount(db, ravi, {
      name: "Ravi savings", kind: "budget", subtype: "savings",
      openingBalance: rupees(50_000), budgetId: his.id, holderMemberId: RAVI,
    });
    const app = await startTestApp(db, { memberId: PRIYA });
    try {
      const res = await app.post(`/accounts/${account.id}/edit`, {
        name: "Ravi savings", holder_member_id: PRIYA, visibility: "private",
      });
      assert.equal(res.status, 422);
      const after = getAccount(db, account.id)!;
      assert.equal(after.visibility, "household");
      assert.equal(after.holder_member_id, RAVI);
      assert.ok(
        listAccounts(db, { viewerMemberId: RAVI }).some((a) => a.id === account.id),
        "Ravi can no longer see his own account",
      );
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("nor made private to somebody else, which hides it from me for them", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    seedMember(db, PRIYA, "Priya");
    const hers = ensurePersonalBudget(db, PRIYA, "Priya");
    const account = createAccount(db, { memberId: PRIYA, source: "ui" }, {
      name: "Priya savings", kind: "budget", subtype: "savings",
      openingBalance: rupees(10_000), budgetId: hers.id, holderMemberId: PRIYA,
    });
    const app = await startTestApp(db, { memberId: PRIYA });
    try {
      // Hers, so she may make it private to herself.
      const own = await app.post(`/accounts/${account.id}/edit`, {
        name: "Priya savings", holder_member_id: PRIYA, visibility: "private",
      });
      assert.equal(own.status, 303);
      assert.equal(getAccount(db, account.id)!.visibility, "private");
      // But not hand it, still private, to Ravi.
      const given = await app.post(`/accounts/${account.id}/edit`, {
        name: "Priya savings", holder_member_id: RAVI, visibility: "private",
      });
      assert.equal(given.status, 422);
      assert.equal(getAccount(db, account.id)!.holder_member_id, PRIYA);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
