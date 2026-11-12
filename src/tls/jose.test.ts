/**
 * TLS-1 · The JOSE and DER pieces against published vectors where they exist
 * (RFC 7638 §3.1, RFC 8555 §8.1's token and thumbprint), and against
 * independent checks where they do not.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import {
  b64url, dns01RecordName, dns01TxtValue, generateEcKeyPem, jwkThumbprint, keyAuthorization, loadPrivateKey,
  publicJwk, signJws,
} from "./jose.ts";
import { createCsr } from "./csr.ts";
import { decode, decodeOid, integer, oid, time, OID } from "./der.ts";
import { parseCsr } from "./fakes.test-data.ts";

// RFC 7638 §3.1: the example RSA key and its thumbprint.
const RFC7638_N =
  "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw";

test("JWK thumbprint matches RFC 7638 §3.1, ignoring members that are not required", () => {
  assert.equal(
    jwkThumbprint({ kty: "RSA", n: RFC7638_N, e: "AQAB", alg: "RS256", kid: "2011-04-29" }),
    "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs",
  );
});

test("an EC thumbprint hashes crv, kty, x, y in that order, so member order in the JWK does not matter", () => {
  const key = loadPrivateKey(generateEcKeyPem());
  const jwk = publicJwk(key);
  assert.deepEqual(Object.keys(jwk).sort(), ["crv", "kty", "x", "y"]);
  const reordered = { y: jwk.y!, x: jwk.x!, kty: jwk.kty!, crv: jwk.crv!, d: "ignored" };
  assert.equal(jwkThumbprint(reordered), jwkThumbprint(jwk));
  assert.throws(() => jwkThumbprint({ kty: "nope" }), /unsupported/);
});

test("key authorization and DNS-01 TXT value (RFC 8555 §8.1, §8.4)", () => {
  // The token and thumbprint are RFC 8555 §8.1's; the TXT value was checked with
  // printf %s "$ka" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '='
  const ka = keyAuthorization("evaGxfADs6pSRb2LAv9IZf17Dt3juxGJ-PCt92wr-oA", "nP1qzpXGymHBrUEepNY9HCsQk7K8KhOypzEt62jcerQ");
  assert.equal(ka, "evaGxfADs6pSRb2LAv9IZf17Dt3juxGJ-PCt92wr-oA.nP1qzpXGymHBrUEepNY9HCsQk7K8KhOypzEt62jcerQ");
  assert.equal(dns01TxtValue(ka), "NGwKoXBgCT8JhEa0bK7AwfSqHyu_ZWeugV07fLGIVq0");
  assert.doesNotMatch(dns01TxtValue(ka), /[=+/]/);
});

test("the TXT record goes on _acme-challenge of the name, and of the base name for a wildcard", () => {
  assert.equal(dns01RecordName("in.pathayam.app"), "_acme-challenge.in.pathayam.app");
  assert.equal(dns01RecordName("*.in.pathayam.app"), "_acme-challenge.in.pathayam.app");
});

test("a JWS is ES256 with a 64-byte r||s signature that verifies; POST-as-GET has an empty payload", () => {
  const key = loadPrivateKey(generateEcKeyPem());
  const jwk = publicJwk(key);
  const jws = signJws(key, { alg: "ES256", nonce: "n1", url: "https://ca/new-account", jwk }, { termsOfServiceAgreed: true });
  const header = JSON.parse(Buffer.from(jws.protected, "base64url").toString());
  assert.deepEqual(header, { alg: "ES256", nonce: "n1", url: "https://ca/new-account", jwk });
  assert.deepEqual(JSON.parse(Buffer.from(jws.payload, "base64url").toString()), { termsOfServiceAgreed: true });
  const sig = Buffer.from(jws.signature, "base64url");
  assert.equal(sig.length, 64);
  assert.ok(verify("sha256", Buffer.from(`${jws.protected}.${jws.payload}`), {
    key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363",
  }, sig));

  const get = signJws(key, { alg: "ES256", nonce: "n2", url: "https://ca/order/1", kid: "https://ca/acct/1" }, undefined);
  assert.equal(get.payload, "");
  assert.equal(b64url("{}"), "e30");
});

test("only an ECDSA P-256 key is taken as the account key", () => {
  assert.throws(() => loadPrivateKey(`-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIHk5aT7cOjL+1GZz3sHq/ljOV3j4XUZoCv+L0Ej5cOdN\n-----END PRIVATE KEY-----\n`), /P-256/);
});

test("DER: known encodings of integers, OIDs and times", () => {
  assert.equal(integer(0).toString("hex"), "020100");
  assert.equal(integer(127).toString("hex"), "02017f");
  assert.equal(integer(128).toString("hex"), "02020080");
  assert.equal(integer(256).toString("hex"), "02020100");
  assert.equal(integer(Buffer.from([0, 0, 0x81])).toString("hex"), "02020081");
  assert.equal(oid(OID.ecPublicKey).toString("hex"), "06072a8648ce3d0201");
  assert.equal(oid(OID.ecdsaWithSha256).toString("hex"), "06082a8648ce3d040302");
  assert.equal(decodeOid(oid(OID.extensionRequest).subarray(2)), OID.extensionRequest);
  assert.equal(time(new Date("2026-11-12T01:02:03Z")).toString(), "\x17\x0d261112010203Z");
  assert.equal(time(new Date("2051-01-01T00:00:00Z")).toString(), "\x18\x0f20510101000000Z");
  // A long-form length round-trips.
  const long = decode(Buffer.concat([Buffer.from([0x04, 0x82, 0x01, 0x00]), Buffer.alloc(256, 7)]));
  assert.equal(long.content.length, 256);
});

test("the CSR is PKCS#10 with the names in subjectAltName and a signature that verifies", () => {
  const key = loadPrivateKey(generateEcKeyPem());
  const der = createCsr(["in.pathayam.app", "*.in.pathayam.app"], key);
  const csr = parseCsr(der);
  assert.equal(csr.cn, "in.pathayam.app");
  assert.deepEqual(csr.names, ["in.pathayam.app", "*.in.pathayam.app"]);
  assert.ok(csr.signatureValid);
  assert.deepEqual(csr.spki, createPublicKey(key).export({ type: "spki", format: "der" }));
  // Version 0, and ecdsa-with-SHA256 as the signature algorithm.
  const top = decode(der);
  assert.equal(top.children![0]!.children![0]!.content.toString("hex"), "00");
  assert.equal(decodeOid(top.children![1]!.children![0]!.content), OID.ecdsaWithSha256);
  assert.throws(() => createCsr([], key), /at least one/);
});
