import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  verifyDkim, alignedPass, canonBody, canonHeader, selectHeaders, splitMessage, parseTags,
  type TxtResolver, type DkimResult,
} from "./dkim.ts";
import { signDkim, keyRecord } from "./dkim-sign.test-data.ts";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaOther = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ed = generateKeyPairSync("ed25519");

// Fictional bank mail, with an 8-bit byte (é in latin1) and trailing blank lines.
const MAIL =
  "From: Example Bank <alerts@bank.example>\r\n" +
  "To: home@family.example\r\n" +
  "Subject:   Debit   alert\r\n" +
  "Date: Mon, 2 Nov 2026 09:58:12 +0530\r\n" +
  "Message-ID: <m1@bank.example>\r\n" +
  "MIME-Version: 1.0\r\n" +
  "Content-Type: text/plain; charset=iso-8859-1\r\n" +
  "\r\n" +
  "Rs 500.00 debited at Caf\xe9  Example  \r\n" +
  "Avl bal Rs 1,000.00\r\n" +
  "\r\n\r\n";

function resolver(records: Record<string, string>): TxtResolver {
  const map = new Map(Object.entries(records));
  return async (name) => {
    const r = map.get(name);
    if (r === undefined) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    // Split the record into 255-octet chunks like real DNS does.
    return [r.match(/.{1,255}/g) ?? [""]];
  };
}

const bankDns = resolver({
  "s1._domainkey.bank.example": keyRecord(rsa.publicKey),
  "ed1._domainkey.bank.example": keyRecord(ed.publicKey, "ed25519-sha256"),
});

function signed(
  opts: Partial<Parameters<typeof signDkim>[1]> = {},
  raw: string = MAIL,
): string {
  const bytes = signDkim(raw, { domain: "bank.example", selector: "s1", privateKey: rsa.privateKey, ...opts });
  return Buffer.from(bytes).toString("latin1");
}
const bytes = (s: string): Uint8Array => Buffer.from(s, "latin1");
const one = async (s: string, resolve: TxtResolver = bankDns, now?: Date): Promise<DkimResult> => {
  const r = await verifyDkim(bytes(s), resolve, now);
  assert.equal(r.length, 1);
  return r[0]!;
};

test("canonicalisation matches RFC 6376 §3.4.6 example", () => {
  const { fields, body } = splitMessage("A: X\r\nB : Y\t\r\n\tZ  \r\n\r\n C \r\nD \t E\r\n\r\n\r\n");
  assert.equal(fields.map((f) => canonHeader(f, "relaxed")).join(""), "a:X\r\nb:Y Z\r\n");
  assert.equal(fields.map((f) => canonHeader(f, "simple")).join(""), "A: X\r\nB : Y\t\r\n\tZ  \r\n");
  assert.equal(canonBody(body, "relaxed"), " C\r\nD E\r\n");
  assert.equal(canonBody(body, "simple"), " C \r\nD \t E\r\n");
  assert.equal(canonBody("", "simple"), "\r\n");
  assert.equal(canonBody("\r\n\r\n", "relaxed"), "");
});

test("header selection is bottom-up and over-signed names add nothing", () => {
  const { fields } = splitMessage("X: 1\r\nY: a\r\nX: 2\r\n\r\n");
  assert.deepEqual(selectHeaders(fields, ["x", "x", "x", "y", "z"]).map((f) => f.raw), ["X: 2", "X: 1", "Y: a"]);
});

test("tag list tolerates folding whitespace and rejects duplicates", () => {
  const t = parseTags(" v=1;\r\n\ta = rsa-sha256 ;b=ab\r\n\t cd ; ");
  assert.equal(t?.get("a"), "rsa-sha256");
  assert.equal(t?.get("b"), "ab\r\n\t cd");
  assert.equal(parseTags("a=1; a=2"), null);
});

