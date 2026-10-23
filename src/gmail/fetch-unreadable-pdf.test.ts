/**
 * One statement attachment the reader cannot open must not cost the rest of
 * the fetch.
 *
 * Only a wrong password was caught. Any other failure — a PDF protected by a
 * certificate rather than a password, a damaged file — escaped `fetchGmail`
 * before the alerts already read were ingested and before the fetch was
 * marked done. The household saw an error, nothing reached Review, and the
 * same attachment, still inside the search window, failed every fetch after.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, queryAll } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { createAccount } from "../domain/accounts.ts";
import { saveConnection, getConnection } from "./connection.ts";
import { fetchGmail } from "./fetch.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

/** Encrypted with a certificate (public-key) handler, which this app cannot open. */
const CERTIFICATE_PDF =
  "%PDF-1.6\n1 0 obj << /Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s5 /V 4 >> endobj\n" +
  "trailer << /Encrypt 1 0 R >>\n%%EOF\n";

const ALERT = `Dear Ravi Kumar,
Amount Debited:
INR 600.00
Account Number:
XX0000
Date & Time:
28-08-26, 00:01:28 IST
Transaction Info:
UPI/P2A/400111222444/FICTIONAL STORE`;

function fakeGoogle(): typeof fetch {
  const messages: Record<string, { from: string; body: string; pdf?: boolean }> = {
    m1: { from: "statements@axis.bank.in", body: "Your statement is attached.", pdf: true },
    m2: { from: "alerts@axis.bank.in", body: ALERT },
  };
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "at", expires_in: 3600 });
    if (url.includes("/messages?")) return json({ messages: Object.keys(messages).map((id) => ({ id })) });
    if (url.includes("/attachments/")) return json({ data: b64(CERTIFICATE_PDF) });
    const get = /\/messages\/([^/?]+)\?/.exec(url);
    if (get) {
      const msg = messages[get[1]!]!;
      return json({
        id: get[1], internalDate: "1787855489000",
        payload: {
          mimeType: "multipart/alternative",
          headers: [{ name: "From", value: msg.from }, { name: "Subject", value: "Alert" }],
          parts: [
            { mimeType: "text/plain", body: { data: b64(msg.body) } },
            ...(msg.pdf ? [{ mimeType: "application/pdf", filename: "statement.pdf", body: { attachmentId: "a1" } }] : []),
          ],
        },
      });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("Gmail fetch · a statement the reader cannot open", () => {
  test("is noted, and the alerts beside it still reach Review", async () => {
    const db = openDatabase({ path: ":memory:", verbose: false });
    ensureHousehold(db);
    db.prepare("INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)")
      .run("m-ravi", "ravi@example.com", "Ravi", nowIST());
    saveConnection(db, actor, { email: "ravi@example.com", refreshToken: "rt", scope: "gmail.readonly" });
    createAccount(db, actor, {
      name: "Axis Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01", last4: "0000",
    });

    const result = await fetchGmail(db, actor, { clientId: "id", clientSecret: "secret", fetchImpl: fakeGoogle() });

    assert.equal(result.alerts.staged, 1);
    assert.equal(queryAll(db, `SELECT id FROM staged_transactions`).length, 1);
    assert.equal(result.statements.read, 0);
    assert.ok(result.notes.some((n) => /statement\.pdf/.test(n)), result.notes.join("; "));
    assert.ok(getConnection(db, "m-ravi")!.last_fetched_at, "the fetch is marked done");
    db.close();
  });
});
