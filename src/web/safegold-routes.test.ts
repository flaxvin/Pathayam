/**
 * IMP-32 · A SafeGold statement uploaded on Import or Portfolio is read as one.
 *
 * Uploaded on Import against a bank account, it went to the column-mapping
 * screen — no bank layout matched it — inviting the household to import gold
 * movements as bank transactions. It is recognised now, and both doors lead
 * to the same review: what the statement would record, nothing written until
 * it is confirmed. Every figure is synthetic.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { queryAll } from "../db/db.ts";
import { createAccount } from "../domain/accounts.ts";
import { statement, TWO_ROWS, safeGoldPdf } from "../import/safegold.test-data.ts";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function upload(app: TestApp, path: string, pdf: Uint8Array, fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set("statement", new Blob([pdf], { type: "application/pdf" }), "safegold-oct.pdf");
  return app.get(path, { method: "POST", body: form, headers: { Origin: app.baseUrl } });
}

const tokenOf = (page: string) => /name="token" value="([^"]+)"/.exec(page)?.[1];

async function withApp(run: (app: TestApp, bankId: string) => Promise<void>) {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  const bank = createAccount(db, actor, {
    name: "Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01", institution: "HDFC Bank",
  });
  const app = await startTestApp(db, { memberId: "m" });
  try {
    await run(app, bank.id);
    assert.deepEqual(app.failures, []);
  } finally {
    await app.close();
  }
}

describe("IMP-32 · uploading a SafeGold statement", () => {
  test("on Import, it is read as gold, not sent to the column mapping", async () => {
    await withApp(async (app, bankId) => {
      const res = await upload(app, "/import/pdf", safeGoldPdf(statement(TWO_ROWS)), { account_id: bankId });
      assert.equal(res.status, 200);
      const page = await res.text();
      assert.doesNotMatch(page, /Which column is which/);
      assert.match(page, /SafeGold/);
      assert.match(page, /0\.7000 g/);
      assert.match(page, /0\.2000 g/);
      assert.ok(tokenOf(page), "a confirmation form");
      // Nothing is staged as a bank transaction, and nothing is held yet.
      assert.equal(queryAll(app.db, `SELECT id FROM staged_transactions`).length, 0);
      assert.equal(queryAll(app.db, `SELECT id FROM lots`).length, 0);
    });
  });

  test("on Portfolio, and confirming it records the gold", async () => {
    await withApp(async (app) => {
      const form = await app.get("/portfolio/safegold");
      assert.equal(form.status, 200);
      assert.match(await form.text(), /action="\/portfolio\/safegold" enctype="multipart\/form-data"/);

      const res = await upload(app, "/portfolio/safegold", safeGoldPdf(statement(TWO_ROWS)));
      const page = await res.text();
      assert.equal(res.status, 200);
      // The fixture opens at 1 g the ledger has never seen, so its sale is
      // within what it bought — and the gap is said.
      assert.match(page, /1\.0000 g/);
      const done = await app.post("/portfolio/safegold/confirm", { token: tokenOf(page)! });
      assert.equal(done.status, 303);
      assert.match(decodeURIComponent(done.headers.get("location") ?? ""), /1 purchase, 1 sale/);
      assert.equal(queryAll(app.db, `SELECT id FROM lots`).length, 1);
      assert.equal(queryAll(app.db, `SELECT id FROM holding_events WHERE kind = 'sale'`).length, 1);

      // The same file again offers nothing new.
      const again = await (await upload(app, "/portfolio/safegold", safeGoldPdf(statement(TWO_ROWS)))).text();
      assert.match(again, /already recorded/i);
    });
  });

  test("a statement whose rows miss its closing balance is not recorded unless asked", async () => {
    await withApp(async (app) => {
      const short = safeGoldPdf(statement(TWO_ROWS.slice(0, 2), "1.3000"));
      const page = await (await upload(app, "/portfolio/safegold", short)).text();
      assert.match(page, /a row is probably missing/i);
      const refused = await app.post("/portfolio/safegold/confirm", { token: tokenOf(page)! });
      assert.equal(refused.status, 422);
      assert.equal(queryAll(app.db, `SELECT id FROM lots`).length, 0);

      const again = await (await upload(app, "/portfolio/safegold", short)).text();
      const ok = await app.post("/portfolio/safegold/confirm", { token: tokenOf(again)!, accept_mismatch: "1" });
      assert.equal(ok.status, 303);
      assert.equal(queryAll(app.db, `SELECT id FROM lots`).length, 1);
    });
  });

  test("a file that is not a SafeGold statement is said to be one it cannot read", async () => {
    await withApp(async (app) => {
      const res = await upload(app, "/portfolio/safegold", safeGoldPdf("HDFC BANK\nStatement of account"));
      assert.equal(res.status, 200);
      assert.match(await res.text(), /not a SafeGold statement/);
    });
  });
});
