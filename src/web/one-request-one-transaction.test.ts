/**
 * DEBUG-WEB-6 · A request that is refused part-way changes nothing.
 *
 * `mutate` ran a handler's writes one domain call at a time, each in its own
 * transaction. A handler that wrote twice and was refused on the second kept
 * the first: removing a member settles what is outstanding first and removes
 * them second, so "You cannot remove the last member" arrived after their
 * commitment had already been released — next month's ₹5,000 gone from the
 * envelope and two Activity entries for a removal that never happened.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { queryOne } from "../db/db.ts";
import { todayIST, monthOf, addMonths } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { setAssigned, getAssigned } from "../domain/budget.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { ensureCommitmentEnvelope } from "../domain/commitments.ts";
import { removeMember } from "../auth/sessions.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const actor: Actor = { memberId: PRIYA, source: "ui" };
const MONTH = monthOf(todayIST());

describe("DEBUG-WEB-6 · one request, one transaction", () => {
  test("a removal refused after settling leaves the settlement undone", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    seedMember(db, PRIYA, "Priya");
    const mine = ensurePersonalBudget(db, RAVI, "Ravi");
    const envelope = ensureCommitmentEnvelope(db, actor, mine.id);
    createAccount(db, actor, {
      name: "His savings", kind: "budget", subtype: "savings",
      budgetId: mine.id, openingBalance: rupees(1_00_000), openingDate: todayIST(),
    });
    setAssigned(db, actor, MONTH, envelope.id, rupees(10_000));
    setAssigned(db, actor, addMonths(MONTH, 1), envelope.id, rupees(5_000));
    // Removed already, from another tab: Priya is now the only member left.
    removeMember(db, actor, RAVI);

    const events = () => queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM events`)!.n;
    const before = events();
    const app = await startTestApp(db, { memberId: PRIYA });
    try {
      const res = await app.post(`/members/${RAVI}/remove`, { resolution: "release" });
      assert.equal(res.status, 422);
      assert.match(await res.text(), /last member/);
      assert.equal(getAssigned(db, addMonths(MONTH, 1), envelope.id), rupees(5_000), "next month untouched");
      assert.equal(getAssigned(db, MONTH, envelope.id), rupees(10_000), "this month untouched");
      assert.equal(events(), before, "nothing in Activity");
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });
});
