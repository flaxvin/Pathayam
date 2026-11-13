/**
 * FWD · The forwarding address, end to end through the app: the receiver's
 * signed hand-off to /inbound/email, the checks on the message, Review, the
 * Settings section, locked statements held and retried, and the 90-day purge.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { Actor } from "../core/events.ts";
import type { DB } from "../db/db.ts";
import { execute, queryAll, queryOne } from "../db/db.ts";
import { createAccount } from "../domain/accounts.ts";
import { setIdentity } from "../import/identity.ts";
import { setCardNumberDigits } from "../domain/card-digits.ts";
import { STATEMENTS, STATEMENT_IDENTITY, SBI_CARD_LAST4 } from "../import/statements.test-data.ts";
import { deriveSecretsKey } from "../gmail/secrets.ts";
import { signDkim, keyRecord } from "../mail/dkim-sign.test-data.ts";
import type { TxtResolver } from "../mail/dkim.ts";
import { signInbound, signInboundCheck, SIGNATURE_HEADER, RECIPIENT_HEADER } from "../mail/signature.ts";
import { connect, type Socket } from "node:net";
import { INBOUND_CONCURRENCY } from "../app.ts";
import { freshDb, seedMember, startTestApp, type TestApp, type TestConfigOverrides } from "../web/harness.test-data.ts";
import { addressRow, formatAddress, issueAddress, newToken, tokenFromRecipient } from "./address.ts";
import { purgeForwarded } from "./held.ts";
import { removeMember } from "../auth/sessions.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };
const SECRET = "test-inbound-secret-0123456789abcdef";
const INBOUND = { domain: "in.pathayam.test", route: "hh1", secret: SECRET };

/** One signing key per fictional bank domain, published through a fake resolver. */
const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
function keyFor(domain: string) {
  let pair = keys.get(domain);
  if (!pair) { pair = generateKeyPairSync("rsa", { modulusLength: 2048 }); keys.set(domain, pair); }
  return pair;
}
const resolveTxt: TxtResolver = async (name) => {
  const domain = name.replace(/^s1\._domainkey\./, "");
  const pair = keys.get(domain);
  if (!pair) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return [[keyRecord(pair.publicKey, "rsa-sha256")]];
};

const AXIS_ALERT = `Dear Ravi Kumar,
Amount Debited:
INR 600.00
Account Number:
XX0000
Date & Time:
28-08-26, 00:01:28 IST
Transaction Info:
UPI/P2A/400111222444/KAVYA R PILLAI`;

/** A plain-text bank email as the bank sent it. */
function plainMail(from: string, subject: string, body: string): string {
  return [
    `From: ${from}`, "To: ravi@example.com", `Subject: ${subject}`,
    "Date: Fri, 28 Aug 2026 00:02:00 +0530", "Message-ID: <a1@bank.test>",
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", body.replace(/\n/g, "\r\n"), "",
  ].join("\r\n");
}

/** A statement email carrying one PDF. */
function pdfMail(from: string, pdf: Uint8Array, filename = "statement.pdf"): string {
  const b64 = Buffer.from(pdf).toString("base64").replace(/.{76}/g, "$&\r\n");
  return [
    `From: ${from}`, "To: ravi@example.com", "Subject: Your statement",
    "Date: Mon, 05 Oct 2026 09:00:00 +0530", "Message-ID: <s1@bank.test>",
    "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b1"', "",
    "--b1", "Content-Type: text/plain; charset=utf-8", "", "Your statement is attached.",
    "--b1", `Content-Type: application/pdf; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`, "Content-Transfer-Encoding: base64", "",
    b64, "--b1--", "",
  ].join("\r\n");
}

/** Signed by `domain`, then wrapped the way an automatic forward leaves it: new headers on top. */
function signedAndForwarded(raw: string, domain: string): Uint8Array {
  const signed = Buffer.from(signDkim(raw, { domain, selector: "s1", privateKey: keyFor(domain).privateKey }));
  return new Uint8Array(Buffer.concat([
    Buffer.from("Received: from mail.google.com by mx.pathayam.test\r\nX-Forwarded-To: hh1.x@in.pathayam.test\r\n"),
    signed,
  ]));
}

function setup(): DB {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  return db;
}

async function app(db: DB, config: TestConfigOverrides = {}): Promise<TestApp> {
  return startTestApp(db, {
    memberId: RAVI, resolveTxt,
    config: { inbound: INBOUND, secretsKey: deriveSecretsKey("k".repeat(40)), ...config },
  });
}

/** Hand a message over as the receiver does. */
function handOff(a: TestApp, recipient: string, raw: Uint8Array, secret = SECRET): Promise<Response> {
  return fetch(`${a.baseUrl}/inbound/email`, {
    method: "POST",
    headers: {
      "Content-Type": "message/rfc822",
      [RECIPIENT_HEADER]: recipient,
      [SIGNATURE_HEADER]: signInbound(secret, recipient, raw),
    },
    body: raw,
  });
}

function addressOf(db: DB): string {
  return formatAddress(INBOUND, addressRow(db, RAVI)!.token)!;
}

function staged(db: DB): { account_id: string; raw_narration: string }[] {
  return queryAll(db, "SELECT account_id, raw_narration FROM staged_transactions");
}

