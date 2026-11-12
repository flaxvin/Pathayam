import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMail, mailHeader, addressOf } from "./mime.ts";

const enc = (s: string): Uint8Array => Buffer.from(s, "utf8");
const crlf = (s: string): string => s.replace(/\r?\n/g, "\r\n");

// A fictional "PDF": just enough bytes to recognise after the round trip.
const PDF = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj << >> endobj\n%%EOF\n", "latin1");

test("multipart/mixed: QP text body and a base64 PDF attachment", () => {
  const b64 = PDF.toString("base64").replace(/.{1,20}/g, "$&\n").replace(/=+\n?$/, ""); // folded, padding dropped
  const raw = crlf(`Received: by mx.example.test; Mon, 2 Nov 2026 10:00:00 +0530
From: "Example Bank Alerts" <Alerts@Bank.Example>
To: home@family.example
Subject: Your statement
Date: Mon, 2 Nov 2026 09:58:12 +0530 (IST)
Message-ID: <abc.123@bank.example>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="==outer=="

preamble is ignored
--==outer==
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Dear customer, your statement for Oct is attached. Amount due: =E2=82=B9 1,2=
34.00
--==outer==
Content-Type: application/octet-stream; name="ignored.bin"
Content-Disposition: attachment; filename="Statement_Oct.pdf"
Content-Transfer-Encoding: base64

${b64}
--==outer==--
epilogue`);
  const m = parseMail(enc(raw));
  assert.equal(m.from, "alerts@bank.example");
  assert.equal(m.subject, "Your statement");
  assert.equal(m.messageId, "abc.123@bank.example");
  assert.equal(m.date?.toISOString(), "2026-11-02T04:28:12.000Z");
  assert.equal(m.text, "Dear customer, your statement for Oct is attached. Amount due: ₹ 1,234.00");
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0]!.filename, "Statement_Oct.pdf");
  assert.equal(m.attachments[0]!.contentType, "application/octet-stream");
  assert.deepEqual(Buffer.from(m.attachments[0]!.bytes), PDF);
  assert.equal(m.headers[0]!.name, "Received");
  assert.equal(mailHeader(m, "TO"), "home@family.example");
  assert.equal(mailHeader(m, "x-missing"), null);
});

test("alternative with only HTML: tags stripped, entities decoded", () => {
  const raw = crlf(`From: alerts@bank.example
Subject: Debit alert
Content-Type: multipart/related; boundary=rel

--rel
Content-Type: multipart/alternative; boundary="alt"

--alt
Content-Type: text/html; charset="iso-8859-1"
Content-Transfer-Encoding: quoted-printable

<html><head><style>p{color:red}</style></head><body><p>Rs.&nbsp;500.00 debited&#33;</p><p>A&amp;B &lt;ref&gt; &quot;x&quot; caf=E9</p></body></html>
--alt--
--rel
Content-Type: image/png
Content-ID: <logo>

PNGDATA
--rel--
`);
  const m = parseMail(enc(raw));
  assert.equal(m.text, 'Rs. 500.00 debited!\nA&B <ref> "x" café');
  assert.equal(m.attachments.length, 0);
});

test("RFC 2047 subject: B and Q words, split multi-byte, whitespace between words dropped", () => {
  const raw = crlf(`From: =?UTF-8?Q?Example_Bank?= <alerts@bank.example>
Subject: =?UTF-8?B?4oK5IDUwMA==?= =?utf-8?Q?_credited_?=
 =?UTF-8?B?4o?= =?UTF-8?B?grk=?= and =?iso-8859-1?q?caf=E9?= =?windows-1252?Q?=80?=

body
`);
  const m = parseMail(enc(raw));
  assert.equal(m.subject, "₹ 500 credited ₹ and café€");
  assert.equal(m.from, "alerts@bank.example");
  // Header values stay undecoded.
  assert.match(mailHeader(m, "subject")!, /^=\?UTF-8\?B\?/);
  assert.equal(m.text, "body\n");
});

test("RFC 2231 filename with continuation and charset; RFC 2047 name fallback", () => {
  const raw = crlf(`From: a@bank.example
Content-Type: multipart/mixed; boundary=b

--b
Content-Type: application/pdf
Content-Disposition: attachment;
 filename*0*=utf-8''%E2%82%B9%20Statement;
 filename*1=" Oct.pdf"
Content-Transfer-Encoding: base64

JVBERg==
--b
Content-Type: application/pdf; name="=?UTF-8?Q?e=E2=82=B9.pdf?="

%PDF
--b--
`);
  const m = parseMail(enc(raw));
  assert.deepEqual(m.attachments.map((a) => a.filename), ["₹ Statement Oct.pdf", "e₹.pdf"]);
  assert.equal(Buffer.from(m.attachments[0]!.bytes).toString(), "%PDF");
  assert.equal(Buffer.from(m.attachments[1]!.bytes).toString(), "%PDF");
});

