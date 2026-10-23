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

/** A one-page PDF whose page content is `content`, Flate-compressed. */
function onePage(content: string): Uint8Array {
  const c = deflateSync(Buffer.from(content, "latin1"));
  return new Uint8Array(Buffer.concat([
    Buffer.from(
      `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
      `2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n` +
      `3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n` +
      `4 0 obj << /Length ${c.length} /Filter /FlateDecode >>\nstream\n`,
      "latin1",
    ),
    c,
    Buffer.from(`\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, "latin1"),
  ]));
}

describe("the PDF reader · text placed absurdly far apart", () => {
  /*
   * Layout pads each piece out to the column its position implies. A piece
   * placed fifty million units to the right was padded with a hundred million
   * spaces, on every line that did it: a few hundred bytes of PDF asked for
   * gigabytes of string and never came back.
   */
  test("is padded no further than a page could be wide", () => {
    let content = "";
    for (let i = 0; i < 20; i++) {
      content += `BT /F1 1 Tf 1 0 0 1 0 ${i * 10} Tm (a) Tj 1 0 0 1 50000000 ${i * 10} Tm (b) Tj ET\n`;
    }
    const started = Date.now();
    const text = read(onePage(content), "");
    assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
    assert.ok(text.length < 100_000, `${text.length} characters`);
    assert.match(text.split("\n")[0]!, /^a +b$/);
  });

  test("a page of very many pieces is read, not refused", () => {
    // Math.min over every piece at once overflowed the call stack.
    const text = read(onePage(`BT /F1 1 Tf ${"(a) Tj ".repeat(300_000)}ET`), "");
    assert.ok(text.length >= 300_000);
  });
});

describe("the PDF reader · a font's character map", () => {
  /** A page whose one font maps codes through `cmap`, selected `selects` times. */
  function withCMap(cmap: string, selects: number): Uint8Array {
    const content = deflateSync(Buffer.from(`BT ${"/F1 1 Tf ".repeat(selects)}<0041> Tj ET`, "latin1"));
    const map = deflateSync(Buffer.from(cmap, "latin1"));
    return new Uint8Array(Buffer.concat([
      Buffer.from(
        `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
        `2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n` +
        `3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj\n` +
        `5 0 obj << /Type /Font /Subtype /Type0 /ToUnicode 6 0 R >> endobj\n` +
        `4 0 obj << /Length ${content.length} /Filter /FlateDecode >>\nstream\n`,
        "latin1",
      ),
      content,
      Buffer.from(`\nendstream\nendobj\n6 0 obj << /Length ${map.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
      map,
      Buffer.from(`\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, "latin1"),
    ]));
  }

  /*
   * Every `Tf` read the font's /ToUnicode map again, and one `<0000> <FFFF>`
   * range is 65,536 entries: a page selecting that font a few thousand times
   * — a few bytes each — held the server for many seconds per thousand.
   */
  test("is read once per font, however often the page selects it", () => {
    const bytes = withCMap("beginbfrange\n<0000><FFFF><0000>\nendbfrange\n", 5_000);
    const started = Date.now();
    const text = read(bytes, "");
    assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
    assert.equal(text, "A");
  });

  test("a map of endless full ranges is read only so far", () => {
    const bytes = withCMap(`beginbfrange\n${"<0000><FFFF><0000>\n".repeat(5_000)}endbfrange\n`, 1);
    const started = Date.now();
    read(bytes, "");
    assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
  });
});

describe("the PDF reader · streams that never end", () => {
  /*
   * Each `stream` with no `endstream` after it searched the rest of the file
   * for one, so a file of nothing but unterminated streams was read in time
   * proportional to the square of its size: under half a megabyte of them held
   * the server for over a minute.
   */
  test("are read in time proportional to the file, not its square", () => {
    const bytes = new Uint8Array(Buffer.from("1 0 obj << >>\nstream\n".repeat(20_000), "latin1"));
    const started = Date.now();
    const doc = readDocument(bytes);
    assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
    assert.equal(doc.objects.size, 1);
  });

  test("a stream with a wrong /Length still ends at its own endstream", () => {
    const bytes = new Uint8Array(Buffer.from(
      "1 0 obj << /Length 999 >>\nstream\nfirst\nendstream\nendobj\n" +
      "2 0 obj << /Length 1 >>\nstream\nsecond\nendstream\nendobj\n",
      "latin1",
    ));
    const doc = readDocument(bytes);
    const one = doc.objects.get(1) as { raw: Uint8Array };
    const two = doc.objects.get(2) as { raw: Uint8Array };
    assert.equal(Buffer.from(one.raw).toString("latin1"), "first");
    assert.equal(Buffer.from(two.raw).toString("latin1"), "second");
  });
});

describe("the PDF reader · nesting deeper than any statement", () => {
  /*
   * DEBUG-IMPORT-10 · Arrays and dictionaries were read by recursion with no
   * limit, so a trailer of a few hundred thousand `[` overflowed the stack and
   * the upload page said "Maximum call stack size exceeded". It is refused by
   * name instead, at a depth no generator comes near.
   */
  test("a trailer nested past the limit is refused with a plain reason", () => {
    const bytes = new Uint8Array(Buffer.from("trailer\n" + "[".repeat(200_000), "latin1"));
    assert.throws(() => readDocument(bytes), (error: Error) => {
      assert.ok(!(error instanceof RangeError), "not a stack overflow");
      assert.match(error.message, /nests its structure/);
      return true;
    });
  });

  test("an object nested past the limit is skipped, the rest still read", () => {
    const bytes = new Uint8Array(Buffer.from(
      "1 0 obj " + "<< /A ".repeat(100_000) + "\nendobj\n2 0 obj [1 [2 [3]]] endobj\n",
      "latin1",
    ));
    const doc = readDocument(bytes);
    assert.equal(doc.objects.has(1), false);
    assert.deepEqual(doc.objects.get(2), [1, [2, [3]]]);
  });

  test("ordinary nesting is read as before", () => {
    const bytes = new Uint8Array(Buffer.from(
      "trailer\n<< /A " + "[".repeat(50) + "1" + "]".repeat(50) + " >>",
      "latin1",
    ));
    const doc = readDocument(bytes);
    let v = doc.trailer.get("A");
    for (let i = 0; i < 50; i++) v = (v as unknown[])[0] as typeof v;
    assert.equal(v, 1);
  });
});