function log(db: DB): { outcome: string; signed: number; sender: string; confirmation: string | null }[] {
  return queryAll(db, "SELECT outcome, signed, sender, confirmation FROM forwarded_mail ORDER BY rowid");
}

describe("FWD · the address", () => {
  test("is the route, a 32-character token and the domain, and reads back", () => {
    const token = newToken();
    assert.match(token, /^[a-z2-7]{32}$/);
    assert.notEqual(newToken(), token);
    const address = formatAddress(INBOUND, token)!;
    assert.equal(address, `hh1.${token}@in.pathayam.test`);
    assert.equal(tokenFromRecipient(INBOUND, address.toUpperCase()), token);
    assert.equal(tokenFromRecipient(INBOUND, `hh1.${token}+bank@in.pathayam.test`), token, "a +tag is dropped");
    assert.equal(tokenFromRecipient(INBOUND, `hh2.${token}@in.pathayam.test`), null, "another household's route");
    assert.equal(tokenFromRecipient(INBOUND, `hh1.${token}@other.test`), null);
    assert.equal(tokenFromRecipient({ ...INBOUND, route: "" }, `${token}@in.pathayam.test`), token);
    assert.equal(formatAddress({ domain: null, route: "", secret: null }, token), null);
  });

  test("Settings makes one, replaces it, and turns it off; the event log never holds the token", async () => {
    const db = setup();
    const a = await app(db);
    try {
      let page = await (await a.get("/settings")).text();
      assert.match(page, /Make my forwarding address/);

      assert.equal((await a.post("/forwarding/create")).status, 303);
      const first = addressRow(db, RAVI)!.token;
      page = await (await a.get("/settings")).text();
      assert.ok(page.includes(`hh1.${first}@in.pathayam.test`), "the address is shown");
      assert.match(page, /alerts@axis\.bank\.in/, "the filter's senders come from the import's own list");

      await a.post("/forwarding/create");
      const second = addressRow(db, RAVI)!.token;
      assert.notEqual(second, first);
      const raw = signedAndForwarded(plainMail("alerts@axis.bank.in", "INR 600 debited", AXIS_ALERT), "axis.bank.in");
      assert.equal((await handOff(a, `hh1.${first}@in.pathayam.test`, raw)).status, 404, "the old address is dead");

      await a.post("/forwarding/remove");
      assert.equal(addressRow(db, RAVI), null);
      assert.equal((await handOff(a, `hh1.${second}@in.pathayam.test`, raw)).status, 404);

      const events = queryAll<{ summary: string; after_json: string | null }>(
        db, "SELECT summary, after_json FROM events WHERE entity = 'forwarding'",
      );
      assert.equal(events.length, 3);
      for (const e of events) {
        assert.ok(!`${e.summary}${e.after_json}`.includes(first) && !`${e.summary}${e.after_json}`.includes(second));
      }
      assert.deepEqual(a.failures, []);
    } finally {
      await a.close();
    }
  });

  test("MAIL-6 · a removed member's address stops taking mail, and does not come back with them", async () => {
    const db = setup();
    seedMember(db, "m-meera", "Meera");
    const meera: Actor = { memberId: "m-meera", source: "ui" };
    createAccount(db, meera, {
      name: "Axis Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01", last4: "0000",
    });
    const token = issueAddress(db, meera).token;
    const a = await app(db);
    try {
      const raw = signedAndForwarded(plainMail("alerts@axis.bank.in", "INR 600 debited", AXIS_ALERT), "axis.bank.in");
      removeMember(db, actor, "m-meera");
      assert.equal((await handOff(a, formatAddress(INBOUND, token)!, raw)).status, 404);
      assert.equal(staged(db).length, 0);
      assert.equal(addressRow(db, "m-meera"), null, "removal ends the address");

      // An address left from before this fix is refused too.
      execute(db, "INSERT INTO forwarding_addresses (member_id, token, created_at) VALUES (?,?,?)",
        "m-meera", token, "2026-11-01T00:00:00.000+05:30");
      assert.equal((await handOff(a, formatAddress(INBOUND, token)!, raw)).status, 404);
      assert.equal(staged(db).length, 0);
    } finally {
      await a.close();
    }
  });

  test("Settings says forwarding is not set up when the server has no INBOUND_DOMAIN", async () => {
    const db = setup();
    const a = await app(db, { inbound: { domain: null, route: "", secret: null } });
    try {
      const page = await (await a.get("/settings")).text();
      assert.match(page, /Forwarding is not set up on this server/);
      assert.doesNotMatch(page, /Make my forwarding address/);
      assert.equal((await a.post("/forwarding/create")).status, 422);
    } finally {
      await a.close();
    }
  });
});

