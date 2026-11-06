/**
 * WEB-3 · The demo takes no receipts.
 *
 * On a demo anyone is signed in, and a receipt is up to 10 MB stored as a BLOB
 * in the demo's database on a small machine's disk. Nothing capped the total,
 * and the reset only came with a restart — so one visitor posting the same
 * photo in a loop could fill the disk. Same shape as SECURITY-OPS-24 (backups):
 * refused on the demo, offered nowhere on its screens, and unchanged on a
 * household's own copy.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransaction } from "../domain/transactions.ts";
import { listAttachments } from "../domain/attachments.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";
import type { DB } from "../db/db.ts";

const RAVI = "m-ravi";
const ravi: Actor = { memberId: RAVI, source: "ui" };

/** A one-pixel PNG, so the receipt is a real file with real bytes. */
const RECEIPT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function household(): { db: DB; transactionId: string } {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  const account = createAccount(db, ravi, {
    name: "Joint Bank", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(50_000) as Paise,
  });
  const transaction = createTransaction(db, ravi, {
    accountId: account.id, amount: -rupees(450) as Paise, date: todayIST(),
    payeeName: "Fictional Grocer", cleared: true,
  });
  return { db, transactionId: transaction.id };
}

async function attach(app: TestApp, transactionId: string): Promise<Response> {
  const form = new FormData();
  form.append("receipt", new Blob([RECEIPT], { type: "image/png" }), "receipt.png");
  // Encoded once here so the harness's own headers (cookie, Origin) still apply.
  const encoded = new Request("http://encode.invalid", { method: "POST", body: form });
  return app.post(`/transaction/${transactionId}/attach`, undefined, {
    body: await encoded.arrayBuffer(),
    headers: { "Content-Type": encoded.headers.get("content-type")! },
  });
}

describe("WEB-3 · receipts on the demo", () => {
  test("attaching one is refused, and nothing is stored", async () => {
    const { db, transactionId } = household();
    const app = await startTestApp(db, { memberId: RAVI, config: { demoMode: true } });
    try {
      const res = await attach(app, transactionId);
      assert.equal(res.status, 403, await res.text());
      assert.equal(listAttachments(db, transactionId).length, 0);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("the transaction page offers no upload, and says why", async () => {
    const { db, transactionId } = household();
    const app = await startTestApp(db, { memberId: RAVI, config: { demoMode: true } });
    try {
      const html = await (await app.get(`/transaction/${transactionId}`)).text();
      assert.doesNotMatch(html, /name="receipt"/);
      assert.doesNotMatch(html, /\/attach"/);
      assert.match(html, /Attaching receipts is turned off here/);
      assert.match(html, /your own copy/);
    } finally {
      await app.close();
    }
  });

  test("a household's own copy still takes them", async () => {
    const { db, transactionId } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const page = await (await app.get(`/transaction/${transactionId}`)).text();
      assert.match(page, /name="receipt"/);
      const res = await attach(app, transactionId);
      assert.equal(res.status, 303, await res.text());
      assert.equal(listAttachments(db, transactionId).length, 1);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
