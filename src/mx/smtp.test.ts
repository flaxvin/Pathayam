/**
 * FWD-2 · The SMTP receiver, driven over real sockets by a raw client so the
 * wire format (CRLF, dot-stuffing, pipelining, STARTTLS) is what is tested.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { createSmtpServer, type DeliverInput, type SmtpServerOptions } from "./smtp.ts";

// Throwaway self-signed pair for CN=localhost (openssl req -x509 -newkey rsa:2048
// -nodes -days 36500 -subj /CN=localhost). Test use only; node cannot mint X.509.
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDCzCCAfOgAwIBAgIUI2gNuf4VsEkpGK88vlAMXN7iiXQwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEwODE3MjEyOFoYDzIxMjYx
MDE1MTcyMTI4WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDILxU4gAuxkEFHdOTKOqsNnKopgBhrS+AyTbMMHbgn
oypfmUvAav8L41fR/QFYmMo/71drNNk96U2zMVQeqLftFjeN0RX2QncAW/6uVLXL
eoOIczs15Jt52t/RNmuz8pwFQ3az7Lyz5iRcuxstxzqr8livDuiWUKeiXppRoVl2
nhH4n3cteNb5YajZY4mtYhuIhIwtBvTi5X1W/zDTta39UqLiNuR40DkeFDvL929F
HCKGNF0SrKy9uzPv3u+DTFss2yTPG0rx9O0RftGkiE8hnaKEAA1k6dGrqRR7ZyWV
AygmKX47lR1RBTNrJ7mgLy5Y7v7nj0drKMLYZigEH5oBAgMBAAGjUzBRMB0GA1Ud
DgQWBBTE6JWTK76xNSSTrJkvAdy+dRnTozAfBgNVHSMEGDAWgBTE6JWTK76xNSST
rJkvAdy+dRnTozAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQDH
thzB5E5qRY2BKIOaJVIUb/OpjrXpJpKcxPn0XJTQtzRUw3QMgaKWY0vAI+hpXNW1
nw8SbSJLlQf+1mpEuSas3HXKGvfPebCYjsorhN0TviAkjA2IxtC0pYwFi3ICzHUq
zwGWXwIp+JnSf2oVM+rDSqzbwiUWYw0YMBK0qf5dklJZkJB2dZUtdtIOm6l+TCtY
pzhiZuRIPHiIbomugbbzW7AO/LB+/7Q2XTKNHMZNICl7S46aCIy4Gq+7FiPrJNix
tZY2i98WKylSi0rKR2wb6KI0pgkVepMnWypmxI4UP44evasE389+GqaaBjT9IGX0
/Ncm9BOmOH9/2Ft5jYbj
-----END CERTIFICATE-----
`;

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDILxU4gAuxkEFH
dOTKOqsNnKopgBhrS+AyTbMMHbgnoypfmUvAav8L41fR/QFYmMo/71drNNk96U2z
MVQeqLftFjeN0RX2QncAW/6uVLXLeoOIczs15Jt52t/RNmuz8pwFQ3az7Lyz5iRc
uxstxzqr8livDuiWUKeiXppRoVl2nhH4n3cteNb5YajZY4mtYhuIhIwtBvTi5X1W
/zDTta39UqLiNuR40DkeFDvL929FHCKGNF0SrKy9uzPv3u+DTFss2yTPG0rx9O0R
ftGkiE8hnaKEAA1k6dGrqRR7ZyWVAygmKX47lR1RBTNrJ7mgLy5Y7v7nj0drKMLY
ZigEH5oBAgMBAAECggEAALJJPJ0VbVS3JWx+r0Vs+usknGhZrWXiLcqfaNdhoKGs
sBB0dwLoSD5OO+jJbGl7qqVGhJT2fISnRIxTYpfrq+N75f5oOScaCuJHDIw25bJT
atIbzqAw+keMp8msrj+V017cttuH/Ig8cCYmfg5HYfnB3ToMDRnSu3ngx4/sI8F/
cY0jJ4Q8pNB+eAfpZZy+5VpiR9Y5y5YFuSFMgq3qauCsEqvYljPLI+tHGwrKhzyt
sZs8RqSZMleP315UBF+WmKC25UcZq0pH03o1komk9gXzWl3m3UIr2IxeWncXKqy7
EN+ka+GSESM3aAG2jSDNh/wTBnR5mMaLAaVMchl60QKBgQD4RvCISa6I+IzPeuJH
635/NUGFsp4O5J4KBi571+apURtn5BJN5UYZIqoLLdBMamRvU/1jF4L39bpeV1+R
c8Urw25EkfOYOLOCnhGIVhcBDAfu6aIA8WwDaXevqvnOyJCZ1bRtISICFMXxmRdx
cizJxR2BzCLfxT0VrqHyvtNsIwKBgQDOaSvlLFVaS+eeZNB+7GVJIGvbkEweWE72
g1EcTmr6zK0uQZoxeCpNN5O0v/P4J/WINamiieaEkUG3W6P8tiWI/mjrecqQmd+Z
4WwbjjL9nYssgoCYnz2wQfO/8rxZTs7q1CdDCr1FG14Vx9MGHMUFYJy0pzZzt7qE
h71eXhVBiwKBgArrA7TamKRJWdfd7YmAH6X0b5czjaPWBeUm9HBZxDj56hydePiX
9ocwcQ3gy+IwY45JwUDUTdwdoD551SgOUUNlarn1OSMeizZZQSgfsQ9IuiiVeZxV
AYz83FiLSkT/qOw6655I8LfqtfGz68X/YVzWIEAO/BGfGNqVPWXxYlbFAoGBAM3W
bbK1mkxYw5reOFlKTts03LpxVKcyM1R7schDn0WKFO26+BR7G9wzHzYx8g63cpAp
y4fOczYiUOGUHp2l2xqZcnHY25uGB0jCVvfHv6vQjviND8ajjnYV3wi8/P0mrQvb
E2g07nhbCWE5C4Td7dAl/z/cPF37i6IcZ0kTE6lvAoGBAKAilQ2mohQtIZNhq+Ti
dk5txmXneLv3BHKiO1wW3BkE3glrQYVfXkALeQB42u0I8Mur+PdjCwZ3x3DVGyXk
tfLlAk8D/aDzjFstoP6PGE3Ct//vWoQRBg+kGjJCTB5ChR5vKHeeyYVVCOtXXNbr
oxguTSoN1UCHNWkXoTScq+4q
-----END PRIVATE KEY-----
`;

/** A line-oriented SMTP client over a raw socket, able to switch to TLS mid-stream. */
class Client {
  socket: net.Socket;
  buffer = "";
  closed = false;
  private wake: (() => void) | null = null;
  private readonly onData = (d: Buffer) => { this.buffer += d.toString("utf8"); this.notify(); };
  private readonly onEnd = () => { this.closed = true; this.notify(); };

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.bind(socket);
  }

  static connect(port: number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1", () => resolve(new Client(s)));
      s.once("error", reject);
    });
  }

  private bind(s: net.Socket): void {
    s.on("data", this.onData);
    s.on("end", this.onEnd);
    s.on("close", this.onEnd);
    s.on("error", () => {});
  }

  private notify(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  send(text: string | Buffer): void {
    this.socket.write(text);
  }

  /** The next complete (possibly multi-line) reply. */
  async reply(): Promise<{ code: number; text: string }> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const m = /^((?:\d{3}-[^\r\n]*\r\n)*)(\d{3})(?: ([^\r\n]*))?\r\n/.exec(this.buffer);
      if (m) {
        this.buffer = this.buffer.slice(m[0].length);
        return { code: Number(m[2]), text: m[0] };
      }
      if (this.closed) throw new Error(`connection closed; unread: ${JSON.stringify(this.buffer)}`);
      if (Date.now() > deadline) throw new Error(`no reply; unread: ${JSON.stringify(this.buffer)}`);
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, 50);
      });
    }
  }

  async expect(code: number): Promise<string> {
    const r = await this.reply();
    assert.equal(r.code, code, `expected ${code}, got ${r.text.trim()}`);
    return r.text;
  }

  async command(line: string, code: number): Promise<string> {
    this.send(`${line}\r\n`);
    return this.expect(code);
  }

  async waitClosed(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error("connection did not close");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async startTls(): Promise<void> {
    const raw = this.socket;
    raw.removeListener("data", this.onData);
    raw.removeListener("end", this.onEnd);
    raw.removeListener("close", this.onEnd);
    const secure = tls.connect({ socket: raw, ca: TEST_CERT, servername: "localhost" });
    await new Promise<void>((resolve, reject) => {
      secure.once("secureConnect", resolve);
      secure.once("error", reject);
    });
    this.socket = secure;
    this.bind(secure);
  }

  end(): void {
    this.socket.destroy();
  }
}