describe("FWD · a forwarded alert", () => {
  test("signed by the bank and forwarded by a filter, it lands in Review", async () => {
    const db = setup();
    const bank = createAccount(db, actor, {
      name: "Axis Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01", last4: "0000",
    });
    issueAddress(db, actor);
    const a = await app(db);
    try {
      const raw = signedAndForwarded(plainMail("Axis Bank <alerts@axis.bank.in>", "INR 600 debited", AXIS_ALERT), "axis.bank.in");
      const res = await handOff(a, addressOf(db), raw);
      assert.equal(res.status, 202);
      assert.deepEqual(await res.json(), { outcome: "read" });
      const rows = staged(db);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.account_id, bank.id);
      assert.match(rows[0]!.raw_narration, /KAVYA R PILLAI/);
      assert.deepEqual(log(db).map((l) => [l.outcome, l.signed, l.sender]), [["read", 1, "alerts@axis.bank.in"]]);

      // The same message again — a retried hand-off — imports nothing twice.
      assert.equal((await handOff(a, addressOf(db), raw)).status, 202);
      assert.equal(staged(db).length, 1);
      assert.ok(addressRow(db, RAVI)!.last_received_at);
    } finally {
      await a.close();
    }
  });

  test("without the bank's signature, or signed by somebody else, nothing is imported", async () => {
    const db = setup();
    createAccount(db, actor, {
      name: "Axis Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01", last4: "0000",
    });
    issueAddress(db, actor);
    const a = await app(db);
    try {
      const mail = plainMail("alerts@axis.bank.in", "INR 600 debited", AXIS_ALERT);
      assert.equal((await handOff(a, addressOf(db), new Uint8Array(Buffer.from(mail)))).status, 202);
      // A forger signing with their own domain's key: valid, but not the bank's.
      assert.equal((await handOff(a, addressOf(db), signedAndForwarded(mail, "forger.test"))).status, 202);
      // The bank's signature, with the amount changed after signing.
      const tampered = Buffer.from(signedAndForwarded(mail, "axis.bank.in")).toString("latin1").replace("600.00", "6000.00");
      assert.equal((await handOff(a, addressOf(db), new Uint8Array(Buffer.from(tampered, "latin1")))).status, 202);

      assert.equal(staged(db).length, 0);
      assert.deepEqual(log(db).map((l) => l.outcome), ["unsigned", "unsigned", "unsigned"]);
      const page = await (await a.get("/settings")).text();
      assert.match(page, /Signature did not check out/);
    } finally {
      await a.close();
    }
  });

  test("MAIL-1 · a signature that covers only part of the body (l=) does not vouch for what follows", async () => {
    const db = setup();
    createAccount(db, actor, {
      name: "Axis Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01", last4: "0000",
    });
    issueAddress(db, actor);
    const a = await app(db);
    try {
      // The bank signed only its greeting; everything after it is anybody's.
      const mail = plainMail("alerts@axis.bank.in", "INR 600 debited", "Dear Ravi Kumar,\n");
      const signed = Buffer.from(signDkim(mail, {
        domain: "axis.bank.in", selector: "s1", privateKey: keyFor("axis.bank.in").privateKey, extraTags: { l: "18" },
      })).toString("latin1");
      const forged = signed + AXIS_ALERT.replace(/\n/g, "\r\n").replace("Dear Ravi Kumar,\r\n", "") + "\r\n";
      assert.equal((await handOff(a, addressOf(db), new Uint8Array(Buffer.from(forged, "latin1")))).status, 202);
      assert.equal(staged(db).length, 0, "the appended alert was not imported");
      assert.deepEqual(log(db).map((l) => [l.outcome, l.signed]), [["unsigned", 0]]);
    } finally {
      await a.close();
    }
  });

  test("MAIL-2 · a second Subject or From added above the bank's signed one is not trusted", async () => {
    const db = setup();
    createAccount(db, actor, {
      name: "Axis Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01", last4: "0000",
    });
    issueAddress(db, actor);
    const a = await app(db);
    try {
      const genuine = Buffer.from(signedAndForwarded(plainMail("alerts@axis.bank.in", "INR 600 debited", AXIS_ALERT), "axis.bank.in"));
      // DKIM checks the bottom-most Subject (the bank's); the reader took the first one.
      const extraSubject = Buffer.concat([Buffer.from("Subject: INR 90,000 debited to FRAUDSTER\r\n"), genuine]);
      assert.equal((await handOff(a, addressOf(db), new Uint8Array(extraSubject))).status, 202);
      const extraFrom = Buffer.concat([Buffer.from("From: alerts@axis.bank.in\r\n"), genuine]);
      assert.equal((await handOff(a, addressOf(db), new Uint8Array(extraFrom))).status, 202);
      assert.equal(staged(db).length, 0);
      assert.deepEqual(log(db).map((l) => l.outcome), ["unsigned", "unsigned"]);
      // The same message as the bank sent it still reads.
      assert.equal((await handOff(a, addressOf(db), new Uint8Array(genuine))).status, 202);
      assert.equal(staged(db).length, 1);
    } finally {
      await a.close();
    }
  });

  test("IMPORT-3 · two identical spends on one day, forwarded as two alerts, are two rows", async () => {
    const db = setup();
    createAccount(db, actor, {
      name: "HDFC Card", kind: "credit", subtype: "credit-card", openingDate: "2026-08-01", last4: "1111", institution: "HDFC Bank",
    });
    issueAddress(db, actor);
    const a = await app(db);
    try {
      const alert = (time: string) =>
        `Dear Card Member,\nRs. 99.00 has been debited from your HDFC Bank Credit Card ending 1111 ` +
        `towards SWIGGY INSTAMART on 31 Aug, 2026 at ${time}.`;
      const mail = (id: string, time: string) => signedAndForwarded(
        plainMail("alerts@hdfcbank.bank.in", "Rs.99 debited", alert(time)).replace("<a1@bank.test>", `<${id}@bank.test>`),
        "hdfcbank.bank.in",
      );
      const first = mail("m1", "09:10:00");
      assert.equal((await handOff(a, addressOf(db), first)).status, 202);
      assert.equal((await handOff(a, addressOf(db), mail("m2", "21:40:00"))).status, 202);
      assert.equal(staged(db).length, 2, "the second order is not taken for the first");
      // The same message handed over again is still one row.
      assert.equal((await handOff(a, addressOf(db), first)).status, 202);
      assert.equal(staged(db).length, 2);
    } finally {
      await a.close();
    }
  });

  test("IMPORT-2 · lines slipped among the bank's headers are not read as its message", async () => {
    const db = setup();
    createAccount(db, actor, {
      name: "Axis Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01", last4: "0000",
    });
    issueAddress(db, actor);
    const a = await app(db);
    try {
      const genuine = Buffer.from(signedAndForwarded(
        plainMail("alerts@axis.bank.in", "INR 600 debited", AXIS_ALERT), "axis.bank.in",
      )).toString("latin1");
      /*
       * DKIM reads "Amount Debited: …" as one more (unsigned) header field. The
       * mail reader stopped its headers at the first name with a space in it
       * and read everything after — these lines included — as the message.
       */
      const injected = "Amount Debited: INR 90,000.00\r\nAccount Number: XX0000\r\n" +
        "Date & Time: 01-11-26, 10:00:00 IST\r\nTransaction Info: FRAUDSTER\r\n";
      const forged = genuine.replace("To: ravi@example.com\r\n", `To: ravi@example.com\r\n${injected}`);
      assert.notEqual(forged, genuine);
      assert.equal((await handOff(a, addressOf(db), new Uint8Array(Buffer.from(forged, "latin1")))).status, 202);
      const rows = staged(db);
      assert.ok(!rows.some((r) => /FRAUDSTER/.test(r.raw_narration)), "the injected alert was not imported");
      // What the bank signed is still the bank's alert, and only that is read.
      assert.deepEqual(rows.map((r) => r.raw_narration), ["UPI/P2A/400111222444/KAVYA R PILLAI"]);
    } finally {
      await a.close();
    }
  });

  test("MAIL-4 · when the bank's key cannot be looked up just now, the sender is asked to retry, not told it was forged", async () => {
    const db = setup();
    createAccount(db, actor, {
      name: "Axis Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01", last4: "0000",
    });
    issueAddress(db, actor);
    let dnsDown = true;
    const flaky: TxtResolver = async (name) => {
      if (dnsDown) throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
      return resolveTxt(name);
    };
    const a = await startTestApp(db, {
      memberId: RAVI, resolveTxt: flaky,
      config: { inbound: INBOUND, secretsKey: deriveSecretsKey("k".repeat(40)) },
    });
    try {
      const raw = signedAndForwarded(plainMail("alerts@axis.bank.in", "INR 600 debited", AXIS_ALERT), "axis.bank.in");
      const res = await handOff(a, addressOf(db), raw);
      assert.equal(res.status, 503, "a temporary answer: the receiver says 451 and the sender tries again");
      assert.equal(log(db).length, 0, "nothing is logged as forged");
      assert.equal(staged(db).length, 0);

      dnsDown = false;
      assert.equal((await handOff(a, addressOf(db), raw)).status, 202);
      assert.equal(staged(db).length, 1, "the retry imports it");
    } finally {
      await a.close();
    }
  });

  test("mail from a sender the import does not read is logged and not opened", async () => {
    const db = setup();
    issueAddress(db, actor);
    const a = await app(db);
    try {
      const raw = signedAndForwarded(plainMail("deals@shop.test", "50% off", "Buy now"), "shop.test");
      assert.equal((await handOff(a, addressOf(db), raw)).status, 202);
      assert.deepEqual(log(db).map((l) => [l.outcome, l.signed]), [["not-a-bank", 1]]);
      assert.equal(staged(db).length, 0);
    } finally {
      await a.close();
    }
  });
});

