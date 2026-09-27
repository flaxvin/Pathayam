/**
 * 15 · The small defaults a screen works out for you, worked out as you.
 *
 * Three places read the whole household to pick something for the reader: the
 * envelope Review offers to file a payee as, the account /add starts on, and the
 * transaction count on /health. None of them printed another member's private
 * data — each was filtered on the way out — but each chose from it, so the
 * reader got a worse answer than their own history gave: no suggestion, no
 * preselected account, a count that moved when somebody else spent privately.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import type { Actor } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, addDays } from "../core/dates.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { execute, queryOne } from "../db/db.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi: Actor = { memberId: RAVI, source: "ui" };
const priya: Actor = { memberId: PRIYA, source: "ui" };

function household() {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, PRIYA, "Priya");
  const joint = createAccount(db, ravi, {
    name: "Joint current", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(2_00_000),
  });
  const wallet = createAccount(db, priya, {
    name: "Priya's wallet", kind: "budget", subtype: "wallet",
    openingDate: "2026-01-01", openingBalance: rupees(10_000),
  });
  const everyday = createGroup(db, ravi, "Everyday");
  const eatingOut = createCategory(db, ravi, { groupId: everyday.id, name: "Eating out" });

  const his = ensurePersonalBudget(db, RAVI, "Ravi");
  const hisAccount = createAccount(db, ravi, {
    name: "Ravi private savings", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(3_00_000),
    holderMemberId: RAVI, visibility: "private", budgetId: his.id,
  });
  const hisGroup = createGroup(db, ravi, "Mine", "normal", his.id);
  const treats = createCategory(db, ravi, { groupId: hisGroup.id, name: "Ravi treats" });
  return { db, joint, wallet, eatingOut, hisAccount, treats };
}

describe("15 · defaults a screen picks for the reader are picked from what the reader sees", () => {
  test("Review's 'File as' suggestion comes from the reader's own filings", async () => {
    const { db, joint, eatingOut, hisAccount, treats } = household();
    const day = addDays(todayIST(), -10);
    // Priya has filed Cafe Coffee Day to Eating out once.
    createTransaction(db, priya, {
      accountId: joint.id, amount: -rupees(200) as Paise, date: day,
      categoryId: eatingOut.id, payeeName: "Cafe Coffee Day", ownerMemberId: PRIYA,
    });
    // Ravi, privately, three times to his own envelope: the household-wide
    // favourite, and one Priya cannot see.
    for (let i = 0; i < 3; i++) {
      createTransaction(db, ravi, {
        accountId: hisAccount.id, amount: -rupees(250) as Paise, date: day,
        categoryId: treats.id, payeeName: "Cafe Coffee Day", ownerMemberId: RAVI,
      });
    }
    // An unfiled one on the joint account waits in Priya's queue.
    const unfiled = createTransaction(db, priya, {
      accountId: joint.id, amount: -rupees(180) as Paise, date: todayIST(),
      categoryId: eatingOut.id, payeeName: "Cafe Coffee Day", ownerMemberId: PRIYA,
    });
    execute(db, `UPDATE transactions SET category_id = NULL WHERE id = ?`, unfiled.id);

    const app = await startTestApp(db, { memberId: PRIYA });
    try {
      const body = await (await app.get("/review")).text();
      assert.ok(!body.includes("Ravi treats"), "Review named Ravi's private envelope");
      assert.match(body, /File as\s+Eating out/, "Priya's own history was ignored in favour of Ravi's");
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("/add starts on the reader's last-used account, not somebody else's private one", async () => {
    const { db, wallet, hisAccount, treats, eatingOut } = household();
    createTransaction(db, priya, {
      accountId: wallet.id, amount: -rupees(90) as Paise, date: todayIST(),
      categoryId: eatingOut.id, payeeName: "Chai", ownerMemberId: PRIYA,
    });
    // Entered after Priya's, so it is the household's most recent. Stamped a
    // minute later so the order does not rest on two inserts in one millisecond.
    const his = createTransaction(db, ravi, {
      accountId: hisAccount.id, amount: -rupees(500) as Paise, date: todayIST(),
      categoryId: treats.id, payeeName: "Bookshop", ownerMemberId: RAVI,
    });
    execute(db, `UPDATE transactions SET created_at = '2999-01-01T00:00:00.000+05:30' WHERE id = ?`, his.id);

    const app = await startTestApp(db, { memberId: PRIYA });
    try {
      const body = await (await app.get("/add")).text();
      assert.match(
        body, new RegExp(`<option value="${wallet.id}"\\s+selected`),
        "Priya's form did not start on the account she last used",
      );
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("/health counts the transactions the reader can see", async () => {
    const { db, joint, hisAccount, treats, eatingOut } = household();
    createTransaction(db, priya, {
      accountId: joint.id, amount: -rupees(90) as Paise, date: todayIST(),
      categoryId: eatingOut.id, payeeName: "Chai", ownerMemberId: PRIYA,
    });
    for (let i = 0; i < 4; i++) {
      createTransaction(db, ravi, {
        accountId: hisAccount.id, amount: -rupees(500) as Paise, date: todayIST(),
        categoryId: treats.id, payeeName: "Bookshop", ownerMemberId: RAVI,
      });
    }
    const all = queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM transactions WHERE deleted_at IS NULL`)!.n;
    assert.ok(all >= 5);

    const app = await startTestApp(db, { memberId: PRIYA });
    try {
      const body = await (await app.get("/health")).text();
      assert.match(body, /Connected\. 1 transactions/, "Priya's health page counted Ravi's private spending");
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
