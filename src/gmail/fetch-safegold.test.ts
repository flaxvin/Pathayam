/**
 * IMP-33 · A SafeGold statement fetched from Gmail is read, not left unmatched.
 *
 * estatements@safegold.in was a known sender with no bank and no reader, so
 * every statement it mailed was opened and then counted "for no single
 * account of yours, not imported". It is now read as gold and taken to the
 * same review an upload gets — nothing is recorded until it is confirmed.
 * The statement is synthetic.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import type { DB } from "../db/db.ts";
import { queryAll } from "../db/db.ts";
import { fetchGmail } from "./fetch.ts";
import { saveConnection } from "./connection.ts";
import { statement, TWO_ROWS, safeGoldPdf } from "../import/safegold.test-data.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

/** A fake Google holding `count` SafeGold statement emails, each with the same PDF. */
function fakeGoogle(pdf: Uint8Array, count = 1): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "at", expires_in: 3600 });
    if (url.includes("/messages?")) {
      return json({ messages: Array.from({ length: count }, (_, i) => ({ id: `g${i}` })) });
    }
    if (url.includes("/attachments/")) return json({ data: Buffer.from(pdf).toString("base64url") });
    const m = /\/messages\/(g\d+)\?/.exec(url);
    if (m) {
      return json({
        id: m[1], internalDate: "1793500000000",
        payload: {
          mimeType: "multipart/mixed",
          headers: [
            { name: "From", value: "SafeGold <estatements@safegold.in>" },
            { name: "Subject", value: "Your SafeGold statement" },
          ],
          parts: [
            { mimeType: "text/plain", body: { data: b64("Your statement is attached.") } },
            { mimeType: "application/pdf", filename: "statement.pdf", body: { attachmentId: "a1" } },
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
  saveConnection(db, actor, { email: "ravi@example.com", refreshToken: "rt", scope: "gmail.readonly" });
  return db;
}

describe("IMP-33 · SafeGold statements by mail", () => {
  test("the fetch reads it as gold, not as a statement for no account", async () => {
    const db = setup();
    const result = await fetchGmail(db, actor, {
      clientId: "id", clientSecret: "secret", fetchImpl: fakeGoogle(safeGoldPdf(statement(TWO_ROWS))),
    });
    assert.equal(result.statements.unmatched, 0);
    assert.equal(result.statements.read, 1);
    assert.equal(result.gold.statements, 1);
    assert.equal(result.gold.newEntries, 2);
    assert.ok(result.gold.token);
    // Proposed, not recorded.
    assert.equal(queryAll(db, `SELECT id FROM lots`).length, 0);
  });

  test("the same statement mailed twice is one statement's entries", async () => {
    const db = setup();
    const result = await fetchGmail(db, actor, {
      clientId: "id", clientSecret: "secret", fetchImpl: fakeGoogle(safeGoldPdf(statement(TWO_ROWS)), 2),
    });
    assert.equal(result.gold.statements, 2);
    assert.equal(result.gold.newEntries, 2);
  });

  test("Fetch now goes to its review, and confirming it records the gold", async () => {
    const db = setup();
    const app = await startTestApp(db, {
      memberId: "m-ravi", fetchImpl: fakeGoogle(safeGoldPdf(statement(TWO_ROWS))),
      config: { google: { clientId: "id", clientSecret: "secret" } },
    });
    try {
      const res = await app.post("/gmail/fetch", {});
      assert.equal(res.status, 303);
      const location = new URL(res.headers.get("location")!, app.baseUrl);
      assert.equal(location.pathname, "/portfolio/safegold/review");
      assert.match(location.searchParams.get("notice") ?? "", /1 SafeGold statement/);
      assert.doesNotMatch(location.searchParams.get("notice") ?? "", /no single account/);

      const page = await (await app.get(location.pathname + location.search)).text();
      assert.match(page, /0\.7000 g/);
      const token = /name="token" value="([^"]+)"/.exec(page)![1]!;
      const done = await app.post("/portfolio/safegold/confirm", { token });
      assert.equal(done.status, 303);
      assert.equal(queryAll(db, `SELECT id FROM lots`).length, 1);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