describe("FWD · the hand-off itself", () => {
  test("a bad signature, a stale one, another route, or no such member is refused", async () => {
    const db = setup();
    issueAddress(db, actor);
    const a = await app(db);
    try {
      const raw = new Uint8Array(Buffer.from(plainMail("alerts@axis.bank.in", "x", AXIS_ALERT)));
      assert.equal((await handOff(a, addressOf(db), raw, "wrong-secret-wrong-secret-wrong-secret")).status, 401);

      // Signed for one recipient, presented for another.
      const res = await fetch(`${a.baseUrl}/inbound/email`, {
        method: "POST",
        headers: {
          [RECIPIENT_HEADER]: addressOf(db),
          [SIGNATURE_HEADER]: signInbound(SECRET, `hh1.${newToken()}@in.pathayam.test`, raw),
        },
        body: raw,
      });
      assert.equal(res.status, 401);

      const stale = await fetch(`${a.baseUrl}/inbound/email`, {
        method: "POST",
        headers: {
          [RECIPIENT_HEADER]: addressOf(db),
          [SIGNATURE_HEADER]: signInbound(SECRET, addressOf(db), raw, new Date(Date.now() - 600_000)),
        },
        body: raw,
      });
      assert.equal(stale.status, 401);

      assert.equal((await handOff(a, `hh1.${newToken()}@in.pathayam.test`, raw)).status, 404);
      assert.equal((await handOff(a, addressOf(db).replace("hh1.", "hh9."), raw)).status, 404);
      assert.equal((await a.get("/inbound/email")).status, 405);
      assert.equal(log(db).length, 0, "nothing refused is logged");
    } finally {
      await a.close();
    }
  });

  test("with the module off it is not there at all; with no secret it says so", async () => {
    const db = setup();
    issueAddress(db, actor);
    const raw = new Uint8Array(Buffer.from(plainMail("alerts@axis.bank.in", "x", AXIS_ALERT)));
    const off = await app(db, { features: { forwarding: false } });
    try {
      assert.equal((await handOff(off, addressOf(db), raw)).status, 404);
      assert.equal((await off.post("/forwarding/create")).status, 404);
      assert.doesNotMatch(await (await off.get("/settings")).text(), /Forwarding address/);
    } finally {
      await off.close();
    }
    const unset = await app(db, { inbound: { domain: "in.pathayam.test", route: "hh1", secret: null } });
    try {
      assert.equal((await handOff(unset, addressOf(db), raw)).status, 503);
    } finally {
      await unset.close();
    }
  });
});

