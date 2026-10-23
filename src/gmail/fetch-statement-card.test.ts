/**
 * D9a · A statement fetched from Gmail gets the card digits the upload gets.
 *
 * SBI Card, Canara and HSBC derive their statement passwords from the card
 * number (`statement-passwords.ts`). `POST /import/pdf` hands the destination
 * account's last four to `passwordCandidates`; the Gmail statement path called
 * it with no card digits at all, so the very same file that opened when
 * uploaded was counted "could not open" when it arrived by mail — for every
 * statement those three institutions send.
 *
 * The fixture is a fictional SBI statement locked with DOB 01/01/1970 + card
 * 4321; nothing in the name/PAN/DOB triple opens it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import type { DB } from "../db/db.ts";
import { queryOne } from "../db/db.ts";
import { createAccount, createCard } from "../domain/accounts.ts";
import { setIdentity } from "../import/identity.ts";
import { STATEMENTS, STATEMENT_IDENTITY, SBI_CARD_LAST4 } from "../import/statements.test-data.ts";
import { saveConnection } from "./connection.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

/** A fake Google holding one SBI Card statement email with the locked PDF. */
function fakeGoogle(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "at", expires_in: 3600 });
    if (url.includes("/messages?")) return json({ messages: [{ id: "s1" }] });
    if (url.includes("/attachments/")) {
      return json({ data: Buffer.from(STATEMENTS.sbiCardEncrypted).toString("base64url") });
    }
    if (/\/messages\/s1\?/.test(url)) {
      return json({
        id: "s1", internalDate: "1787855489000",
        payload: {
          mimeType: "multipart/mixed",
          headers: [
            { name: "From", value: "SBI Card <statements@sbicard.com>" },
            { name: "Subject", value: "Your SBI Card statement" },
          ],
          parts: [
            { mimeType: "text/plain", body: { data: b64("Your statement is attached.") } },
            { mimeType: "application/pdf", filename: "sbicard.pdf", body: { attachmentId: "a1" } },
          ],
        },
      });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

function setup(): DB {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  setIdentity(db, actor, STATEMENT_IDENTITY);
  saveConnection(db, actor, { email: "ravi@example.com", refreshToken: "rt", scope: "gmail.readonly" });
  return db;
}

function sbiCard(db: DB, name: string, last4: string | null): string {
  return createAccount(db, actor, {
    name, kind: "credit", subtype: "credit-card", openingDate: "2026-08-01",
    institution: "SBI Card", ...(last4 ? { last4 } : {}),
  }).id;
}

function pdfBatches(db: DB): number {
  return queryOne<{ n: number }>(db, "SELECT count(*) AS n FROM import_batches WHERE source = 'pdf'")!.n;
}

async function fetchFromGmail(db: DB): Promise<string> {
  const app = await startTestApp(db, {
    memberId: "m-ravi", fetchImpl: fakeGoogle(),
    config: { google: { clientId: "id", clientSecret: "secret" } },
  });
  try {
    const res = await app.post("/gmail/fetch", {});
    assert.equal(res.status, 303);
    const location = res.headers.get("location")!;
    // Read as the browser will: a notice placed after "#gmail" never reaches
    // the server, so it must be in the query, ahead of the fragment.
    const notice = new URL(location, app.baseUrl).searchParams.get("notice");
    assert.ok(notice, `the notice is not in the query the browser sends: ${location}`);
    return notice;
  } finally {
    await app.close();
  }
}

describe("D9a · statement passwords that need the card's digits", () => {
  test("the manual upload opens it, because it knows the account's last four", async () => {
    const db = setup();
    const accountId = sbiCard(db, "SBI Card", SBI_CARD_LAST4);
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const form = new FormData();
      form.set("account_id", accountId);
      form.set("statement", new Blob([STATEMENTS.sbiCardEncrypted], { type: "application/pdf" }), "sbicard.pdf");
      const res = await app.get("/import/pdf", { method: "POST", body: form, headers: { Origin: app.baseUrl } });
      const body = await res.text();
      assert.doesNotMatch(body, /passwords worked|needs a password|last four digits/i);
      assert.equal(pdfBatches(db), 1);
    } finally {
      await app.close();
    }
  });

  test("Gmail opens it too, with the last four of the account it routes to", async () => {
    const db = setup();
    sbiCard(db, "SBI Card", SBI_CARD_LAST4);
    const notice = await fetchFromGmail(db);
    assert.doesNotMatch(notice, /could not open/, notice);
    assert.match(notice, /statement row/, notice);
    assert.equal(pdfBatches(db), 1);
  });

  test("…or with a card's last four when the account itself has none recorded", async () => {
    const db = setup();
    const accountId = sbiCard(db, "SBI Card", null);
    createCard(db, actor, { accountId, label: "Primary", last4: SBI_CARD_LAST4 });
    const notice = await fetchFromGmail(db);
    assert.doesNotMatch(notice, /could not open/, notice);
    assert.equal(pdfBatches(db), 1);
  });

  test("when routing is ambiguous, every visible card's digits are tried — it opens, then waits for an account", async () => {
    const db = setup();
    sbiCard(db, "SBI Card · Ravi", SBI_CARD_LAST4);
    sbiCard(db, "SBI Card · spare", "8765");
    const notice = await fetchFromGmail(db);
    // Opened (so not "could not open"), but there is no single account to file it under.
    assert.doesNotMatch(notice, /could not open/, notice);
    assert.match(notice, /for no single account of yours/, notice);
    assert.equal(pdfBatches(db), 0);
  });

  test("with no card digits anywhere it still says it could not open — nothing is invented", async () => {
    const db = setup();
    sbiCard(db, "SBI Card", null);
    const notice = await fetchFromGmail(db);
    assert.match(notice, /could not open/, notice);
  });
});