test("rsa-sha256 relaxed/relaxed passes", async () => {
  assert.deepEqual(await one(signed()), { domain: "bank.example", selector: "s1", result: "pass" });
});

test("rsa-sha256 simple/simple passes", async () => {
  assert.equal((await one(signed({ canon: "simple/simple" }))).result, "pass");
});

test("relaxed/simple passes", async () => {
  assert.equal((await one(signed({ canon: "relaxed/simple" }))).result, "pass");
});

test("ed25519-sha256 passes", async () => {
  const s = signed({ algorithm: "ed25519-sha256", selector: "ed1", privateKey: ed.privateKey });
  assert.deepEqual(await one(s), { domain: "bank.example", selector: "ed1", result: "pass" });
});

test("LF-only copy of a signed message still passes", async () => {
  assert.equal((await one(signed().replace(/\r\n/g, "\n"))).result, "pass");
});

test("body tampered -> fail", async () => {
  const r = await one(signed().replace("Rs 500.00", "Rs 900.00"));
  assert.equal(r.result, "fail");
  assert.equal(r.reason, "body hash mismatch");
});

test("relaxed body tolerates whitespace changes; simple does not", async () => {
  assert.equal((await one(signed().replace("Avl bal", "Avl   bal"))).result, "pass");
  assert.equal((await one(signed({ canon: "simple/simple" }).replace("Avl bal", "Avl   bal"))).result, "fail");
});

test("header tampered -> fail", async () => {
  const r = await one(signed().replace("Subject:   Debit   alert", "Subject: Credit alert"));
  assert.equal(r.result, "fail");
  assert.equal(r.reason, "signature did not verify");
});

test("a second From added below the signed one is caught (bottom-up selection)", async () => {
  const s = signed().replace("\r\n\r\nRs 500", "\r\nFrom: someone@evil.example\r\n\r\nRs 500");
  assert.equal((await one(s)).result, "fail");
});

test("over-signed Reply-To blocks adding one later", async () => {
  const s = signed({ headers: ["from", "subject", "reply-to", "reply-to"] });
  assert.equal((await one(s)).result, "pass");
  const added = s.replace("\r\n\r\nRs 500", "\r\nReply-To: x@evil.example\r\n\r\nRs 500");
  assert.equal((await one(added)).result, "fail");
});

test("headers prepended after signing (Gmail forwarding) still pass", async () => {
  for (const canon of ["relaxed/relaxed", "simple/simple"] as const) {
    const fwd =
      "Received: from mail-sor-f41.google.example by mx.pathayam.example; Mon, 2 Nov 2026 04:30:00 +0000\r\n" +
      "ARC-Seal: i=1; a=rsa-sha256; t=1793000000; cv=none; d=google.example; s=arc; b=AAAA\r\n" +
      "ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=google.example; s=arc;\r\n\th=from:to:subject; bh=AAAA; b=BBBB\r\n" +
      "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=google.example; s=fwd; h=from; bh=AAAA; b=BBBB\r\n" +
      "X-Forwarded-To: inbox@pathayam.example\r\n" +
      "X-Forwarded-For: member@family.example inbox@pathayam.example\r\n" +
      "Delivered-To: inbox@pathayam.example\r\n" +
      signed({ canon });
    const r = await verifyDkim(bytes(fwd), bankDns);
    assert.deepEqual(r.map((x) => [x.domain, x.result]), [["google.example", "permerror"], ["bank.example", "pass"]]);
    assert.equal(alignedPass(r, "alerts@bank.example"), true);
  }
});

test("wrong key -> fail", async () => {
  const s = signed({ privateKey: rsaOther.privateKey });
  assert.equal((await one(s)).result, "fail");
});

test("PKCS#1 key record is accepted", async () => {
  const pkcs1 = rsa.publicKey.export({ format: "der", type: "pkcs1" }).toString("base64");
  const r = await one(signed(), resolver({ "s1._domainkey.bank.example": `v=DKIM1; k=rsa; p=${pkcs1}` }));
  assert.equal(r.result, "pass");
});

