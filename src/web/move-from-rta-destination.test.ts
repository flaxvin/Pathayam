/**
 * "Ready to Assign" is a source on the Move screen, and the one it selects by
 * default. It is not an envelope, so the visibility guard on envelope ids
 * (6efbf04) must not be asked about it: when it was, every move from Ready to
 * Assign — the "Cover" button's first suggestion included — answered 404 "That
 * envelope does not exist." Found by clicking Cover on an overspent envelope
 * and then "Ready to Assign" in a real browser.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, testConfig, type TestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory, getAssigned } from "../domain/budget.ts";
import { rupees } from "../core/money.ts";
import { todayIST, monthOf } from "../core/dates.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };
let app: TestApp;
let db: ReturnType<typeof freshDb>;
let help = "";
const month = monthOf(todayIST());

before(async () => {
  db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: todayIST(), openingBalance: rupees(50_000),
  });
  const g = createGroup(db, actor, "Fixed");
  help = createCategory(db, actor, { groupId: g.id, name: "Domestic help" }).id;
  app = await startTestApp(db, { memberId: "m-ravi", config: testConfig({}) });
});
after(async () => { await app.close(); });

describe("moving money out of Ready to Assign", () => {
  test("is accepted, and assigns to the envelope", async () => {
    const res = await app.post("/move", {
      month, from_category_id: "rta", to_category_id: help, amount: "3860",
    });
    assert.equal(res.status < 400, true, `answered ${res.status}`);
    assert.equal(getAssigned(db, month, help), rupees(3_860));
  });

  test("an envelope the viewer cannot see is still refused as the destination", async () => {
    const res = await app.post("/move", {
      month, from_category_id: "rta", to_category_id: "no-such-envelope", amount: "10",
    });
    assert.equal(res.status, 404);
  });
});
