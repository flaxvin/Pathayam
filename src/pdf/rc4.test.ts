import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rc4 } from "./rc4.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex").toUpperCase();

describe("RC4 · against the published vectors", () => {
  // The whole point of these: a cipher written by hand is worth nothing
  // without an external check. These three are the widely published ones.
  test("Key / Plaintext", () => {
    assert.equal(hex(rc4(enc("Key"), enc("Plaintext"))), "BBF316E8D940AF0AD3");
  });

  test("Wiki / pedia", () => {
    assert.equal(hex(rc4(enc("Wiki"), enc("pedia"))), "1021BF0420");
  });

  test("Secret / Attack at dawn", () => {
    assert.equal(
      hex(rc4(enc("Secret"), enc("Attack at dawn"))),
      "45A01F645FC35B383552544B9BF5",
    );
  });

  test("RFC 6229 · key 0102030405, first 16 keystream bytes", () => {
    const key = new Uint8Array([1, 2, 3, 4, 5]);
    const keystream = rc4(key, new Uint8Array(16));
    assert.equal(hex(keystream), "B2396305F03DC027CCC3524A0A1118A8");
  });

  test("it is its own inverse", () => {
    const key = enc("statement-password");
    const clear = enc("Folio 12345678 / 90 · 936.043 units");
    assert.deepEqual(rc4(key, rc4(key, clear)), clear);
  });
});
