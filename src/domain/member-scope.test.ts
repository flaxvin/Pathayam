/**
 * hiddenTransactionSql answers true or false, never NULL.
 *
 * A split or unfiled transaction has no category of its own; asked whether that
 * missing category was one the viewer may not see, SQL said "unknown" — and a
 * list filtering on `NOT hidden` dropped the row for everybody, as soon as any
 * member kept an envelope of their own.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { freshHousehold, RAVI, PRIYA } from "../engine/identity.test-data.ts";
import { createAccount } from "./accounts.ts";
import { createTransaction } from "./transactions.ts";
import { ensurePersonalBudget } from "./budgets.ts";
import { createGroup, createCategory } from "./budget.ts";
import { queryTransactions } from "./reports.ts";

const ravi: Actor = { memberId: RAVI, source: "ui" };
const priya: Actor = { memberId: PRIYA, source: "ui" };

test("a split and an unfiled row stay in the household's lists once a member has envelopes of her own", () => {
  const db = freshHousehold();
  const joint = createAccount(db, ravi, {
    name: "Joint", kind: "budget", subtype: "savings", openingDate: "2026-09-01", openingBalance: 100_000,
  });
  const g = createGroup(db, ravi, "Shared", "normal", "budget-household");
  const food = createCategory(db, ravi, { groupId: g.id, name: "Food" });
  const fuel = createCategory(db, ravi, { groupId: g.id, name: "Fuel" });
  const split = createTransaction(db, ravi, {
    accountId: joint.id, amount: -4_500, date: "2026-09-02",
    splits: [{ categoryId: food.id, amount: -4_000 }, { categoryId: fuel.id, amount: -500 }],
  });
  const unfiled = createTransaction(db, ravi, { accountId: joint.id, amount: -700, date: "2026-09-03" });

  // Priya's own envelope, which Ravi may not see.
  const hers = ensurePersonalBudget(db, PRIYA, "Priya").id;
  createCategory(db, priya, { groupId: createGroup(db, priya, "Mine", "normal", hers).id, name: "Private thing" });

  const seen = new Set(queryTransactions(db, { viewerMemberId: RAVI }).map((r) => r.id));
  assert.ok(seen.has(split.id), "the split row");
  assert.ok(seen.has(unfiled.id), "the unfiled row");
});
