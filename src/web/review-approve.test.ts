/**
 * B99 · Refusing to approve an unfiled expense is the user's message.
 *
 * `approveStaged` throws `StagedNeedsCategory`, written to be read by the
 * person at the queue. The route let it fall through as a 500, so what
 * reached them was "Something went wrong" and what reached the error log
 * was the sentence meant for them.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import type { DB } from "../db/db.ts";
import { createAccount } from "../domain/accounts.ts";
import { ingest, listStaged } from "../import/pipeline.ts";
import { startTestApp, seedMember, freshDb, type TestApp } from "./harness.test-data.ts";

const actor: Actor = { memberId: "m", source: "ui" };

let db: DB;
let app: TestApp;
let stagedId: string;

before(async () => {
  db = freshDb();
  seedMember(db);
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(50000),
  });
  ingest(db, actor, {
    accountId: bank.id, source: "csv", adapter: "csv", fileName: "one.csv",
    records: [{
      rowNumber: 1, date: "2026-09-08", amount: -rupees(432),
      narration: "UPI-SWIGGY-8821", reference: null,
      raw: { date: "08/09/2026", amount: "432.00", narration: "UPI-SWIGGY-8821" },
    }],
  });
  stagedId = listStaged(db)[0]!.id;
  app = await startTestApp(db);
});
after(async () => {
  await app.close();
});

test("approving money out with no envelope is a 422 that says so", async () => {
  const res = await app.post("/review/approve", { staged_id: stagedId, category_id: "" });
  assert.equal(res.status, 422);
  assert.match(await res.text(), /Choose an envelope/);
  // The row is still waiting, exactly as the queue promises.
  assert.equal(listStaged(db).length, 1);
});
