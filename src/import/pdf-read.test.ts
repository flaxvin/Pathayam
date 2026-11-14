/**
 * PDF-1 · PDFs are read in a worker: same answers, a deadline, a memory cap,
 * one file at a time, and the server keeps answering while one is read.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { FIXTURES, CAS_PASSWORD } from "../pdf/fixtures.test-data.ts";
import { STATEMENTS, STATEMENT_PASSWORD, SBI_CARD_PASSWORD, HSBC_CARD_PASSWORD } from "./statements.test-data.ts";
import { parseStatementPdf, BANKS } from "./pdf-statements.ts";
import { parseCasPdf, WrongPassword } from "./cas.ts";
import {
  readStatementPdf, readCasPdf, setPdfReadLimits, PdfBusy, PdfReadFailed,
  PDF_READ_DEADLINE_MS, PDF_READ_HEAP_MB, PDF_TOO_SLOW, PDF_TOO_LARGE,
} from "./pdf-read.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

/** IMPORT-6's shape: inside every cap, but ~1.5 s of CPU to read. */
function slowPdf(reps = 1_000_000): Uint8Array {
  const content = deflateSync(Buffer.from("BT /F1 10 Tf 20 760 Td " + "(a) Tj 0 -1 Td ".repeat(reps) + " ET"), { level: 9 });
  const head = "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n" +
    "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n" +
    "4 0 obj << /Length " + content.length + " /Filter /FlateDecode >>\nstream\n";
  return new Uint8Array(Buffer.concat([
    Buffer.from(head, "latin1"), content,
    Buffer.from("\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1"),
  ]));
}

const SLOW = slowPdf();

afterEach(() => setPdfReadLimits({ deadlineMs: PDF_READ_DEADLINE_MS, heapMb: PDF_READ_HEAP_MB }));

describe("PDF-1 · reading in a worker gives the same answers", () => {
  for (const [label, bytes] of Object.entries(FIXTURES)) {
    test(`a CAS (${label}) reads exactly as before`, async () => {
      assert.deepEqual(await readCasPdf(bytes, CAS_PASSWORD), parseCasPdf(bytes, CAS_PASSWORD));
    });
  }

  for (const [label, bytes] of Object.entries(STATEMENTS)) {
    test(`a statement (${label}) reads exactly as before`, async () => {
      const opened = await readStatementPdf(bytes, ["wrong", STATEMENT_PASSWORD, SBI_CARD_PASSWORD, HSBC_CARD_PASSWORD]);
      assert.ok(opened, label);
      const password = /Encrypted$/.test(label) ? opened.candidate : "";
      assert.deepEqual(opened.parse, parseStatementPdf(bytes, password));
      // The profile is the app's own object again, not a copy.
      if (opened.parse.bank) assert.ok(BANKS.includes(opened.parse.bank));
    });
  }

  test("the first candidate that opens it is the one named", async () => {
    const opened = await readStatementPdf(STATEMENTS.hdfcEncrypted, ["a", "b", STATEMENT_PASSWORD, "c"]);
    assert.equal(opened?.candidate, STATEMENT_PASSWORD);
  });

  test("no candidate that opens it is null; a CAS says WrongPassword", async () => {
    assert.equal(await readStatementPdf(STATEMENTS.hdfcEncrypted, ["a", "b"]), null);
    await assert.rejects(readCasPdf(FIXTURES.aes_256, "nope"), WrongPassword);
  });

  test("a file that is not a PDF reads as the reader always read it", async () => {
    const bytes = new TextEncoder().encode("not a pdf at all");
    assert.deepEqual((await readStatementPdf(bytes, [""]))?.parse, parseStatementPdf(bytes, ""));
  });

  test("a reader refusal crosses the thread as a Refusal with its message", async () => {
    // An encryption handler no statement uses (decrypt.ts refuses it by name).
    const pdf = new TextEncoder().encode(
      "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
      "2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n" +
      "3 0 obj << /Filter /Adobe.PubSec /V 4 /R 4 >> endobj\n" +
      "trailer << /Root 1 0 R /Encrypt 3 0 R /ID [<00> <00>] >>\n%%EOF\n");
    let before: Error | null = null;
    try { parseStatementPdf(pdf, "x"); } catch (e) { before = e as Error; }
    assert.ok(before, "the synchronous reader refuses it");
    await assert.rejects(readStatementPdf(pdf, ["x"]), (e: Error) => e.name === before!.name && e.message === before!.message);
  });
});