/**
 * Sends a hand-off's headers and `sent` bytes of a body declared to be
 * `declared` long, and gives the status line if one arrives within `ms`, or
 * null if the server sat waiting for the rest. The socket is handed back so a
 * test can hold the request open.
 */
function partialHandOff(
  baseUrl: string, headers: Record<string, string>, declared: number, sent: number, ms = 1500,
): { status: Promise<number | null>; socket: Socket } {
  const { hostname, port } = new URL(baseUrl);
  const socket = connect(Number(port), hostname);
  const status = new Promise<number | null>((resolve) => {
    let buffer = "";
    const timer = setTimeout(() => resolve(null), ms);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buffer);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    socket.on("error", () => { clearTimeout(timer); resolve(null); });
  });
  const all = { Host: `${hostname}:${port}`, "Content-Type": "message/rfc822", "Content-Length": String(declared), ...headers };
  socket.write(
    `POST /inbound/email HTTP/1.1\r\n${Object.entries(all).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n${"x".repeat(sent)}`,
  );
  return { status, socket };
}

describe("MAIL-7 · the hand-off is not read for somebody who cannot be the receiver", () => {
  test("a missing, malformed or stale signature is refused before the body is read", async () => {
    const db = setup();
    issueAddress(db, actor);
    const a = await app(db);
    const sockets: Socket[] = [];
    try {
      const big = 20 * 1024 * 1024;
      const stale = signInbound(SECRET, addressOf(db), new Uint8Array(0), new Date(Date.now() - 600_000));
      const future = signInbound(SECRET, addressOf(db), new Uint8Array(0), new Date(Date.now() + 600_000));
      const cases: [string, Record<string, string>][] = [
        ["missing", { [RECIPIENT_HEADER]: addressOf(db) }],
        ["malformed", { [RECIPIENT_HEADER]: addressOf(db), [SIGNATURE_HEADER]: "t=1,v1=nothex" }],
        ["no time", { [RECIPIENT_HEADER]: addressOf(db), [SIGNATURE_HEADER]: `v1=${"a".repeat(64)}` }],
        ["stale", { [RECIPIENT_HEADER]: addressOf(db), [SIGNATURE_HEADER]: stale }],
        ["from the future", { [RECIPIENT_HEADER]: addressOf(db), [SIGNATURE_HEADER]: future }],
      ];
      for (const [name, headers] of cases) {
        const { status, socket } = partialHandOff(a.baseUrl, headers, big, 1024);
        sockets.push(socket);
        assert.equal(await status, 401, `${name}: the server waited for 20 MiB from somebody without a signature`);
      }
      assert.equal(log(db).length, 0);
    } finally {
      for (const s of sockets) s.destroy();
      await a.close();
    }
  });

  test(`at most ${INBOUND_CONCURRENCY} hand-offs are read at once; one more is told to come back (503)`, async () => {
    const db = setup();
    issueAddress(db, actor);
    const a = await app(db);
    const held: Socket[] = [];
    try {
      // Fresh-looking signatures, bodies that never finish arriving.
      const headers = {
        [RECIPIENT_HEADER]: addressOf(db),
        [SIGNATURE_HEADER]: signInbound(SECRET, addressOf(db), new Uint8Array(0)),
      };
      for (let i = 0; i < INBOUND_CONCURRENCY; i++) {
        const { status, socket } = partialHandOff(a.baseUrl, headers, 1024 * 1024, 100, 300);
        held.push(socket);
        assert.equal(await status, null, "a slow hand-off is waited for");
      }
      const raw = new Uint8Array(Buffer.from(plainMail("alerts@axis.bank.in", "x", AXIS_ALERT)));
      const busy = await handOff(a, addressOf(db), raw);
      assert.equal(busy.status, 503);
      assert.ok(busy.headers.get("retry-after"));
      assert.equal(log(db).length, 0, "the refused one was not read");

      // The slow ones go away; their places are given back.
      for (const s of held) s.destroy();
      let status = 0;
      for (let i = 0; i < 50 && status !== 202; i++) {
        await new Promise((r) => setTimeout(r, 20));
        status = (await handOff(a, addressOf(db), raw)).status;
      }
      assert.equal(status, 202);
    } finally {
      for (const s of held) s.destroy();
      await a.close();
    }
  });
});

