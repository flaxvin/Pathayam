import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { readDocument, expandObjectStreams } from "./objects.ts";
import { decryptDocument, isEncrypted, WrongPassword } from "./decrypt.ts";
import { extractText } from "./text.ts";
import { FIXTURES, CAS_PASSWORD } from "./fixtures.test-data.ts";

function read(bytes: Uint8Array, password: string): string {
  const doc = readDocument(bytes);
  if (isEncrypted(doc)) decryptDocument(doc, password);
  expandObjectStreams(doc);
  return extractText(doc);
}

describe("the PDF reader · every encryption a statement arrives in", () => {
  const cases = [
    ["no encryption", FIXTURES.plain],
    ["RC4 40-bit", FIXTURES.rc4_40],
    ["RC4 128-bit", FIXTURES.rc4_128],
    ["AES-128", FIXTURES.aes_128],
    ["AES-256", FIXTURES.aes_256],
  ] as const;

  for (const [label, bytes] of cases) {
    test(`opens a ${label} statement`, () => {
      const text = read(bytes, CAS_PASSWORD);
      assert.match(text, /Consolidated Account Statement/);
      assert.match(text, /HDFC Liquid Fund - Direct Plan - Growth Option/);
      assert.match(text, /INF179K01XQ0/);
    });
  }

  test("the wrong password is refused, not turned into noise", () => {
    // The failure that matters: a wrong key produces garbage that would
    // otherwise parse as an empty statement and look like a successful
    // import of nothing.
    for (const [label, bytes] of cases) {
      if (label === "no encryption") continue;
      assert.throws(
        () => read(bytes, "not-the-password"),
        WrongPassword,
        `${label} accepted a wrong password`,
      );
    }
  });

  test("an unencrypted file ignores the password entirely", () => {
    assert.match(read(FIXTURES.plain, "anything at all"), /CDSL Ventures Limited/);
  });
});

describe("the PDF reader · layout survives extraction", () => {
  test("columns stay separated, so a table is still a table", () => {
    const text = read(FIXTURES.aes_256, CAS_PASSWORD);
    const row = text.split("\n").find((l) => l.startsWith("05-Apr-2026"));
    assert.ok(row, "the first transaction row should be on its own line");

    // Without positional layout this reads "Purchase25,000.00312.500" and no
    // parser can recover the columns.
    const columns = row!.split(/\s{2,}/);
    assert.deepEqual(columns, [
      "05-Apr-2026", "Purchase", "25,000.00", "312.500", "80.0000", "312.500",
    ]);
  });

  test("lines come out in reading order, top to bottom", () => {
    const lines = read(FIXTURES.rc4_128, CAS_PASSWORD).split("\n");
    const heading = lines.findIndex((l) => l.includes("HDFC Asset Management"));
    const folio = lines.findIndex((l) => l.includes("Folio No: 12345678"));
    const icici = lines.findIndex((l) => l.includes("ICICI Prudential Asset"));
    assert.ok(heading >= 0 && folio > heading && icici > folio);
  });
});

describe("the PDF reader · a file that decompresses without end", () => {
  /*
   * Flate twice over 64 MB of spaces is a few hundred bytes of PDF, and a page
   * may list the same content stream as many times as it likes. Decoded in
   * full, this held the (single-threaded) server for minutes and asked for
   * gigabytes — from an upload, or from an attachment Gmail fetch picked up.
   */
  function bomb(megabytes: number, references: number): Uint8Array {
    const inner = deflateSync(Buffer.alloc(megabytes * 1024 * 1024, 0x20), { level: 9 });
    const outer = deflateSync(inner, { level: 9 });
    return new Uint8Array(Buffer.concat([
      Buffer.from(
        `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
        `2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n` +
        `3 0 obj << /Type /Page /Parent 2 0 R /Contents [${"4 0 R ".repeat(references)}] >> endobj\n` +
        `4 0 obj << /Length ${outer.length} /Filter [/FlateDecode /FlateDecode] >>\nstream\n`,
        "latin1",
      ),
      outer,
      Buffer.from(`\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, "latin1"),
    ]));
  }

  test("is read no further than a statement could need", () => {
    const bytes = bomb(64, 64);
    assert.ok(bytes.length < 2048, `the bomb is ${bytes.length} bytes`);
    const started = Date.now();
    read(bytes, "");
    assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
  });
});

/** A hand-written PDF from numbered object bodies, object 1 being the catalog. */
function pdf(objects: string[]): Uint8Array {
  const body = objects.map((o, i) => `${i + 1} 0 obj ${o} endobj\n`).join("");
  return new Uint8Array(Buffer.from(`%PDF-1.4\n${body}trailer << /Root 1 0 R >>\n%%EOF\n`, "latin1"));
}

function stream(dict: string, content: string): string {
  return `<< ${dict} /Length ${content.length} >>\nstream\n${content}\nendstream`;
}

describe("the PDF reader · text drawn inside a form XObject", () => {
  /*
   * CDSL's CAS draws each page as one form XObject and puts no fonts on the
   * page itself. Reading only the page's own content stream gave the footer
   * and nothing else, so every CDSL statement imported as "no folios found".
   */
  test("reads the form's text with the form's own fonts, placed where the page puts it", () => {
    const bytes = pdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /Resources << /XObject << /I0 5 0 R >> /Font << /F1 6 0 R >> >> /Contents 4 0 R >>",
      stream("", "BT /F1 10 Tf 20 760 Td (Statement header) Tj ET q 1 0 0 1 0 -100 cm /I0 Do Q BT /F1 10 Tf 20 600 Td (Page 1 of 1) Tj ET"),
      stream(
        "/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F9 6 0 R >> >>",
        "BT /F9 10 Tf 20 800 Td (INE000A01011) Tj ET",
      ),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]);
    const lines = read(bytes, "").split("\n").map((l) => l.trim());
    // The form's line sits at 800 - 100 = 700: between the header and the footer.
    assert.deepEqual(lines, ["Statement header", "INE000A01011", "Page 1 of 1"]);
  });

  test("a form that draws itself is read a bounded number of times", () => {
    const bytes = pdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /Resources 6 0 R /Contents 4 0 R >>",
      stream("", "/I0 Do"),
      stream("/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources 6 0 R", "BT /F1 10 Tf 20 700 Td (loop) Tj ET /I0 Do /I0 Do"),
      "<< /XObject << /I0 5 0 R >> /Font << /F1 7 0 R >> >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]);
    const started = Date.now();
    const text = read(bytes, "");
    assert.ok(Date.now() - started < 2_000);
    assert.match(text, /loop/);
  });
});
