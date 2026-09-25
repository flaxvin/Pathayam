import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryAll, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount, createCard } from "../domain/accounts.ts";
import { saveConnection } from "./connection.ts";
import { buildQuery, fetchGmail } from "./fetch.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { listStaged, approveStaged } from "../import/pipeline.ts";

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

  test("R6.e · an add-on card alert routes to the card's account", async () => {
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
    // The holder travels as the card (next test), not as a "[card of Priya
    // Menon]" tag appended to what is meant to be the bank's own words.
    assert.equal(staged[0]!.raw_narration, "M S NOVA EN");
    db.close();
  });

  // routeAlert resolved the add-on card from "XX1111" and then dropped it
  // (`void cardId`). Ingest looked for a last four in "M S NOVA EN", found
  // none, and the ₹198 posted on the primary card, owned by Ravi.
  test("R6.e · the add-on's alert is filed on the add-on card and owned by its holder", async () => {
    const db = setup();
    const credit = createAccount(db, actor, {
      name: "Axis Atlas", kind: "credit", subtype: "credit-card",
      openingDate: "2026-08-01", openingBalance: -rupees(1),
    });
    createCard(db, actor, { accountId: credit.id, label: "Ravi primary", last4: "2222", holderMemberId: RAVI });
    const addOn = createCard(db, actor, {
      accountId: credit.id, label: "Priya add-on", last4: "1111", holderMemberId: PRIYA,
    });
    const group = createGroup(db, actor, "Flexible");
    const category = createCategory(db, actor, { groupId: group.id, name: "Fuel" }).id;

    await fetchGmail(db, actor, {
      clientId: "id", clientSecret: "secret",
      fetchImpl: fakeGoogle({
        m1: { from: "alerts@axis.bank.in", subject: "INR 198 spent", body: AXIS_CARD_ADDON },
      }),
    });
    const [row] = listStaged(db);
    assert.equal(row!.card_id, addOn.id);

    const txId = approveStaged(db, actor, row!.id, { categoryId: category });
    const tx = queryAll<{ card_id: string; owner_member_id: string }>(
      db, `SELECT card_id, owner_member_id FROM transactions WHERE id = ?`, txId,
    )[0]!;
    assert.equal(tx.card_id, addOn.id);
    assert.equal(tx.owner_member_id, PRIYA);
    db.close();
  });

  // P4 / I1: the raw fields are what the alert said. They were the ISO date
  // ("2026-08-28") and the computed signed rupees ("-600"), and approval then
  // dropped raw_date altogether.
  test("the raw date and amount are the alert's own text, through approval", async () => {
    const db = setup();
    createAccount(db, actor, {
      name: "Axis Savings", kind: "budget", subtype: "savings",
      openingDate: "2026-08-01", last4: "0000",
    });
    const group = createGroup(db, actor, "Flexible");
    const category = createCategory(db, actor, { groupId: group.id, name: "Everyday" }).id;
    await fetchGmail(db, actor, {
      clientId: "id", clientSecret: "secret",
      fetchImpl: fakeGoogle({
        m1: { from: "alerts@axis.bank.in", subject: "INR 600 debited", body: AXIS_ACCOUNT },
      }),
    });
    const [row] = listStaged(db);
    const txId = approveStaged(db, actor, row!.id, { categoryId: category });
    const tx = queryAll<{ raw_date: string; raw_amount: string; raw_narration: string; date: string; amount: number }>(
      db, `SELECT raw_date, raw_amount, raw_narration, date, amount FROM transactions WHERE id = ?`, txId,
    )[0]!;
    assert.equal(tx.raw_date, "28-08-26, 00:01:28 IST");
    assert.equal(tx.raw_amount, "INR 600.00");
    assert.equal(tx.raw_narration, "UPI/P2A/400111222444/KAVYA R PILLAI");
    assert.equal(tx.date, "2026-08-28");
    assert.equal(tx.amount, -rupees(600));
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

  // Approval wrote every row as source 'csv', so once the ₹600 alert was
  // approved the next fetch did not recognise it (the exact tier compared
  // 'csv' with 'email'), staged it again, and approving that was a
  // UNIQUE-constraint 500 — on every fetch the inbox still held the alert.
  test("an approved alert fetched again is recognised, not re-staged", async () => {
    const db = setup();
    const bank = createAccount(db, actor, {
      name: "Axis Savings", kind: "budget", subtype: "savings",
      openingDate: "2026-08-01", last4: "0000",
    });
    const group = createGroup(db, actor, "Flexible");
    const category = createCategory(db, actor, { groupId: group.id, name: "Everyday" }).id;
    const deps = {
      clientId: "id", clientSecret: "secret",
      fetchImpl: fakeGoogle({
        m1: { from: "alerts@axis.bank.in", subject: "INR 600 debited", body: AXIS_ACCOUNT },
      }),
    };

    await fetchGmail(db, actor, deps);
    for (const row of listStaged(db)) approveStaged(db, actor, row.id, { categoryId: category });

    const second = await fetchGmail(db, actor, deps);
    assert.equal(second.alerts.staged, 0);
    assert.equal(listStaged(db).length, 0);
    const tx = queryAll<{ source: string }>(
      db, `SELECT source FROM transactions WHERE account_id = ? AND deleted_at IS NULL`, bank.id,
    );
    assert.deepEqual(tx.map((t) => t.source), ["email"]);
    db.close();
  });
});