describe("MAIL-9 · the receiver's question at RCPT time", () => {
  function ask(a: TestApp, recipient: string, signature?: string): Promise<Response> {
    return fetch(`${a.baseUrl}/inbound/check`, {
      method: "POST",
      headers: {
        [RECIPIENT_HEADER]: recipient,
        ...(signature === undefined ? {} : { [SIGNATURE_HEADER]: signature }),
      },
    });
  }

  test("a signed question is answered known or not; an unsigned one learns nothing", async () => {
    const db = setup();
    issueAddress(db, actor);
    const a = await app(db);
    try {
      const mine = addressOf(db);
      const plus = mine.replace("@", "+hdfc@");
      const nobody = `hh1.${newToken()}@${INBOUND.domain}`;
      const known = async (r: string) => {
        const res = await ask(a, r, signInboundCheck(SECRET, r));
        assert.equal(res.status, 200, r);
        return ((await res.json()) as { known: boolean }).known;
      };
      assert.equal(await known(mine), true);
      assert.equal(await known(plus), true);
      assert.equal(await known(nobody), false);
      assert.equal(await known(mine.replace("hh1.", "hh9.")), false, "another household's route");

      // Without the secret, a real address and a made-up one get the same answer.
      for (const r of [mine, nobody]) {
        assert.equal((await ask(a, r)).status, 401);
        assert.equal((await ask(a, r, signInboundCheck("not-the-secret-not-the-secret", r))).status, 401);
        assert.equal((await ask(a, r, signInboundCheck(SECRET, r, new Date(Date.now() - 600_000)))).status, 401);
      }
      // A question's signature is not a hand-off's, nor the other way round.
      const asHandOff = signInbound(SECRET, mine, new Uint8Array(0));
      assert.equal((await ask(a, mine, asHandOff)).status, 401);
      const res = await fetch(`${a.baseUrl}/inbound/email`, {
        method: "POST",
        headers: { [RECIPIENT_HEADER]: mine, [SIGNATURE_HEADER]: signInboundCheck(SECRET, mine) },
        body: new Uint8Array(0),
      });
      assert.equal(res.status, 401);
      // Signed for one address, asked about another.
      assert.equal((await ask(a, mine, signInboundCheck(SECRET, nobody))).status, 401);
    } finally {
      await a.close();
    }
  });

  test("a removed member's address, or one turned off, is not known", async () => {
    const db = setup();
    issueAddress(db, actor);
    const mine = addressOf(db);
    const a = await app(db);
    try {
      execute(db, "DELETE FROM forwarding_addresses WHERE member_id = ?", RAVI);
      const res = await ask(a, mine, signInboundCheck(SECRET, mine));
      assert.deepEqual(await res.json(), { known: false });
    } finally {
      await a.close();
    }
  });

  test("with the module off it is not there; with no secret it says so", async () => {
    const db = setup();
    issueAddress(db, actor);
    const mine = addressOf(db);
    const off = await app(db, { features: { forwarding: false } });
    try {
      assert.equal((await ask(off, mine, signInboundCheck(SECRET, mine))).status, 404);
    } finally {
      await off.close();
    }
    const unset = await app(db, { inbound: { domain: "in.pathayam.test", route: "hh1", secret: null } });
    try {
      assert.equal((await ask(unset, mine, signInboundCheck(SECRET, mine))).status, 503);
    } finally {
      await unset.close();
    }
  });
});

describe("FWD · Gmail's confirmation", () => {
  test("its code is shown on Settings, and only Google's own signed message counts", async () => {
    const db = setup();
    issueAddress(db, actor);
    const a = await app(db);
    try {
      const body = "Confirmation code: 512345678\n\nTo allow, click https://mail-settings.google.com/mail/vf-abc123-xyz\n";
      const subject = "(#512345678) Gmail Forwarding Confirmation - Receive Mail from ravi@example.com";
      // Unsigned first: a forger's code is not shown.
      const forged = new Uint8Array(Buffer.from(plainMail("forwarding-noreply@google.com", subject, body)));
      await handOff(a, addressOf(db), forged);
      assert.doesNotMatch(await (await a.get("/settings")).text(), /id="forwarding-confirmation"/);
      assert.equal(log(db)[0]!.outcome, "not-a-bank");

      const raw = signedAndForwarded(plainMail("Gmail Team <forwarding-noreply@google.com>", subject, body), "google.com");
      assert.equal((await handOff(a, addressOf(db), raw)).status, 202);
      const page = await (await a.get("/settings")).text();
      assert.match(page, /id="forwarding-confirmation"[\s\S]*512345678/);
      assert.match(page, /mail-settings\.google\.com\/mail\/vf-abc123-xyz/);
      assert.equal(log(db).at(-1)!.confirmation, "512345678");
    } finally {
      await a.close();
    }
  });
});

