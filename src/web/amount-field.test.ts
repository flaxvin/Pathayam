/**
 * An amount field reads "(1,234.00)" as minus ₹1,234.
 *
 * amountField tries the arithmetic evaluator first, and the evaluator took the
 * brackets as grouping, so a card statement's balance pasted into Reconcile
 * as "(1,234.00)" came in as +₹1,234. Against a card that owes ₹1,234 that is
 * a ₹2,468 difference, and with an adjustment allowed the app posted one.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import type { DB } from "../db/db.ts";
import { queryAll } from "../db/db.ts";
import { createAccount } from "../domain/accounts.ts";
import { startTestApp, seedMember, freshDb, type TestApp } from "./harness.test-data.ts";

const actor: Actor = { memberId: "m", source: "ui" };

let db: DB;
let app: TestApp;
let card: string;

before(async () => {
  db = freshDb();
  seedMember(db);
  card = createAccount(db, actor, {
    name: "Axis card", kind: "credit", subtype: "credit-card",
    openingDate: "2026-08-01", openingBalance: -rupees(1234),
  }).id;
  app = await startTestApp(db);
});
after(async () => {
  await app.close();
});

test("a bracketed bank balance is negative, so a matching card reconciles with no adjustment", async () => {
  const before = queryAll(db, `SELECT id FROM transactions WHERE account_id = ?`, card).length;
  const res = await app.post(`/accounts/${card}/reconcile`, {
    as_of: "2026-09-01", bank_balance: "(1,234.00)", allow_adjustment: "1",
  });
  assert.equal(res.status, 200);
  const after = queryAll<{ amount: number }>(
    db, `SELECT amount FROM transactions WHERE account_id = ?`, card,
  );
  assert.equal(after.length, before, "no adjustment was posted");
  assert.deepEqual(app.failures, []);
});
