/**
 * IMP-19 · A statement locked with the card's digits asks for them on import.
 *
 * SBI Card and Canara lock a card statement with the card's last four, HSBC
 * with its last six. When the account has none recorded, the upload said
 * "add them on the account" and stopped: the household left the import,
 * found the account, typed the digits, came back and chose the file again.
 * Now the import form comes back with a field for them; when the file opens
 * with what was typed, the digits are saved on the card account, so the next
 * upload and every Gmail fetch open it unattended.
 *
 * Synthetic identity (Ravi, 01/01/1970); the card digits are invented.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import type { DB } from "../db/db.ts";
import { queryOne } from "../db/db.ts";
import { createAccount, getAccount } from "../domain/accounts.ts";
import { cardNumberDigits } from "../domain/card-digits.ts";
import { setIdentity } from "../import/identity.ts";
import {
  STATEMENTS, STATEMENT_IDENTITY, SBI_CARD_LAST4, HSBC_CARD_LAST6,
} from "../import/statements.test-data.ts";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";

const RAVI = "m-ravi";
const ravi: Actor = { memberId: RAVI, source: "ui" };

function setup(): DB {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  setIdentity(db, ravi, STATEMENT_IDENTITY);
  return db;
}

function card(db: DB, institution: string, last4: string | null = null, kind: "credit" | "budget" = "credit"): string {
  return createAccount(db, ravi, {
    name: `${institution} ${kind === "credit" ? "Card" : "Savings"}`, kind,
    subtype: kind === "credit" ? "credit-card" : "savings", openingDate: "2026-08-01",
    institution, ...(last4 ? { last4 } : {}),
  }).id;
}

async function upload(
  app: TestApp, accountId: string, pdf: Uint8Array, extra: Record<string, string> = {},
): Promise<Response> {
  const form = new FormData();
  form.set("account_id", accountId);
  form.set("statement", new Blob([pdf], { type: "application/pdf" }), "statement.pdf");
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return app.get("/import/pdf", { method: "POST", body: form, headers: { Origin: app.baseUrl } });
}

const batches = (db: DB) =>
  queryOne<{ n: number }>(db, "SELECT count(*) AS n FROM import_batches WHERE source = 'pdf'")!.n;
const events = (db: DB) => JSON.stringify(db.prepare("SELECT * FROM events").all());

describe("IMP-19 · the import asks for the card's digits when they are what is missing", () => {
  test("an SBI Card statement with no digits recorded brings the form back asking for the last four", async () => {
    const db = setup();
    const id = card(db, "SBI Card");
    const other = card(db, "Axis Bank");
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const res = await upload(app, id, STATEMENTS.sbiCardEncrypted);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /name="card_digits"/);
      assert.match(body, /card number's last four/);
      assert.match(body, /choose the statement again/i);
      // The chosen account stays chosen, not the first in the list.
      assert.match(body, new RegExp(`<option value="${id}"\\s+selected`));
      assert.doesNotMatch(body, new RegExp(`<option value="${other}"\\s+selected`));
      assert.equal(batches(db), 0);
    } finally {
      await app.close();
    }
  });

  test("the right four open it, and are saved on the card for next time — masked in the notice", async () => {
    const db = setup();
    const id = card(db, "SBI Card");
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const res = await upload(app, id, STATEMENTS.sbiCardEncrypted, { card_digits: SBI_CARD_LAST4 });
      assert.equal(res.status, 303, await res.text());
      assert.equal(batches(db), 1);
      assert.equal(getAccount(db, id)!.last4, SBI_CARD_LAST4);
      const notice = new URL(res.headers.get("location")!, app.baseUrl).searchParams.get("notice")!;
      assert.match(notice, /saved/i);
      assert.match(notice, /••21/);
      assert.ok(!notice.includes(SBI_CARD_LAST4), notice);

      // The next statement opens with nothing typed.
      const again = await upload(app, id, STATEMENTS.sbiCardEncrypted);
      assert.equal(again.status, 303);
    } finally {
      await app.close();
    }
  });

  test("digits that do not open it are not saved, not echoed, and the form asks again", async () => {
    const db = setup();
    const id = card(db, "SBI Card");
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      for (const wrong of ["9876", "98a6", "98"]) {
        const res = await upload(app, id, STATEMENTS.sbiCardEncrypted, { card_digits: wrong });
        assert.equal(res.status, 200, wrong);
        const body = await res.text();
        assert.match(body, /name="card_digits"/);
        // Matched as a whole token: the page carries random ids and a hex CSRF
        // token, and a bare includes() of "98" failed whenever one held it.
        const echoed = new RegExp(`(?<![0-9A-Za-z])${wrong}(?![0-9A-Za-z])`);
        assert.ok(!echoed.test(body), `${wrong} was echoed`);
      }
      assert.equal(getAccount(db, id)!.last4, null);
      assert.equal(batches(db), 0);
    } finally {
      await app.close();
    }
  });

  test("HSBC with only the last four recorded asks for six, and keeps them on the card, out of every log", async () => {
    const db = setup();
    const id = card(db, "HSBC", HSBC_CARD_LAST6.slice(-4));
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const first = await (await upload(app, id, STATEMENTS.hsbcCardEncrypted)).text();
      assert.match(first, /name="card_digits"/);
      assert.match(first, /last six/);

      const res = await upload(app, id, STATEMENTS.hsbcCardEncrypted, { card_digits: HSBC_CARD_LAST6 });
      assert.equal(res.status, 303, await res.text());
      assert.equal(batches(db), 1);
      assert.equal(cardNumberDigits(db, id), HSBC_CARD_LAST6);
      assert.ok(!res.headers.get("location")!.includes(HSBC_CARD_LAST6));
      assert.ok(!events(db).includes(HSBC_CARD_LAST6), "the six reached the event log");
    } finally {
      await app.close();
    }
  });

  test("a savings account is not asked for a card's digits", async () => {
    const db = setup();
    const id = card(db, "SBI", null, "budget");
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const body = await (await upload(app, id, STATEMENTS.sbiCardEncrypted)).text();
      assert.doesNotMatch(body, /name="card_digits"/);
    } finally {
      await app.close();
    }
  });
});