describe("FWD · a locked statement", () => {
  function sbiCardSetup(): { db: DB; accountId: string } {
    const db = setup();
    setIdentity(db, actor, STATEMENT_IDENTITY);
    const accountId = createAccount(db, actor, {
      name: "SBI Card", kind: "credit", subtype: "credit-card", openingDate: "2026-08-01", institution: "SBI Card",
    }).id;
    issueAddress(db, actor);
    return { db, accountId };
  }
  const batches = (db: DB) =>
    queryOne<{ n: number }>(db, "SELECT count(*) AS n FROM import_batches WHERE source = 'pdf'")!.n;

  test("opens with the details on file, like an upload", async () => {
    const { db, accountId } = sbiCardSetup();
    setCardNumberDigits(db, actor, accountId, SBI_CARD_LAST4);
    const a = await app(db);
    try {
      const raw = signedAndForwarded(pdfMail("SBI Card <statements@sbicard.com>", STATEMENTS.sbiCardEncrypted), "sbicard.com");
      assert.equal((await handOff(a, addressOf(db), raw)).status, 202);
      assert.equal(batches(db), 1);
      assert.equal(log(db)[0]!.outcome, "read");
      assert.equal(queryOne<{ n: number }>(db, "SELECT count(*) AS n FROM forwarded_statements")!.n, 0);
    } finally {
      await a.close();
    }
  });

  test("is kept sealed when it will not open, and imported by Try again once the digits are in", async () => {
    const { db, accountId } = sbiCardSetup();
    const a = await app(db);
    try {
      const raw = signedAndForwarded(pdfMail("SBI Card <statements@sbicard.com>", STATEMENTS.sbiCardEncrypted, "sbicard.pdf"), "sbicard.com");
      assert.equal((await handOff(a, addressOf(db), raw)).status, 202);
      assert.equal(batches(db), 0);
      assert.equal(log(db)[0]!.outcome, "held");
      const held = queryAll<{ sealed: string; filename: string }>(db, "SELECT sealed, filename FROM forwarded_statements");
      assert.equal(held.length, 1);
      assert.match(held[0]!.sealed, /^v1:/, "sealed, not the PDF");
      assert.ok(!held[0]!.sealed.includes(Buffer.from(STATEMENTS.sbiCardEncrypted).toString("base64").slice(0, 40)));

      let page = await (await a.get("/settings")).text();
      assert.match(page, /Locked statements waiting/);
      assert.match(page, /sbicard\.pdf/);

      // Still locked: it stays.
      let res = await a.post("/forwarding/retry");
      assert.match(new URL(res.headers.get("location")!, a.baseUrl).searchParams.get("notice")!, /still locked/);
      assert.equal(queryAll(db, "SELECT id FROM forwarded_statements").length, 1);

      setCardNumberDigits(db, actor, accountId, SBI_CARD_LAST4);
      res = await a.post("/forwarding/retry");
      assert.match(new URL(res.headers.get("location")!, a.baseUrl).searchParams.get("notice")!, /Opened 1 statement/);
      assert.equal(batches(db), 1);
      assert.equal(queryAll(db, "SELECT id FROM forwarded_statements").length, 0, "deleted once it opened");
      page = await (await a.get("/settings")).text();
      assert.doesNotMatch(page, /Locked statements waiting/);
      assert.deepEqual(a.failures, []);
    } finally {
      await a.close();
    }
  });

  test("MAIL-3 · Try again keeps one that opens but has no single account to go to", async () => {
    const { db, accountId } = sbiCardSetup();
    // A second SBI card: the statement opens but cannot pick between them.
    createAccount(db, actor, {
      name: "SBI Card 2", kind: "credit", subtype: "credit-card", openingDate: "2026-08-01", institution: "SBI Card",
    });
    const a = await app(db);
    try {
      const raw = signedAndForwarded(pdfMail("SBI Card <statements@sbicard.com>", STATEMENTS.sbiCardEncrypted, "sbicard.pdf"), "sbicard.com");
      assert.equal((await handOff(a, addressOf(db), raw)).status, 202);
      assert.equal(queryAll(db, "SELECT id FROM forwarded_statements").length, 1);

      setCardNumberDigits(db, actor, accountId, SBI_CARD_LAST4);
      const res = await a.post("/forwarding/retry");
      const notice = new URL(res.headers.get("location")!, a.baseUrl).searchParams.get("notice")!;
      assert.equal(batches(db), 0);
      assert.equal(queryAll(db, "SELECT id FROM forwarded_statements").length, 1, "kept: it arrived once and has not been imported");
      assert.match(notice, /no single account/);
      assert.deepEqual(a.failures, []);
    } finally {
      await a.close();
    }
  });

  test("is not kept without SECRETS_KEY, and the log says so", async () => {
    const { db } = sbiCardSetup();
    const a = await app(db, { secretsKey: null });
    try {
      const raw = signedAndForwarded(pdfMail("statements@sbicard.com", STATEMENTS.sbiCardEncrypted), "sbicard.com");
      assert.equal((await handOff(a, addressOf(db), raw)).status, 202);
      assert.equal(queryAll(db, "SELECT id FROM forwarded_statements").length, 0);
      const row = queryOne<{ outcome: string; detail: string }>(db, "SELECT outcome, detail FROM forwarded_mail")!;
      assert.equal(row.outcome, "nothing");
      assert.match(row.detail, /SECRETS_KEY/);
    } finally {
      await a.close();
    }
  });

  test("can be deleted by its member", async () => {
    const { db } = sbiCardSetup();
    const a = await app(db);
    try {
      await handOff(a, addressOf(db), signedAndForwarded(pdfMail("statements@sbicard.com", STATEMENTS.sbiCardEncrypted), "sbicard.com"));
      const { id } = queryOne<{ id: string }>(db, "SELECT id FROM forwarded_statements")!;
      assert.equal((await a.post(`/forwarding/held/${id}/delete`)).status, 303);
      assert.equal(queryAll(db, "SELECT id FROM forwarded_statements").length, 0);
      assert.equal((await a.post(`/forwarding/held/${id}/delete`)).status, 404);
    } finally {
      await a.close();
    }
  });
});

