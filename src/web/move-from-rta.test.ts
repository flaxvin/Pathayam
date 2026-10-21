/**
 * ROUTES-1 · /move's "From" list opens on "Ready to Assign", and posting it
 * answered 404 "That envelope does not exist."
 *
 * The handler checked both envelopes against what the viewer can see before it
 * looked for the "rta" source, and "rta" is not an envelope — so the screen's
 * own default choice could never be submitted. Found by a route sweep that
 * submitted every rendered form as it was drawn.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { queryOne } from "../db/db.ts";
import { rupees } from "../core/money.ts";
import { monthOf, todayIST } from "../core/dates.ts";

test("moving money out of Ready to Assign, as /move draws it, assigns it", async () => {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const actor = { memberId: "m-ravi", source: "ui" as const };
  const month = monthOf(todayIST());
  createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: `${month}-01`, openingBalance: rupees(10_000),
  });
  const cat = createCategory(db, actor, { groupId: createGroup(db, actor, "Home").id, name: "Rent" }).id;
  const app = await startTestApp(db, { memberId: "m-ravi" });
  try {
    const page = await (await app.get(`/move?month=${month}`)).text();
    assert.match(page, /<option value="rta">/, "the screen offers Ready to Assign first");

    const res = await app.post("/move", {
      month, amount: "500", from_category_id: "rta", to_category_id: cat,
    });
    assert.equal(res.status, 303, `answered ${res.status}`);
    const row = queryOne<{ amount: number }>(
      db, `SELECT COALESCE(SUM(amount),0) AS amount FROM assignments WHERE category_id = ? AND month = ?`, cat, month,
    );
    assert.equal(row?.amount, rupees(500));
    assert.deepEqual(app.failures, []);
  } finally {
    await app.close();
  }
});

test("a source that is neither Ready to Assign nor an envelope is still a 404", async () => {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const actor = { memberId: "m-ravi", source: "ui" as const };
  const cat = createCategory(db, actor, { groupId: createGroup(db, actor, "Home").id, name: "Rent" }).id;
  const app = await startTestApp(db, { memberId: "m-ravi" });
  try {
    const res = await app.post("/move", { amount: "5", from_category_id: "nope", to_category_id: cat });
    assert.equal(res.status, 404);
    const rta = await app.post("/move", { amount: "5", from_category_id: cat, to_category_id: "rta" });
    assert.equal(rta.status, 404, "Ready to Assign is a source, not a destination");
  } finally {
    await app.close();
  }
});
