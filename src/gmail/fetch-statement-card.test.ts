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
import {
  STATEMENTS, STATEMENT_IDENTITY, SBI_CARD_LAST4, HSBC_CARD_LAST6,
} from "../import/statements.test-data.ts";
import { saveConnection } from "./connection.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

/** A fake Google holding one card statement email with its locked PDF — SBI Card's unless told. */
function fakeGoogle(
  statement: { from: string; pdf: Uint8Array } = {
    from: "SBI Card <statements@sbicard.com>", pdf: STATEMENTS.sbiCardEncrypted,
  },
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "at", expires_in: 3600 });
    if (url.includes("/messages?")) return json({ messages: [{ id: "s1" }] });
    if (url.includes("/attachments/")) {
      return json({ data: Buffer.from(statement.pdf).toString("base64url") });
    }
    if (/\/messages\/s1\?/.test(url)) {
      return json({
        id: "s1", internalDate: "1787855489000",
        payload: {
          mimeType: "multipart/mixed",
          headers: [
            { name: "From", value: statement.from },
            { name: "Subject", value: "Your card statement" },
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

async function fetchFromGmail(db: DB, google: typeof fetch = fakeGoogle()): Promise<string> {
  const app = await startTestApp(db, {
    memberId: "m-ravi", fetchImpl: google,
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

/**
 * IMPORT-15 · A locked mailed statement says which digits would open it, as
 * the upload does, and HSBC's last six — which no account can hold — open it
 * once saved in Settings.
 */
describe("IMPORT-15 · Gmail card statements and the card's recorded digits", () => {
  const hsbc = () => fakeGoogle({ from: "HSBC <statements@mail.hsbc.co.in>", pdf: STATEMENTS.hsbcCardEncrypted });

  function hsbcCard(db: DB, last4: string | null): string {
    return createAccount(db, actor, {
      name: "HSBC Platinum", kind: "credit", subtype: "credit-card", openingDate: "2026-08-01",
      institution: "HSBC", ...(last4 ? { last4 } : {}),
    }).id;
  }

  test("an SBI Card statement with no digits recorded says it needs the card's last four", async () => {
    const db = setup();
    sbiCard(db, "SBI Card", null);
    const notice = await fetchFromGmail(db);
    assert.match(notice, /could not open/, notice);
    assert.match(notice, /card's last four/, notice);
    assert.equal(pdfBatches(db), 0);
  });

  test("…and once the card's digits are recorded, the same mail opens without that note", async () => {
    const db = setup();
    sbiCard(db, "SBI Card", SBI_CARD_LAST4);
    const notice = await fetchFromGmail(db);
    assert.doesNotMatch(notice, /could not open|last four/, notice);
    assert.equal(pdfBatches(db), 1);
  });

  test("an HSBC statement with only the last four recorded needs the last six, and says where", async () => {
    const db = setup();
    hsbcCard(db, HSBC_CARD_LAST6.slice(-4));
    const notice = await fetchFromGmail(db, hsbc());
    assert.match(notice, /could not open/, notice);
    assert.match(notice, /last six/, notice);
    assert.match(notice, /only the last four/, notice);
    assert.match(notice, /Settings/, notice);
    assert.equal(pdfBatches(db), 0);
  });

  test("with HSBC's last six saved in Settings it opens and files under the HSBC card", async () => {
    const db = setup();
    const accountId = hsbcCard(db, HSBC_CARD_LAST6.slice(-4));
    const settings = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const res = await settings.post("/settings/identity", {
        name: STATEMENT_IDENTITY.name, dob: STATEMENT_IDENTITY.dob, hsbc_card_last6: HSBC_CARD_LAST6,
      });
      assert.equal(res.status, 303);
      const page = await (await settings.get("/settings")).text();
      assert.match(page, /••••77/);
      assert.ok(!page.includes(HSBC_CARD_LAST6), "Settings showed the six digits unmasked");
    } finally {
      await settings.close();
    }
    const notice = await fetchFromGmail(db, hsbc());
    assert.doesNotMatch(notice, /could not open|last six/, notice);
    assert.equal(pdfBatches(db), 1);
    assert.equal(queryOne<{ account_id: string }>(
      db, "SELECT account_id FROM import_batches WHERE source = 'pdf'",
    )!.account_id, accountId);
    // The six are candidates only: not in the notice, not in the event log.
    assert.ok(!notice.includes(HSBC_CARD_LAST6), notice);
    const events = JSON.stringify(db.prepare("SELECT * FROM events").all());
    assert.ok(!events.includes(HSBC_CARD_LAST6), "the HSBC digits reached the event log");
  });
});

/**
 * IMP-4 · A mailed statement goes to the account at its bank, however the
 * bank's name was typed.
 *
 * The account was found by `institution LIKE '%<bank id>%'`. That works for
 * "HDFC Bank" and "Axis Bank", but SBI's id is "sbi" and Standard Chartered's
 * is "sc": an account whose institution says "State Bank of India" or
 * "Standard Chartered" — the bank's own name, as the upload path and the
 * password hints recognise it — never matched, and every statement from them
 * was "no matching account".
 */
describe("IMP-4 · routing a mailed statement by bank", () => {
  test("a Standard Chartered statement files under the account typed as Standard Chartered", async () => {
    const db = setup();
    createAccount(db, actor, {
      name: "HSBC Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01", institution: "HSBC",
    });
    const sc = createAccount(db, actor, {
      name: "SC Card", kind: "credit", subtype: "credit-card", openingDate: "2026-08-01",
      institution: "Standard Chartered",
    }).id;
    await fetchFromGmail(db, fakeGoogle({
      from: "Standard Chartered <global.e-statement-in@sc.com>", pdf: STATEMENTS.hdfc,
    }));
    assert.equal(queryOne<{ account_id: string }>(
      db, "SELECT account_id FROM import_batches WHERE source = 'pdf'",
    )?.account_id, sc);
  });

  test("an SBI statement files under the account typed as State Bank of India", async () => {
    const db = setup();
    const sbi = createAccount(db, actor, {
      name: "SBI Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01",
      institution: "State Bank of India",
    }).id;
    await fetchFromGmail(db, fakeGoogle({ from: "SBI <cbssbi.cas@alerts.sbi.co.in>", pdf: STATEMENTS.sbi }));
    assert.equal(queryOne<{ account_id: string }>(
      db, "SELECT account_id FROM import_batches WHERE source = 'pdf'",
    )?.account_id, sbi);
  });

  test("an id inside another word is not that bank: 'sc' in 'Scotiabank'", async () => {
    const db = setup();
    createAccount(db, actor, {
      name: "Old Scotia", kind: "budget", subtype: "savings", openingDate: "2026-08-01", institution: "Scotiabank",
    });
    await fetchFromGmail(db, fakeGoogle({
      from: "Standard Chartered <global.e-statement-in@sc.com>", pdf: STATEMENTS.hdfc,
    }));
    assert.equal(pdfBatches(db), 0);
  });
});

/**
 * IMP-9 · A household with an HDFC savings account and an HDFC card had two
 * accounts at "hdfc", so every mailed HDFC statement was "no matching
 * account" — though the sender says which it is: the smart-statement address
 * sends the account statement, the cards address the card statement. The
 * sender entry's kind now picks between them.
 */
describe("IMP-9 · a savings account and a card at the same bank", () => {
  function twoAtHdfc(db: DB): { savings: string; card: string } {
    const savings = createAccount(db, actor, {
      name: "HDFC Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01", institution: "HDFC Bank",
    }).id;
    const card = createAccount(db, actor, {
      name: "HDFC Card", kind: "credit", subtype: "credit-card", openingDate: "2026-08-01", institution: "HDFC Bank",
    }).id;
    return { savings, card };
  }
  const filedUnder = (db: DB) => queryOne<{ account_id: string }>(
    db, "SELECT account_id FROM import_batches WHERE source = 'pdf'")?.account_id;

  test("the account statement files under the savings account", async () => {
    const db = setup();
    const { savings } = twoAtHdfc(db);
    await fetchFromGmail(db, fakeGoogle({
      from: "HDFC Bank <hdfcbanksmartstatement@hdfcbank.net>", pdf: STATEMENTS.hdfc,
    }));
    assert.equal(filedUnder(db), savings);
  });

  test("the card statement files under the card", async () => {
    const db = setup();
    const { card } = twoAtHdfc(db);
    await fetchFromGmail(db, fakeGoogle({
      from: "HDFC Bank <emailstatements.cards@hdfcbank.net>", pdf: STATEMENTS.hdfc,
    }));
    assert.equal(filedUnder(db), card);
  });

  test("with only a savings account there, a card-sender statement still files under it", async () => {
    const db = setup();
    const savings = createAccount(db, actor, {
      name: "HDFC Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01", institution: "HDFC Bank",
    }).id;
    await fetchFromGmail(db, fakeGoogle({
      from: "HDFC Bank <emailstatements.cards@hdfcbank.net>", pdf: STATEMENTS.hdfc,
    }));
    assert.equal(filedUnder(db), savings);
  });
});