test("LF-only line endings", () => {
  const raw = `From: Bank <alerts@bank.example>
Subject: plain
Content-Type: multipart/mixed; boundary=x

--x
Content-Type: text/plain

line one
line two
--x
Content-Disposition: attachment; filename=a.pdf
Content-Transfer-Encoding: base64

JVBE
Rg
--x--
`;
  const m = parseMail(enc(raw));
  assert.equal(m.text, "line one\nline two");
  assert.equal(Buffer.from(m.attachments[0]!.bytes).toString(), "%PDF");
  assert.equal(m.attachments[0]!.contentType, "text/plain");
});

test("forwarded as attachment: the message/rfc822 part's text and PDF are collected", () => {
  const inner = crlf(`From: HDFC-style Alerts <alerts@bank.example>
Subject: Statement
Content-Type: multipart/mixed; boundary="in"

--in
Content-Type: text/plain; charset=utf-8

Inner statement text
--in
Content-Type: application/pdf; name=stmt.pdf
Content-Transfer-Encoding: base64

${PDF.toString("base64")}
--in--
`);
  const raw = crlf(`From: Member <member@family.example>
Subject: Fwd: Statement
Content-Type: multipart/mixed; boundary="out"

--out
Content-Type: text/plain

See attached.
--out
Content-Type: message/rfc822
Content-Disposition: attachment

${inner}
--out--
`);
  const m = parseMail(enc(raw));
  assert.equal(m.from, "member@family.example");
  assert.equal(m.text, "See attached.\nInner statement text");
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0]!.filename, "stmt.pdf");
  assert.deepEqual(Buffer.from(m.attachments[0]!.bytes), PDF);
});

test("charset fallback and 8-bit body", () => {
  const raw = Buffer.concat([
    Buffer.from("From: a@b.example\r\nContent-Type: text/plain; charset=x-made-up\r\nContent-Transfer-Encoding: 8bit\r\n\r\ncaf", "latin1"),
    Buffer.from([0xe9]),
  ]);
  assert.equal(parseMail(raw).text, "café");
});

test("malformed input never throws", () => {
  const cases: Uint8Array[] = [
    new Uint8Array(0),
    enc("not a mail at all"),
    enc("\r\n\r\n"),
    enc("From: <>\r\nContent-Type: multipart/mixed\r\n\r\nno boundary"),
    enc("Content-Type: multipart/mixed; boundary=z\r\n\r\n--z\r\nContent-Type: text/plain\r\n\r\ntruncated part"),
    enc("Content-Type: message/rfc822\r\n\r\n".repeat(200)),
    enc("Subject: =?bogus?X?zz?= =?utf-8?B?!!!?=\r\nDate: yesterday\r\nContent-Transfer-Encoding: base64\r\n\r\n@@@"),
    Uint8Array.from({ length: 512 }, (_, i) => (i * 37) % 256),
  ];
  for (const c of cases) {
    const m = parseMail(c);
    assert.equal(typeof m.text, "string");
    assert.ok(Array.isArray(m.attachments));
  }
  const truncated = parseMail(cases[4]!);
  assert.equal(truncated.text, "truncated part");
  assert.equal(parseMail(cases[6]!).date, null);
});

test("addressOf", () => {
  assert.equal(addressOf('"Alerts, Bank" <Alerts@Bank.Example>'), "alerts@bank.example");
  assert.equal(addressOf("Alerts@Bank.Example"), "alerts@bank.example");
  assert.equal(addressOf("alerts@bank.example (Example Bank)"), "alerts@bank.example");
  assert.equal(addressOf(""), "");
  // MAIL-5 · The address is the angle-addr, never something shaped like one in the display name.
  assert.equal(addressOf('"<alerts@axis.bank.in>" <me@evil.test>'), "me@evil.test");
  assert.equal(addressOf('"a \\"<x@y.z>\\"" <me@evil.test>'), "me@evil.test");
  assert.equal(addressOf("Bank (<alerts@axis.bank.in>) <me@evil.test>"), "me@evil.test");
  const encodedName = parseMail(enc(
    "From: =?utf-8?Q?=3Calerts@axis.bank.in=3E?= <me@evil.test>\r\nSubject: x\r\n\r\nbody",
  ));
  assert.equal(encodedName.from, "me@evil.test", "an encoded display name is not decoded into the address");
});

test("HTML markup nested to survive one pass is still removed", () => {
  const raw = [
    "From: a@bank.test", "Subject: x", "MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8", "",
    "<p>Paid <scr<script>ipt>alert(1)</scr</script>ipt> INR 10</p><!<!---->-- hidden -->",
  ].join("\r\n");
  const text = parseMail(new Uint8Array(Buffer.from(raw))).text;
  assert.doesNotMatch(text, /<script|<!--/i);
  assert.match(text, /INR 10/);
});