describe("FWD-4 · nothing forwarded outlives 90 days", () => {
  test("the purge removes the log and held statements older than that, and nothing newer", () => {
    const db = setup();
    const old = "2026-07-01T10:00:00.000+05:30";
    const recent = "2026-10-20T10:00:00.000+05:30";
    for (const [id, at] of [["f-old", old], ["f-new", recent]] as const) {
      execute(db, `INSERT INTO forwarded_mail (id, member_id, received_at, sender, subject, signed, outcome)
                   VALUES (?,?,?,?,?,?,?)`, id, RAVI, at, "alerts@axis.bank.in", "x", 1, "read");
      execute(db, `INSERT INTO forwarded_statements (id, member_id, received_at, sender, filename, sealed)
                   VALUES (?,?,?,?,?,?)`, `s${id}`, RAVI, at, "statements@sbicard.com", "a.pdf", "v1:x");
    }
    assert.equal(purgeForwarded(db, new Date("2026-11-08T00:00:00Z")), 2);
    assert.deepEqual(queryAll<{ id: string }>(db, "SELECT id FROM forwarded_mail").map((r) => r.id), ["f-new"]);
    assert.deepEqual(queryAll<{ id: string }>(db, "SELECT id FROM forwarded_statements").map((r) => r.id), ["sf-new"]);
  });
});

describe("FWD · from SMTP to Review", () => {
  /** Speak just enough SMTP to deliver one message, returning every reply line. */
  async function sendSmtp(port: number, rcpt: string, raw: Uint8Array): Promise<string[]> {
    const { connect } = await import("node:net");
    const socket = connect(port, "127.0.0.1");
    const replies: string[] = [];
    let buffer = "";
    let waiting: (() => void) | null = null;
    socket.on("data", (d) => {
      buffer += d.toString("latin1");
      let i;
      while ((i = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        replies.push(line);
        // A final reply line has a space after the code; continuation lines a hyphen.
        if (/^\d{3} /.test(line) && waiting) { const w = waiting; waiting = null; w(); }
      }
    });
    const reply = () => new Promise<void>((ok) => { waiting = ok; });
    const say = async (line: string | Buffer) => { const r = reply(); socket.write(line); await r; };
    await reply();
    await say("EHLO forwarder.test\r\n");
    await say("MAIL FROM:<bounce@forwarder.test>\r\n");
    await say(`RCPT TO:<${rcpt}>\r\n`);
    // MAIL-9 · An address the app does not know is refused here, before any data.
    if (replies.at(-1)?.startsWith("5")) {
      await say("QUIT\r\n");
      socket.destroy();
      return replies;
    }
    await say("DATA\r\n");
    const body = Buffer.from(raw).toString("latin1").replace(/^\./gm, "..");
    await say(Buffer.from(`${body}${body.endsWith("\r\n") ? "" : "\r\n"}.\r\n`, "latin1"));
    await say("QUIT\r\n");
    socket.destroy();
    return replies;
  }

  test("a message sent to the receiver is signed over, checked and staged", async () => {
    const { startMx } = await import("../mx/main.ts");
    const db = setup();
    const bank = createAccount(db, actor, {
      name: "Axis Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01", last4: "0000",
    });
    issueAddress(db, actor);
    const a = await app(db);
    const mx = await startMx({
      MX_DOMAIN: INBOUND.domain, MX_PORT: "0",
      MX_ROUTES: JSON.stringify({ hh1: { url: a.baseUrl, secret: SECRET } }),
    }, { log: () => {} });
    try {
      const raw = signedAndForwarded(
        plainMail("Axis Bank <alerts@axis.bank.in>", "INR 600 debited", `${AXIS_ALERT}\n.leading dot line`),
        "axis.bank.in",
      );
      const replies = await sendSmtp(mx.port, addressOf(db), raw);
      assert.ok(replies.some((r) => r.startsWith("250") && /queued|accepted|ok/i.test(r)), replies.join("\n"));
      const rows = staged(db);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.account_id, bank.id);
      assert.equal(log(db)[0]!.outcome, "read", "the dot-stuffed body still matched the bank's signature");

      const dead = await sendSmtp(mx.port, `hh1.${newToken()}@${INBOUND.domain}`, raw);
      assert.ok(dead.some((r) => r.startsWith("550 5.1.1")), dead.join("\n"));
      assert.ok(!dead.some((r) => r.startsWith("354")), "refused at RCPT, before any data");
    } finally {
      await mx.close(100);
      await a.close();
    }
  });
});
