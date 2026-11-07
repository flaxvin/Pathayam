/**
 * IMP-18 · A card account can hold up to the last eight digits of its number.
 *
 * HSBC locks a card statement with the card's last six, and a bank could ask
 * for more; the account's number field took four, so the six lived only in
 * Settings, one per household. The field now takes four to eight trailing
 * digits on a card account: the last four stay where SMS matching and every
 * screen read them, and the longer run is kept beside them, out of exports,
 * the event log and every page, and offered only as password candidates.
 *
 * All digits here are invented; the identity is the synthetic Ravi.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import type { DB } from "../db/db.ts";
import { queryOne } from "../db/db.ts";
import { createAccount, getAccount, accountsByLast4For } from "../domain/accounts.ts";
import { cardNumberDigits } from "../domain/card-digits.ts";
import { exportEverything } from "../ops/backup.ts";
import { setIdentity } from "../import/identity.ts";
import { STATEMENTS, STATEMENT_IDENTITY, HSBC_CARD_LAST6 } from "../import/statements.test-data.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

const RAVI = "m-ravi";
const ravi: Actor = { memberId: RAVI, source: "ui" };
const EIGHT = "12" + HSBC_CARD_LAST6; // 12556677

function setup(): DB {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  return db;
}

function hsbcCard(db: DB, last4: string | null = null): string {
  return createAccount(db, ravi, {
    name: "HSBC Platinum", kind: "credit", subtype: "credit-card", openingDate: "2026-08-01",
    institution: "HSBC", ...(last4 ? { last4 } : {}),
  }).id;
}

function leaks(db: DB, digits: string): string[] {
  const where: string[] = [];
  if (JSON.stringify(db.prepare("SELECT * FROM events").all()).includes(digits)) where.push("events");
  if (JSON.stringify(exportEverything(db)).includes(digits)) where.push("export");
  return where;
}

describe("IMP-18 · up to eight of the card's digits on a card account", () => {
  test("a new card account takes eight digits: the last four match SMS, the eight are kept privately", async () => {
    const db = setup();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const res = await app.post("/accounts/new", {
        name: "HSBC Platinum", subtype: "credit:credit-card", institution: "HSBC", last4: "1255 6677",
      });
      assert.equal(res.status, 303);
      const id = queryOne<{ id: string }>(db, "SELECT id FROM accounts WHERE name = 'HSBC Platinum'")!.id;
      assert.equal(getAccount(db, id)!.last4, "6677");
      assert.equal(cardNumberDigits(db, id), EIGHT);
      assert.equal(accountsByLast4For(db, "6677", RAVI).length, 1);
      assert.deepEqual(leaks(db, EIGHT), []);
      assert.deepEqual(leaks(db, HSBC_CARD_LAST6), []);

      const page = await (await app.get(`/accounts/${id}`)).text();
      assert.ok(!page.includes(HSBC_CARD_LAST6), "the account page showed more than the last four");
      assert.match(page, /8 digits on file/);
    } finally {
      await app.close();
    }
  });

  test("editing: the same four keeps the longer digits, new ones replace them, empty clears both", async () => {
    const db = setup();
    const id = hsbcCard(db);
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      assert.equal((await app.post(`/accounts/${id}/edit`, { name: "HSBC Platinum", last4: HSBC_CARD_LAST6 })).status, 303);
      assert.equal(cardNumberDigits(db, id), HSBC_CARD_LAST6);
      assert.equal(getAccount(db, id)!.last4, "6677");

      // The edit form shows the last four; saving it unchanged keeps the six.
      assert.equal((await app.post(`/accounts/${id}/edit`, { name: "Renamed", last4: "6677" })).status, 303);
      assert.equal(cardNumberDigits(db, id), HSBC_CARD_LAST6);

      assert.equal((await app.post(`/accounts/${id}/edit`, { name: "Renamed", last4: "9999" })).status, 303);
      assert.equal(cardNumberDigits(db, id), "9999");

      assert.equal((await app.post(`/accounts/${id}/edit`, { name: "Renamed", last4: "" })).status, 303);
      assert.equal(cardNumberDigits(db, id), null);
      assert.equal(getAccount(db, id)!.last4, null);
      assert.deepEqual(leaks(db, HSBC_CARD_LAST6), []);
    } finally {
      await app.close();
    }
  });

  test("nine digits, letters, or more than four on a bank account are refused without echoing them", async () => {
    const db = setup();
    const card = hsbcCard(db);
    const savings = createAccount(db, ravi, {
      name: "Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01",
    }).id;
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      for (const last4 of ["123456789", "12a45678", "12"]) {
        const res = await app.post(`/accounts/${card}/edit`, { name: "HSBC Platinum", last4 });
        assert.equal(res.status, 422, last4);
        assert.ok(!(await res.text()).includes(last4), `${last4} was echoed`);
      }
      assert.equal(cardNumberDigits(db, card), null);
      const res = await app.post(`/accounts/${savings}/edit`, { name: "Savings", last4: "123456" });
      assert.equal(res.status, 422);
    } finally {
      await app.close();
    }
  });

  test("an HSBC statement opens with the account's own six, with nothing saved in Settings", async () => {
    const db = setup();
    setIdentity(db, ravi, STATEMENT_IDENTITY);
    const id = hsbcCard(db);
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      assert.equal((await app.post(`/accounts/${id}/edit`, { name: "HSBC Platinum", last4: EIGHT })).status, 303);
      const form = new FormData();
      form.set("account_id", id);
      form.set("statement", new Blob([STATEMENTS.hsbcCardEncrypted], { type: "application/pdf" }), "hsbc.pdf");
      const res = await app.get("/import/pdf", { method: "POST", body: form, headers: { Origin: app.baseUrl } });
      assert.equal(res.status, 303, await res.text());
      assert.equal(queryOne<{ n: number }>(db, "SELECT count(*) AS n FROM import_batches WHERE account_id = ?", id)!.n, 1);
    } finally {
      await app.close();
    }
  });
});
