/**
 * An unfiled transaction is not hidden from anybody.
 *
 * hiddenTransactionSql tested `category_id IN (the other budgets' envelopes)`,
 * and NULL IN (…) is NULL rather than false once that list has anything in it.
 * The whole test was then NULL, so `NOT hidden` dropped every row with no
 * envelope — money in, an unfiled charge — from Query (and from a rule's
 * history) the moment another member started a budget of their own.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { createTransaction } from "./transactions.ts";
import { ensurePersonalBudget } from "./budgets.ts";
import { startPersonalBudget, createGroup, createCategory } from "./budget.ts";
import { queryTransactions } from "./reports.ts";
import { freshHousehold, RAVI, PRIYA } from "../engine/identity.test-data.ts";

const ravi: Actor = { memberId: RAVI, source: "ui" };
const priya: Actor = { memberId: PRIYA, source: "ui" };

test("Query still lists money in with no envelope once someone else has a budget", () => {
  const db = freshHousehold();
  const pb = ensurePersonalBudget(db, PRIYA, "Priya").id;
  startPersonalBudget(db, priya, pb);
  createCategory(db, priya, { groupId: createGroup(db, priya, "P", "normal", pb).id, name: "Mine" });
  const bank = createAccount(db, ravi, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 100_000,
  }).id;
  const salary = createTransaction(db, ravi, { accountId: bank, amount: 77_700, date: "2026-09-05" });

  assert.deepEqual(queryTransactions(db, { viewerMemberId: RAVI }).map((r) => r.id), [salary.id]);
});