type Harness = {
  port: number;
  delivered: DeliverInput[];
  logs: Record<string, unknown>[];
  client(): Promise<Client>;
};

async function start(t: { after(fn: () => unknown): void }, overrides: Partial<SmtpServerOptions> = {}): Promise<Harness> {
  const delivered: DeliverInput[] = [];
  const logs: Record<string, unknown>[] = [];
  const server = createSmtpServer({
    hostname: "mx.test",
    maxBytes: 1000,
    checkRecipient: (a) => a.toLowerCase().endsWith("@in.test")
      ? (a.startsWith("nobody") ? { code: 550, message: "5.1.1 No such user here" } : "ok")
      : { code: 550, message: "5.7.1 Relay access denied" },
    deliver: async (input) => {
      delivered.push(input);
      return input.recipients.map(() => ({ code: 250, message: "2.0.0 OK" }));
    },
    log: (e) => logs.push(e),
    ...overrides,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const clients: Client[] = [];
  t.after(() => {
    for (const c of clients) c.end();
    return new Promise((r) => server.close(r));
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, delivered, logs,
    async client() {
      const c = await Client.connect(port);
      clients.push(c);
      await c.expect(220);
      return c;
    },
  };
}

const text = (b: Uint8Array) => Buffer.from(b).toString("utf8");

test("happy path: dot-unstuffing, CRLF body, envelope handed over, log has no content", async (t) => {
  const h = await start(t);
  const c = await h.client();
  const ehlo = await c.command("EHLO sender.example", 250);
  assert.match(ehlo, /^250-mx\.test greets sender\.example\r\n/);
  assert.match(ehlo, /250-SIZE 1000\r\n/);
  assert.match(ehlo, /8BITMIME/);
  assert.match(ehlo, /PIPELINING/);
  assert.match(ehlo, /SMTPUTF8/);
  assert.doesNotMatch(ehlo, /STARTTLS/);
  await c.command("MAIL FROM:<alerts@bank.example> BODY=8BITMIME SIZE=200", 250);
  await c.command("RCPT TO:<ab.tok@IN.test>", 250);
  await c.command("DATA", 354);
  c.send("Subject: Secret debit\r\n\r\n..leading dot\r\n..\r\nx\r\n...\r\nend\r\n.\r\n");
  await c.expect(250);
  assert.equal(h.delivered.length, 1);
  const d = h.delivered[0]!;
  assert.equal(text(d.raw), "Subject: Secret debit\r\n\r\n.leading dot\r\n.\r\nx\r\n..\r\nend\r\n");
  assert.deepEqual(d.recipients, ["ab.tok@IN.test"]);
  assert.equal(d.mailFrom, "alerts@bank.example");
  assert.equal(d.helo, "sender.example");
  assert.equal(d.remoteAddress, "127.0.0.1");
  await c.command("QUIT", 221);
  await c.waitClosed();

  const entry = h.logs.find((e) => e.msg === "message");
  assert.ok(entry);
  assert.equal(entry.recipients, 1);
  assert.equal(entry.bytes, d.raw.length);
  assert.deepEqual(entry.codes, [250]);
  assert.equal(entry.reply, 250);
  assert.doesNotMatch(JSON.stringify(h.logs), /Secret|leading dot/);
});

test("null sender and HELO are accepted", async (t) => {
  const h = await start(t);
  const c = await h.client();
  await c.command("HELO old.example", 250);
  await c.command("MAIL FROM:<>", 250);
  await c.command("RCPT TO:<x@in.test>", 250);
  await c.command("DATA", 354);
  c.send("hi\r\n.\r\n");
  await c.expect(250);
  assert.equal(h.delivered[0]!.mailFrom, "");
});

test("pipelined commands in one packet, two recipients, then body and QUIT in one packet", async (t) => {
  const h = await start(t);
  const c = await h.client();
  c.send("EHLO p.example\r\nMAIL FROM:<a@b.example>\r\nRCPT TO:<x@in.test>\r\nRCPT TO:<y@in.test>\r\nDATA\r\n");
  await c.expect(250);
  await c.expect(250);
  await c.expect(250);
  await c.expect(250);
  await c.expect(354);
  c.send("one\r\ntwo\r\n.\r\nNOOP\r\nQUIT\r\n");
  await c.expect(250);
  await c.expect(250);
  await c.expect(221);
  assert.deepEqual(h.delivered[0]!.recipients, ["x@in.test", "y@in.test"]);
  assert.equal(text(h.delivered[0]!.raw), "one\r\ntwo\r\n");
});

test("input split into single bytes is reassembled", async (t) => {
  const h = await start(t);
  const c = await h.client();
  const all = "EHLO s.example\r\nMAIL FROM:<a@b.example>\r\nRCPT TO:<x@in.test>\r\nDATA\r\n";
  for (const ch of all) {
    c.send(ch);
    await new Promise((r) => setImmediate(r));
  }
  await c.expect(250);
  await c.expect(250);
  await c.expect(250);
  await c.expect(354);
  for (const ch of "a\r\n.b\r\n.\r\n") {
    c.send(ch);
    await new Promise((r) => setImmediate(r));
  }
  await c.expect(250);
  assert.equal(text(h.delivered[0]!.raw), "a\r\nb\r\n");
});

test("bare LF line endings are accepted and stored as CRLF", async (t) => {
  const h = await start(t);
  const c = await h.client();
  c.send("EHLO lf.example\nMAIL FROM:<a@b.example>\nRCPT TO:<x@in.test>\nDATA\n");
  await c.expect(250);
  await c.expect(250);
  await c.expect(250);
  await c.expect(354);
  c.send("a\n..b\nmixed\r\n.\n");
  await c.expect(250);
  assert.equal(text(h.delivered[0]!.raw), "a\r\n.b\r\nmixed\r\n");
});

test("SIZE= over the limit is refused at MAIL; a smaller one is fine", async (t) => {
  const h = await start(t);
  const c = await h.client();
  await c.command("EHLO s.example", 250);
  const r = await c.command("MAIL FROM:<a@b.example> SIZE=1001", 552);
  assert.match(r, /5\.3\.4/);
  await c.command("MAIL FROM:<a@b.example> SIZE=1000", 250);
  await c.command("MAIL FROM:<a@b.example> SIZE=1", 503);
  await c.command("RSET", 250);
  await c.command("MAIL FROM:<a@b.example> FOO=1", 555);
});

test("oversize DATA is drained to the final dot, refused with 552, and the session goes on", async (t) => {
  const h = await start(t);
  const c = await h.client();
  await c.command("EHLO s.example", 250);
  await c.command("MAIL FROM:<a@b.example>", 250);
  await c.command("RCPT TO:<x@in.test>", 250);
  await c.command("DATA", 354);
  const line = `${"x".repeat(98)}\r\n`;
  c.send(line.repeat(15) + ".\r\n");
  const r = await c.expect(552);
  assert.match(r, /5\.3\.4/);
  assert.equal(h.delivered.length, 0);
  assert.equal(h.logs.find((e) => e.msg === "message")?.reply, 552);
  await c.command("MAIL FROM:<a@b.example>", 250);
  await c.command("RCPT TO:<x@in.test>", 250);
  await c.command("DATA", 354);
  c.send(line + ".\r\n");
  await c.expect(250);
  assert.equal(h.delivered.length, 1);
});

test("a line far longer than 1000 bytes is tolerated inside DATA", async (t) => {
  const h = await start(t, { maxBytes: 300_000 });
  const c = await h.client();
  await c.command("EHLO s.example", 250);
  await c.command("MAIL FROM:<a@b.example>", 250);
  await c.command("RCPT TO:<x@in.test>", 250);
  await c.command("DATA", 354);
  const long = `.${"y".repeat(200_000)}`;
  c.send(`${long}\r\n.\r\n`);
  await c.expect(250);
  assert.equal(text(h.delivered[0]!.raw), `${"y".repeat(200_000)}\r\n`);
});

test("bad sequences get 503, unknown commands 500, and VRFY/NOOP/RSET behave", async (t) => {
  const h = await start(t);
  const c = await h.client();
  await c.command("MAIL FROM:<a@b.example>", 503);
  await c.command("EHLO s.example", 250);
  await c.command("RCPT TO:<x@in.test>", 503);
  await c.command("DATA", 503);
  await c.command("MAIL FROM:<a@b.example>", 250);
  await c.command("MAIL FROM:<a@b.example>", 503);
  await c.command("DATA", 503);
  await c.command("FROB", 500);
  await c.command("VRFY someone", 252);
  await c.command("NOOP", 250);
  await c.command("RSET", 250);
  await c.command("RCPT TO:<x@in.test>", 503);
  await c.command("STARTTLS", 502);
});

test("recipients are checked at RCPT: unknown user and relay denied", async (t) => {
  const h = await start(t);
  const c = await h.client();
  await c.command("EHLO s.example", 250);
  await c.command("MAIL FROM:<a@b.example>", 250);
  assert.match(await c.command("RCPT TO:<nobody@in.test>", 550), /5\.1\.1/);
  assert.match(await c.command("RCPT TO:<x@elsewhere.example>", 550), /5\.7\.1/);
  await c.command("DATA", 503);
});

test("more than 20 recipients get 452", async (t) => {
  const h = await start(t);
  const c = await h.client();
  await c.command("EHLO s.example", 250);
  await c.command("MAIL FROM:<a@b.example>", 250);
  for (let i = 0; i < 20; i++) await c.command(`RCPT TO:<r${i}@in.test>`, 250);
  await c.command("RCPT TO:<r20@in.test>", 452);
});

test("the first non-2xx delivery result is the DATA reply; a thrown deliver is a 451", async (t) => {
  let mode: "mixed" | "throw" = "mixed";
  const h = await start(t, {
    deliver: async (input) => {
      if (mode === "throw") throw new Error("boom");
      return input.recipients.map((r) => r.startsWith("bad")
        ? { code: 550, message: "5.1.1 No such user here" }
        : { code: 250, message: "2.0.0 OK" });
    },
  });
  const c = await h.client();
  await c.command("EHLO s.example", 250);
  await c.command("MAIL FROM:<a@b.example>", 250);
  await c.command("RCPT TO:<good@in.test>", 250);
  await c.command("RCPT TO:<bad@in.test>", 250);
  await c.command("DATA", 354);
  c.send("x\r\n.\r\n");
  assert.match(await c.expect(550), /5\.1\.1/);
  mode = "throw";
  await c.command("MAIL FROM:<a@b.example>", 250);
  await c.command("RCPT TO:<good@in.test>", 250);
  await c.command("DATA", 354);
  c.send("x\r\n.\r\n");
  assert.match(await c.expect(451), /4\.3\.0/);
});

test("over-long command lines are refused without losing the session", async (t) => {
  const h = await start(t);
  const c = await h.client();
  await c.command(`NOOP ${"z".repeat(5000)}`, 500);
  await c.command("NOOP", 250);
  c.send(`NOOP ${"z".repeat(10_000)}`); // no newline yet: refused as soon as it overflows
  await c.expect(500);
  c.send("still the same line\r\nNOOP\r\n");
  await c.expect(250);
});

test("ten bad commands end the session with 421", async (t) => {
  const h = await start(t);
  const c = await h.client();
  for (let i = 0; i < 9; i++) await c.command("BOGUS", 500);
  await c.command("BOGUS", 500);
  await c.expect(421);
  await c.waitClosed();
});

test("an idle session is closed with 421", async (t) => {
  const h = await start(t, { idleTimeoutMs: 150 });
  const c = await h.client();
  assert.match(await c.expect(421), /4\.4\.2/);
  await c.waitClosed();
});

test("a client vanishing mid-DATA does not hurt the server", async (t) => {
  const h = await start(t);
  const c = await h.client();
  await c.command("EHLO s.example", 250);
  await c.command("MAIL FROM:<a@b.example>", 250);
  await c.command("RCPT TO:<x@in.test>", 250);
  await c.command("DATA", 354);
  c.send("partial");
  c.socket.resetAndDestroy();
  const d = await h.client();
  await d.command("NOOP", 250);
  assert.equal(h.delivered.length, 0);
});

test("STARTTLS upgrades, resets state, ignores pipelined plaintext, and is refused twice", async (t) => {
  const h = await start(t, { tls: { cert: TEST_CERT, key: TEST_KEY } });
  const c = await h.client();
  assert.match(await c.command("EHLO s.example", 250), /STARTTLS/);
  await c.command("MAIL FROM:<a@b.example>", 250);
  // NOOP rides along in the clear and must be thrown away (RFC 3207 §5).
  c.send("STARTTLS\r\nNOOP\r\n");
  await c.expect(220);
  await c.startTls();
  assert.equal(c.buffer, "");
  // State was reset: MAIL needs a fresh EHLO.
  await c.command("MAIL FROM:<a@b.example>", 503);
  const ehlo = await c.command("EHLO s.example", 250);
  assert.doesNotMatch(ehlo, /STARTTLS/);
  await c.command("STARTTLS", 503);
  await c.command("MAIL FROM:<a@b.example>", 250);
  await c.command("RCPT TO:<x@in.test>", 250);
  await c.command("DATA", 354);
  c.send("over tls\r\n.\r\n");
  await c.expect(250);
  assert.equal(text(h.delivered[0]!.raw), "over tls\r\n");
  assert.equal(h.logs.find((e) => e.msg === "message")?.tls, true);
  await c.command("QUIT", 221);
});

test("a failed TLS handshake does not hurt the server", async (t) => {
  const h = await start(t, { tls: { cert: TEST_CERT, key: TEST_KEY } });
  const c = await h.client();
  await c.command("EHLO s.example", 250);
  await c.command("STARTTLS", 220);
  c.send("this is not a ClientHello\r\n");
  await c.waitClosed();
  const d = await h.client();
  await d.command("NOOP", 250);
});
