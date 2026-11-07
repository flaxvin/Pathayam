/**
 * IMP-6 · The CSV form's "or upload it" had no file input behind it.
 *
 * The label promised an upload and the form had only a textarea, so an
 * Excel "Unicode text" export (UTF-16) could never arrive at all. A file now
 * goes in as bytes and is decoded here by its byte-order mark — UTF-8,
 * UTF-16LE, UTF-16BE — or as UTF-8 when it has none, with a note when some
 * of it was not UTF-8. Pasting still works, and the form still posts as an
 * ordinary multipart form without any script.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import type { DB } from "../db/db.ts";
import { queryAll } from "../db/db.ts";
import { createAccount } from "../domain/accounts.ts";
import { decodeCsvBytes } from "../import/csv.ts";
import { startTestApp, seedMember, freshDb, type TestApp } from "./harness.test-data.ts";

const CSV = "Date,Narration,Amount\n02-09-2026,CAFÉ KOCHI,-100.00\n";

function utf16(text: string, order: "le" | "be"): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out.set(order === "le" ? [0xff, 0xfe] : [0xfe, 0xff], 0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const [hi, lo] = [code >> 8, code & 0xff];
    out.set(order === "le" ? [lo, hi] : [hi, lo], 2 + i * 2);
  }
  return out;
}

describe("decodeCsvBytes", () => {
  test("a UTF-8 BOM is read as UTF-8 and the mark dropped", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(CSV)]);
    const out = decodeCsvBytes(bytes);
    assert.equal(out.text, CSV);
    assert.equal(out.encoding, "UTF-8");
    assert.equal(out.fellBack, false);
  });

  test("UTF-16 little- and big-endian are read by their marks", () => {
    for (const order of ["le", "be"] as const) {
      const out = decodeCsvBytes(utf16(CSV, order));
      assert.equal(out.text, CSV, order);
      assert.equal(out.encoding, order === "le" ? "UTF-16LE" : "UTF-16BE");
      assert.equal(out.fellBack, false);
    }
  });

  test("no mark is UTF-8; bytes that are not UTF-8 are replaced and say so", () => {
    assert.deepEqual(decodeCsvBytes(new TextEncoder().encode(CSV)),
      { text: CSV, encoding: "UTF-8", fellBack: false });
    // "CAFÉ" as Windows-1252: 0xC9 is not valid UTF-8 on its own.
    const cp1252 = new Uint8Array([...new TextEncoder().encode("CAF"), 0xc9, 0x0a]);
    const out = decodeCsvBytes(cp1252);
    assert.equal(out.encoding, "UTF-8");
    assert.equal(out.fellBack, true);
    assert.equal(out.text, "CAF�\n");
  });
});

describe("the CSV form takes a file", () => {
  let db: DB;
  let app: TestApp;
  let account: string;

  before(async () => {
    db = freshDb();
    seedMember(db, "m", "Ravi");
    const ravi: Actor = { memberId: "m", source: "ui" };
    account = createAccount(db, ravi, {
      name: "Ravi's savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01",
    }).id;
    app = await startTestApp(db, { memberId: "m" });
  });
  after(async () => {
    await app.close();
  });

  async function upload(bytes: Uint8Array, name: string, extra: Record<string, string> = {}) {
    const form = new FormData();
    form.set("account_id", account);
    form.set("csv", "");
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    form.set("csv_file", new Blob([bytes], { type: "text/csv" }), name);
    return app.get("/import", { method: "POST", body: form, headers: { Origin: app.baseUrl } });
  }

  test("the form has a file input, posted as multipart", async () => {
    const page = await (await app.get("/import")).text();
    assert.match(page, /<form method="post" action="\/import" class="card" enctype="multipart\/form-data">/);
    assert.match(page, /<input[^>]+name="csv_file"[^>]+type="file"/);
  });

  test("a UTF-16 Excel export imports, named after its file", async () => {
    const res = await upload(utf16(CSV, "le"), "hdfc-sept.csv");
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get("location") ?? ""), /Read 1 rows/);
    const rows = queryAll<{ narration: string; amount: number }>(
      db, `SELECT raw_narration AS narration, amount FROM staged_transactions`);
    assert.deepEqual(rows.map((r) => [r.narration, r.amount]), [["CAFÉ KOCHI", -10000]]);
    const batch = queryAll<{ file_name: string }>(db, `SELECT file_name FROM import_batches`);
    assert.equal(batch.at(-1)!.file_name, "hdfc-sept.csv");
  });

  test("a file that was not UTF-8 still imports, with a note saying so", async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode("Date,Narration,Amount\n03-09-2026,CAF"), 0xc9,
      ...new TextEncoder().encode(" EDAPPALLY,-50.00\n"),
    ]);
    const res = await upload(bytes, "old-export.csv");
    assert.equal(res.status, 303);
    const location = decodeURIComponent(res.headers.get("location") ?? "");
    assert.match(location, /Read 1 rows/);
    assert.match(location, /not UTF-8/);
  });

  test("pasting still works, and an empty form says what is missing", async () => {
    const pasted = await app.post("/import", {
      account_id: account, csv: "Date,Narration,Amount\n04-09-2026,KIRANA,-75.00",
    });
    assert.equal(pasted.status, 303);
    assert.match(decodeURIComponent(pasted.headers.get("location") ?? ""), /Read 1 rows/);

    const empty = await app.post("/import", { account_id: account, csv: "" });
    assert.equal(empty.status, 200);
    assert.match(await empty.text(), /Paste the CSV or choose its file first/);
    assert.deepEqual(app.failures, []);
  });
});
