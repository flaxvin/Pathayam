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

describe("the PDF reader · glyphs placed one at a time", () => {
  /*
   * CAMS positions every glyph of a row separately. With a half-em guess at
   * each glyph's width, a 0.6-em capital looked like a gap and the row read
   * "1 0 - A u g - 2 0 2 6 R e d e m p t i o n" — no date, so no row.
   */
  const font = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 32 /LastChar 122 /Widths 7 0 R >>";
  // Helvetica-ish: everything 600 wide except the space, which is 278.
  const widths = `[278 ${Array.from({ length: 90 }, () => "600").join(" ")}]`;
  const page = (content: string): Uint8Array => pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    stream("", content),
    font,
    "<< >>",
    widths,
  ]);

  test("a word drawn glyph by glyph comes out as one word", () => {
    // Each glyph advances by its own 600/1000 × 10 = 6 units.
    const glyphs = [..."10-Aug-2026"].map((c, i) => `1 0 0 1 ${20 + i * 6} 700 Tm (${c}) Tj`).join(" ");
    const after = `1 0 0 1 ${20 + 11 * 6 + 30} 700 Tm (Redemption) Tj`;
    const text = read(page(`BT /F1 10 Tf ${glyphs} ${after} ET`), "");
    assert.equal(text.trim().replace(/\s+/g, " "), "10-Aug-2026 Redemption");
  });

  test("a kerned word is not split where the kerning is", () => {
    const text = read(page("BT /F1 10 Tf 20 700 Td [(MO) -12 (TILAL) 4 (OSWAL)] TJ ET"), "");
    assert.equal(text.trim(), "MOTILALOSWAL");
  });

  test("text set at an angle is left out rather than read a letter per line", () => {
    const vertical = "0 1 -1 0 590 300 Tm (WATERMARK) Tj";
    const text = read(page(`BT /F1 10 Tf 20 700 Td (Folio 123) Tj ET BT /F1 10 Tf ${vertical} ET`), "");
    assert.equal(text.trim(), "Folio 123");
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