describe("PDF-1 · a slow, huge or second file", () => {
  test("past the deadline the read is abandoned with a plain answer, and the next one works", async () => {
    setPdfReadLimits({ deadlineMs: 300 });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const started = performance.now();
    await assert.rejects(readStatementPdf(SLOW, [""]), (e: Error) => e instanceof PdfReadFailed && e.message === PDF_TOO_SLOW);
    clearInterval(timer);
    const took = performance.now() - started;
    assert.ok(took < 1_000, `gave up after ${took.toFixed(0)} ms`);
    // This thread kept running timers while the worker chewed.
    assert.ok(ticks >= 5, `only ${ticks} ticks`);
    assert.ok(await readCasPdf(FIXTURES.plain, ""));
  });

  test("a file that needs more memory than the worker has ends the worker, not the server", async () => {
    setPdfReadLimits({ heapMb: 8, deadlineMs: 30_000 });
    await assert.rejects(readStatementPdf(SLOW, [""]), (e: Error) => e instanceof PdfReadFailed && e.message === PDF_TOO_LARGE);
    setPdfReadLimits({ heapMb: PDF_READ_HEAP_MB });
    assert.ok(await readCasPdf(FIXTURES.plain, ""));
  });

  test("an upload while another file is read is told to try again; a background read waits its turn", async () => {
    setPdfReadLimits({ deadlineMs: 30_000 });
    const first = readStatementPdf(SLOW, [""]);
    await assert.rejects(readCasPdf(FIXTURES.plain, ""), PdfBusy);
    await assert.rejects(readStatementPdf(STATEMENTS.hdfc, [""]), (e: Error) =>
      e instanceof PdfBusy && /Another statement is being read, try again in a moment/.test(e.message));
    const waited = readStatementPdf(STATEMENTS.hdfc, [""], { wait: true });
    const [a, b] = await Promise.all([first, waited]);
    assert.ok(a);
    assert.deepEqual(b?.parse, parseStatementPdf(STATEMENTS.hdfc, ""));
    // And it is free again.
    assert.ok(await readCasPdf(FIXTURES.plain, ""));
  });
});

describe("PDF-1 · over HTTP", () => {
  const actor: Actor = { memberId: "m", source: "ui" };

  test("while a slow upload is read the server answers at once; a second upload is 503; the slow one is told it took too long", async () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    const bank = createAccount(db, actor, {
      name: "Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01", institution: "HDFC Bank",
    });
    const app = await startTestApp(db, { memberId: "m" });
    setPdfReadLimits({ deadlineMs: 800 });
    const post = (pdf: Uint8Array) => {
      const form = new FormData();
      form.set("account_id", bank.id);
      form.set("statement", new Blob([pdf], { type: "application/pdf" }), "statement.pdf");
      return app.get("/import/pdf", { method: "POST", body: form, headers: { Origin: app.baseUrl } });
    };
    try {
      const slow = post(SLOW);
      // Let the slow upload reach the reader.
      await new Promise((r) => setTimeout(r, 150));
      const t = performance.now();
      const health = await app.get("/healthz");
      const healthMs = performance.now() - t;
      assert.equal(health.status, 200);
      assert.ok(healthMs < 300, `/healthz took ${healthMs.toFixed(0)} ms`);

      const second = await post(STATEMENTS.hdfc);
      assert.equal(second.status, 503);
      assert.equal(second.headers.get("retry-after"), "5");
      assert.match(await second.text(), /Another statement is being read, try again in a moment/);

      const res = await slow;
      assert.equal(res.status, 200);
      assert.match(await res.text(), /This PDF took too long to read/);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});

describe("PDF-1 · mail (Gmail fetch, forwarding, held retries)", () => {
  test("a mailed statement waits for an upload being read, then is read; one past the deadline is a note, not held", async () => {
    const { startMailIngest, emptyFetchResult } = await import("../gmail/fetch.ts");
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    const actor: Actor = { memberId: "m", source: "import" };
    const result = emptyFetchResult();
    const locked: string[] = [];
    const run = startMailIngest(db, actor, result, { onLocked: (pdf) => locked.push(pdf.filename) });
    const mail = (filename: string, bytes: Uint8Array) => run.message({
      sender: "hdfcbanksmartstatement@hdfcbank.bank.in", subject: "Statement", received: "2026-11-01",
      body: () => "", pdfs: [{ filename, load: async () => bytes }],
    });

    setPdfReadLimits({ deadlineMs: 30_000 });
    const upload = readStatementPdf(SLOW, [""]);
    await mail("waited.pdf", STATEMENTS.hdfc);
    await upload;
    assert.equal(result.statements.read, 1, result.notes.join("; "));

    setPdfReadLimits({ deadlineMs: 300 });
    await mail("slow.pdf", SLOW);
    run.finish();
    assert.equal(result.statements.locked, 1);
    assert.ok(result.notes.some((n) => n.startsWith("Could not open slow.pdf: This PDF took too long to read")), result.notes.join("; "));
    assert.deepEqual(locked, [], "a slow file is not a locked one");
  });
});
