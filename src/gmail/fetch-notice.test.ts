/**
 * What "Fetch from Gmail" says it did.
 *
 * The notice ended every count with "all in Review": alerts no account of the
 * viewer's matched were "N to an unknown account, all in Review" though
 * nothing was staged for them, and a statement PDF no password opened was not
 * mentioned at all — "nothing new". (The /import notice was corrected the same
 * way for auto-approved rows in an earlier round; this one was not.)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createAccount } from "../domain/accounts.ts";
import { saveConnection } from "./connection.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";
import type { Actor } from "../core/events.ts";
import { FIXTURES } from "../pdf/fixtures.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

const alert = (last4: string) => `Dear Ravi Kumar,
Amount Debited:
INR 600.00
Account Number:
XX${last4}
Date & Time:
28-08-26, 00:01:28 IST
Transaction Info:
UPI/P2A/400111222444/FICTIONAL STORE`;

/** A fake Google: two alerts (one for an account the app has), and a locked statement. */
function fakeGoogle(): typeof fetch {
  const messages: Record<string, { from: string; body: string; pdf?: boolean }> = {
    m1: { from: "alerts@axis.bank.in", body: alert("0000") },
    m2: { from: "alerts@axis.bank.in", body: alert("9999") },
    // A password-protected statement no saved identity opens.
    m3: { from: "statements@axis.bank.in", body: "Your statement is attached.", pdf: true },
  };
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "at", expires_in: 3600 });
    if (url.includes("/messages?")) return json({ messages: Object.keys(messages).map((id) => ({ id })) });
    if (url.includes("/attachments/")) {
      return json({ data: Buffer.from(FIXTURES.aes_256).toString("base64url") });
    }
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

describe("Gmail fetch · the notice says where each message went", () => {
  test("an alert for no account of yours is not said to be in Review, and a locked statement is said", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    saveConnection(db, actor, { email: "ravi@example.com", refreshToken: "rt", scope: "gmail.readonly" });
    createAccount(db, actor, {
      name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01", last4: "0000",
    });
    const app = await startTestApp(db, {
      memberId: "m-ravi", fetchImpl: fakeGoogle(),
      config: { google: { clientId: "id", clientSecret: "secret" } },
    });
    try {
      const res = await app.post("/gmail/fetch", {});
      assert.equal(res.status, 303);
      const notice = new URL(res.headers.get("location")!, "http://x").searchParams.get("notice")!;
      assert.match(notice, /1 alert in Review/);
      assert.doesNotMatch(notice, /all in Review/, notice);
      assert.match(notice, /1 alert .*not imported/, notice);
      assert.match(notice, /1 statement .*could not open/, notice);
    } finally {
      await app.close();
    }
  });
});
