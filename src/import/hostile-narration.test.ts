/**
 * Weekly 18-11 · A hostile narration cannot hold the server.
 *
 * A CSV import runs on the thread that answers every request, and is open on
 * the public demo. Reading a narration's merchant, VPA and reference used
 * patterns that backtrack over a long run of one kind of character — digits,
 * dashes, letters with no "@" — so one 40 KB cell of "1111…x" took seconds
 * and a 400 KB one (the upload limit is 12 MB) minutes. Real narrations are
 * a few hundred characters; only the start of one is read for its fields.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { listStaged } from "./pipeline.ts";
import { extractNarrationFields } from "./rules.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };
const N = 40_000;

const hostile: [string, string][] = [
  ["a digit run", "SHOP " + "1".repeat(N) + "x"],
  ["a dash run", "SHOP " + "-".repeat(N) + "x"],
  ["a letter run without @", "SHOP " + "a".repeat(N) + "!"],
  ["a digit run before a mask", "SHOP " + "1".repeat(N) + "XX"],
  ["a mask-character run", "SHOP " + "x".repeat(N) + "!"],
  ["spaced dashes", "SHOP " + "- ".repeat(N / 2) + "x"],
];

describe("weekly 18-11 · hostile narrations", () => {
  test("reading the fields of a long narration takes milliseconds, whatever it is made of", () => {
    for (const [what, narration] of hostile) {
      const started = Date.now();
      extractNarrationFields(narration);
      assert.ok(Date.now() - started < 300, `${what}: ${Date.now() - started} ms`);
    }
    // The fields of an ordinary narration are unchanged.
    assert.deepEqual(extractNarrationFields("UPI/P2M/431202847592/SWIGGY*ORDER"), {
      channel: "UPI", vpa: null, merchant: "Swiggy", reference: "431202847592",
    });
    assert.equal(extractNarrationFields("UPI TRANSFER TO ANITA RAO (500100000001)").merchant, "Transfer To Anita Rao");
    assert.equal(extractNarrationFields("UPI-TEST MERCHANT-9876").merchant, "Test Merchant");
  });

  test("a CSV of such rows is imported, and quickly", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const account = createAccount(db, actor, {
      name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
    });
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const csv = ["Date,Narration,Amount", ...hostile.map(([, n], i) => `0${i + 1}-11-2026,${n},-10.00`)].join("\n");
      const started = Date.now();
      const res = await app.post("/import", { account_id: account.id, file_name: "a.csv", csv });
      assert.ok(res.status < 500, String(res.status));
      assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
      assert.equal(listStaged(db).length, hostile.length);
    } finally {
      await app.close();
    }
  });
});
