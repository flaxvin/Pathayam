import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryAll, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount, createCard } from "../domain/accounts.ts";
import { saveConnection } from "./connection.ts";
import { buildQuery, fetchGmail } from "./fetch.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  const m = db.prepare("INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)");
  m.run(RAVI, "ravi@example.com", "Ravi", nowIST());
  m.run(PRIYA, "priya@example.com", "Priya", nowIST());
  saveConnection(db, actor, { email: "ravi@example.com", refreshToken: "rt", scope: "gmail.readonly" });
  return db;
}

/** base64url of a UTF-8 string, the encoding Gmail uses for part bodies. */
function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

/**
 * A fake Gmail + token endpoint. Given a map of message id → {from, subject,
 * body}, it answers the refresh, list and get calls the fetch path makes.
 */
function fakeGoogle(messages: Record<string, { from: string; subject: string; body: string }>) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

    if (url.includes("oauth2.googleapis.com/token")) {
      return json({ access_token: "at", expires_in: 3600 });
    }
    if (url.includes("/messages?")) {
      return json({ messages: Object.keys(messages).map((id) => ({ id })) });
    }
    const get = /\/messages\/([^/?]+)\?/.exec(url);
    if (get) {
      const msg = messages[get[1]!]!;
      return json({
        id: get[1],
        internalDate: "1787855489000",
        payload: {
          mimeType: "multipart/alternative",
          headers: [
            { name: "From", value: msg.from },
            { name: "Subject", value: msg.subject },
          ],
          parts: [{ mimeType: "text/plain", body: { data: b64(msg.body) } }],
        },
      });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

const AXIS_ACCOUNT = `Dear Ravi Kumar,
Amount Debited:
INR 600.00
Account Number:
XX0000
Date & Time:
28-08-26, 00:01:28 IST
Transaction Info:
UPI/P2A/400111222444/KAVYA R PILLAI`;

const AXIS_CARD_ADDON = `Dear Priya Menon,
Transaction Amount:
INR 198
Merchant Name:
M S NOVA EN
Axis Bank Credit Card No.
XX1111
Date & Time:
22-08-2026, 19:17:01 IST`;

describe("04 §3.4 · fetching alerts from Gmail", () => {
  test("the query reads only configured senders", () => {
    const q = buildQuery(90);
    assert.match(q, /^from:\(/);
    assert.match(q, /axis\.bank\.in/);
    assert.match(q, /indusind\.com/);
    assert.match(q, /newer_than:90d/);
  });

  test("an account alert lands in Review against the matched account", async () => {
    const db = setup();
    const bank = createAccount(db, actor, {
      name: "Axis Savings", kind: "budget", subtype: "savings",
      openingDate: "2026-08-01", last4: "0000",
    });

    const result = await fetchGmail(db, actor, {
      clientId: "id", clientSecret: "secret",
      fetchImpl: fakeGoogle({
        m1: { from: "alerts@axis.bank.in", subject: "INR 600 debited", body: AXIS_ACCOUNT },
      }),
    });

    assert.equal(result.alerts.parsed, 1);
    assert.equal(result.alerts.staged, 1);

    const staged = queryAll<{ account_id: string; amount: number; raw_narration: string }>(
      db, `SELECT account_id, amount, raw_narration FROM staged_transactions`,
    );
    assert.equal(staged.length, 1);
    assert.equal(staged[0]!.account_id, bank.id);
    assert.equal(staged[0]!.amount, -rupees(600));
    assert.match(staged[0]!.raw_narration, /KAVYA R PILLAI/);
    db.close();
  });

  test("R6.e · an add-on card alert routes to the card's account and notes the holder", async () => {
    const db = setup();
    const credit = createAccount(db, actor, {
      name: "Axis Atlas", kind: "credit", subtype: "credit-card",
      openingDate: "2026-08-01", openingBalance: -rupees(1),
    });
    createCard(db, actor, { accountId: credit.id, label: "Priya add-on", last4: "1111", holderMemberId: PRIYA });

    const result = await fetchGmail(db, actor, {
      clientId: "id", clientSecret: "secret",
      fetchImpl: fakeGoogle({
        m1: { from: "alerts@axis.bank.in", subject: "INR 198 spent", body: AXIS_CARD_ADDON },
      }),
    });

    assert.equal(result.alerts.staged, 1);
    const staged = queryAll<{ account_id: string; raw_narration: string }>(
      db, `SELECT account_id, raw_narration FROM staged_transactions`,
    );
    assert.equal(staged[0]!.account_id, credit.id, "the add-on's alert posts to the primary's account");
    assert.match(staged[0]!.raw_narration, /Priya Menon/, "the holder is carried for owner defaulting");
    db.close();
  });

  test("an alert for an account the household has not set up is left unmatched", async () => {
    const db = setup();
    const result = await fetchGmail(db, actor, {
      clientId: "id", clientSecret: "secret",
      fetchImpl: fakeGoogle({
        m1: { from: "alerts@axis.bank.in", subject: "INR 600 debited", body: AXIS_ACCOUNT },
      }),
    });
    assert.equal(result.alerts.parsed, 1);
    assert.equal(result.alerts.unmatched, 1);
    assert.equal(result.alerts.staged, 0);
    db.close();
  });

  test("re-fetching the same alert stages nothing new (I5)", async () => {
    const db = setup();
    createAccount(db, actor, {
      name: "Axis Savings", kind: "budget", subtype: "savings",
      openingDate: "2026-08-01", last4: "0000",
    });
    const google = fakeGoogle({
      m1: { from: "alerts@axis.bank.in", subject: "INR 600 debited", body: AXIS_ACCOUNT },
    });
    const deps = { clientId: "id", clientSecret: "secret", fetchImpl: google };

    await fetchGmail(db, actor, deps);
    const second = await fetchGmail(db, actor, deps);
    assert.equal(second.alerts.staged, 0, "the content hash recognises it");
    assert.equal(queryAll(db, `SELECT id FROM staged_transactions`).length, 1);
    db.close();
  });
});
