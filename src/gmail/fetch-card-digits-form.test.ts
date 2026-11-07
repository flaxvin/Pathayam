/**
 * IMP-20 · After a Gmail fetch, a card whose statement stayed locked for want
 * of its digits is listed with a box to enter them.
 *
 * The fetch said "SBI Card statements use the card's last four digits … Add
 * them on the account" and left the household to find the account. The fetch
 * now lands on Settings with each such card listed under the Gmail section,
 * each with its own form; the digits are saved on the card account the same
 * way the import saves them, and the next fetch opens the statement.
 *
 * Synthetic identity and invented card digits throughout.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import type { DB } from "../db/db.ts";
import { queryOne } from "../db/db.ts";
import { createAccount, getAccount } from "../domain/accounts.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { cardNumberDigits } from "../domain/card-digits.ts";
import { setIdentity } from "../import/identity.ts";
import {
  STATEMENTS, STATEMENT_IDENTITY, SBI_CARD_LAST4, HSBC_CARD_LAST6,
} from "../import/statements.test-data.ts";
import { saveConnection } from "./connection.ts";
import { freshDb, seedMember, startTestApp, type TestApp } from "../web/harness.test-data.ts";

const RAVI = "m-ravi";
const ravi: Actor = { memberId: RAVI, source: "ui" };
const priya: Actor = { memberId: "m-priya", source: "ui" };

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function fakeGoogle(from: string, pdf: Uint8Array): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "at", expires_in: 3600 });
    if (url.includes("/messages?")) return json({ messages: [{ id: "s1" }] });
    if (url.includes("/attachments/")) return json({ data: Buffer.from(pdf).toString("base64url") });
    if (/\/messages\/s1\?/.test(url)) {
      return json({
        id: "s1", internalDate: "1787855489000",
        payload: {
          mimeType: "multipart/mixed",
          headers: [{ name: "From", value: from }, { name: "Subject", value: "Your card statement" }],
          parts: [
            { mimeType: "text/plain", body: { data: b64("Your statement is attached.") } },
            { mimeType: "application/pdf", filename: "card.pdf", body: { attachmentId: "a1" } },
          ],
        },
      });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

const SBI = () => fakeGoogle("SBI Card <statements@sbicard.com>", STATEMENTS.sbiCardEncrypted);
const HSBC = () => fakeGoogle("HSBC <statements@mail.hsbc.co.in>", STATEMENTS.hsbcCardEncrypted);

function setup(): DB {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, "m-priya", "Priya");
  setIdentity(db, ravi, STATEMENT_IDENTITY);
  saveConnection(db, ravi, { email: "ravi@example.com", refreshToken: "rt", scope: "gmail.readonly" });
  return db;
}

function cardAt(db: DB, institution: string, last4: string | null = null): string {
  return createAccount(db, ravi, {
    name: `${institution} Card`, kind: "credit", subtype: "credit-card", openingDate: "2026-08-01",
    institution, ...(last4 ? { last4 } : {}),
  }).id;
}

async function withApp<T>(db: DB, google: typeof fetch, fn: (app: TestApp) => Promise<T>): Promise<T> {
  const app = await startTestApp(db, {
    memberId: RAVI, fetchImpl: google,
    config: { google: { clientId: "id", clientSecret: "secret" } },
  });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

const pdfBatches = (db: DB) =>
  queryOne<{ n: number }>(db, "SELECT count(*) AS n FROM import_batches WHERE source = 'pdf'")!.n;

describe("IMP-20 · the Gmail fetch asks for the digits of each card it could not open", () => {
  test("a locked SBI Card statement lands on Settings with a form for that card", async () => {
    const db = setup();
    const id = cardAt(db, "SBI Card");
    await withApp(db, SBI(), async (app) => {
      const res = await app.post("/gmail/fetch", {});
      assert.equal(res.status, 303);
      const location = res.headers.get("location")!;
      const url = new URL(location, app.baseUrl);
      assert.equal(url.pathname, "/settings");
      assert.match(url.searchParams.get("notice")!, /could not open/);

      const page = await (await app.get(location)).text();
      assert.match(page, /notice notice-warning/);
      assert.match(page, /action="\/gmail\/card-digits"/);
      assert.match(page, new RegExp(`name="account_id" value="${id}"`));
      assert.match(page, /SBI Card Card/);
      assert.match(page, /last four/);
    });
  });

  test("the digits entered there are saved on the card, and the next fetch opens the statement", async () => {
    const db = setup();
    const id = cardAt(db, "SBI Card");
    await withApp(db, SBI(), async (app) => {
      await app.post("/gmail/fetch", {});
      const res = await app.post("/gmail/card-digits", { account_id: id, card_digits: SBI_CARD_LAST4 });
      assert.equal(res.status, 303);
      const notice = new URL(res.headers.get("location")!, app.baseUrl).searchParams.get("notice")!;
      assert.match(notice, /••21/);
      assert.ok(!notice.includes(SBI_CARD_LAST4), notice);
      assert.equal(getAccount(db, id)!.last4, SBI_CARD_LAST4);

      const again = await app.post("/gmail/fetch", {});
      const notice2 = new URL(again.headers.get("location")!, app.baseUrl).searchParams.get("notice")!;
      assert.doesNotMatch(notice2, /could not open/, notice2);
      assert.equal(pdfBatches(db), 1);
    });
  });

  test("HSBC with only four recorded asks for six; the six are kept on the card, out of the log", async () => {
    const db = setup();
    const id = cardAt(db, "HSBC", HSBC_CARD_LAST6.slice(-4));
    await withApp(db, HSBC(), async (app) => {
      const res = await app.post("/gmail/fetch", {});
      const page = await (await app.get(res.headers.get("location")!)).text();
      assert.match(page, /last six/);
      assert.match(page, new RegExp(`value="${id}"`));

      const saved = await app.post("/gmail/card-digits", { account_id: id, card_digits: HSBC_CARD_LAST6 });
      assert.equal(saved.status, 303);
      assert.equal(cardNumberDigits(db, id), HSBC_CARD_LAST6);
      assert.ok(!JSON.stringify(db.prepare("SELECT * FROM events").all()).includes(HSBC_CARD_LAST6));

      await app.post("/gmail/fetch", {});
      assert.equal(pdfBatches(db), 1);
    });
  });

  test("bad digits are refused without being echoed, and nothing is saved", async () => {
    const db = setup();
    const id = cardAt(db, "SBI Card");
    await withApp(db, SBI(), async (app) => {
      for (const bad of ["12", "1234567890", "12ab"]) {
        const res = await app.post("/gmail/card-digits", { account_id: id, card_digits: bad });
        assert.equal(res.status, 422, bad);
        // Matched as a whole token, as TEST-2 settled for the same check: the
        // page carries random ids and content-hashed asset URLs, and "12"
        // turned up inside one of those whenever the stylesheet or script changed.
        const echoed = new RegExp(`(?<![0-9A-Za-z])${bad}(?![0-9A-Za-z])`);
        assert.ok(!echoed.test(await res.text()), `${bad} was echoed`);
      }
      assert.equal(getAccount(db, id)!.last4, null);
    });
  });

  test("another member's private card is neither listed nor writable, whatever the URL says", async () => {
    const db = setup();
    const theirs = createAccount(db, priya, {
      name: "Priya's SBI Card", kind: "credit", subtype: "credit-card", openingDate: "2026-08-01",
      institution: "SBI Card", visibility: "private", holderMemberId: "m-priya",
      budgetId: ensurePersonalBudget(db, "m-priya", "Priya").id,
    });
    await withApp(db, SBI(), async (app) => {
      const page = await (await app.get(`/settings?card_digits=${theirs.id}:4`)).text();
      assert.ok(!page.includes(theirs.id), "a private card of another member was listed");
      assert.doesNotMatch(page, /Priya's SBI Card/);
      const res = await app.post("/gmail/card-digits", { account_id: theirs.id, card_digits: "1111" });
      assert.equal(res.status, 404);
      assert.equal(getAccount(db, theirs.id)!.last4, null);
    });
  });

  test("a card that already has its digits is not listed again", async () => {
    const db = setup();
    const id = cardAt(db, "SBI Card", SBI_CARD_LAST4);
    await withApp(db, SBI(), async (app) => {
      const page = await (await app.get(`/settings?card_digits=${id}:4`)).text();
      assert.doesNotMatch(page, /action="\/gmail\/card-digits"/);
    });
  });

  test("REV-5 · one card at the bank with its digits does not hide another without them", async () => {
    // The first card's four digits are not the ones this statement wants, so
    // it stays locked; the second card, with none, is the one to ask about.
    const db = setup();
    const known = createAccount(db, ravi, {
      name: "SBI Card Gold", kind: "credit", subtype: "credit-card", openingDate: "2026-08-01",
      institution: "SBI Card", last4: "9999",
    }).id;
    const blank = createAccount(db, ravi, {
      name: "SBI Card Travel", kind: "credit", subtype: "credit-card", openingDate: "2026-08-01",
      institution: "SBI Card",
    }).id;
    await withApp(db, SBI(), async (app) => {
      const res = await app.post("/gmail/fetch", {});
      const page = await (await app.get(res.headers.get("location")!)).text();
      assert.match(page, new RegExp(`name="account_id" value="${blank}"`));
      assert.doesNotMatch(page, new RegExp(`name="account_id" value="${known}"`));
    });
  });
});