test("missing key -> permerror", async () => {
  const r = await one(signed({ selector: "nope" }));
  assert.deepEqual(r, { domain: "bank.example", selector: "nope", result: "permerror", reason: "no key" });
});

test("revoked key (empty p=) -> permerror", async () => {
  const r = await one(signed(), resolver({ "s1._domainkey.bank.example": "v=DKIM1; k=rsa; p=" }));
  assert.equal(r.result, "permerror");
  assert.equal(r.reason, "key revoked");
});

test("DNS failure other than ENOTFOUND/ENODATA -> temperror", async () => {
  const flaky: TxtResolver = async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" }); };
  assert.equal((await one(signed(), flaky)).result, "temperror");
  const nodata: TxtResolver = async () => { throw Object.assign(new Error("no data"), { code: "ENODATA" }); };
  assert.equal((await one(signed(), nodata)).result, "permerror");
});

test("rsa-sha1 -> permerror", async () => {
  const r = await one(signed().replace("a=rsa-sha256", "a=rsa-sha1"));
  assert.equal(r.result, "permerror");
  assert.equal(r.reason, "sha1 not accepted");
});

test("expired x= is not a pass; unexpired x= passes", async () => {
  const s = signed({ extraTags: { x: "1800000000" } }); // 2027-01-15
  assert.equal((await one(s, bankDns, new Date("2026-11-08T00:00:00Z"))).result, "pass");
  const late = await one(s, bankDns, new Date("2027-02-01T00:00:00Z"));
  assert.notEqual(late.result, "pass");
  assert.equal(late.reason, "signature expired");
});

test("l= limits the hashed body; content appended beyond it still passes", async () => {
  const s = signed({ extraTags: { l: "20" } });
  assert.equal((await one(s)).result, "pass");
  assert.equal((await one(s + "appended\r\n")).result, "pass");
});

test("signature without From in h= -> permerror; key type mismatch -> permerror", async () => {
  assert.equal((await one(signed({ headers: ["subject"] }))).result, "permerror");
  const r = await one(signed(), resolver({ "s1._domainkey.bank.example": keyRecord(ed.publicKey, "ed25519-sha256") }));
  assert.equal(r.result, "permerror");
});

test("unsigned message -> []; garbage never throws", async () => {
  assert.deepEqual(await verifyDkim(bytes(MAIL), bankDns), []);
  assert.deepEqual(await verifyDkim(new Uint8Array(0), bankDns), []);
  const junk = await verifyDkim(bytes("DKIM-Signature: ;;;==\r\n\r\n"), bankDns);
  assert.equal(junk[0]?.result, "permerror");
  const noB = await verifyDkim(bytes("DKIM-Signature: v=1; a=rsa-sha256; d=x; s=y; h=from; bh=AA\r\n\r\n"), bankDns);
  assert.equal(noB[0]?.result, "permerror");
});

test("alignedPass: relaxed alignment", () => {
  const pass = (domain: string): DkimResult[] => [{ domain, selector: "s", result: "pass" }];
  assert.equal(alignedPass(pass("hdfcbank.net"), "alerts@hdfcbank.net"), true);
  assert.equal(alignedPass(pass("icicibank.com"), "x@mail.icicibank.com"), true);
  assert.equal(alignedPass(pass("ICICIBANK.com"), "X@Mail.IciciBank.COM"), true);
  assert.equal(alignedPass(pass("evil.com"), "x@mail.icicibank.com"), false);
  assert.equal(alignedPass(pass("bank.com"), "x@notbank.com"), false);
  assert.equal(alignedPass(pass("mail.icicibank.com"), "x@icicibank.com"), false);
  assert.equal(alignedPass([{ domain: "icicibank.com", selector: "s", result: "fail" }], "x@icicibank.com"), false);
  assert.equal(alignedPass([], "x@icicibank.com"), false);
});
