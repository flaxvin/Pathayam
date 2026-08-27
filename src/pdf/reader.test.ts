import { test, describe } from "node:test";
import assert from "node:assert/strict";
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
