/**
 * FWD-2 · The SMTP receiver, driven over real sockets by a raw client so the
 * wire format (CRLF, dot-stuffing, pipelining, STARTTLS) is what is tested.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { createSmtpServer, parseProxyLine, type DeliverInput, type SmtpServerOptions } from "./smtp.ts";

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
  /** A connection that has not yet been sent or read anything. */
  connect(): Promise<Client>;
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
    async connect() {
      const c = await Client.connect(port);
      clients.push(c);
      return c;
    },
  };
}

const text = (b: readonly Uint8Array[]) => Buffer.concat(b).toString("utf8");

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
  assert.equal(entry.bytes, d.size);
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

// ---------------------------------------------------------------------------
// MAIL-8 · What one stranger can make the receiver hold.
// ---------------------------------------------------------------------------

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opens a transaction up to the 354, ready for data. */
async function inData(c: Client, size?: number): Promise<void> {
  await c.command("EHLO s.example", 250);
  await c.command(`MAIL FROM:<a@b.example>${size === undefined ? "" : ` SIZE=${size}`}`, 250);
  await c.command("RCPT TO:<x@in.test>", 250);
  await c.command("DATA", 354);
}

const lines = (bytes: number) => `${"z".repeat(98)}\r\n`.repeat(Math.ceil(bytes / 100));

test("MAIL-8 · past the memory budget: 452 at DATA, 451 at the dot, and the memory is given back", async (t) => {
  // Room for a 64 KiB slab and a 128 KiB one: 192 KiB in all.
  const h = await start(t, { maxBytes: 4 * 1024 * 1024, memoryBytes: 192 * 1024 });
  const a = await h.client();
  await inData(a);
  a.send(lines(150 * 1024)); // holds both slabs
  await pause(200);

  const b = await h.client();
  await b.command("EHLO s.example", 250);
  await b.command("MAIL FROM:<a@b.example>", 250);
  await b.command("RCPT TO:<x@in.test>", 250);
  assert.match(await b.command("DATA", 452), /4\.3\.1/);

  // A needs a third slab, which does not fit: it is read to the dot and refused for now.
  a.send(`${lines(100 * 1024)}.\r\n`);
  assert.match(await a.expect(451), /4\.3\.1/);
  assert.equal(h.delivered.length, 0);
  const refused = h.logs.find((e) => e.msg === "message" && e.reply === 451);
  assert.equal(refused?.reason, "memory budget");

  // Given back: B's message now fits, and so does A's next one.
  await b.command("DATA", 354);
  b.send(`${lines(150 * 1024)}.\r\n`);
  await b.expect(250);
  await a.command("MAIL FROM:<a@b.example>", 250);
  await a.command("RCPT TO:<x@in.test>", 250);
  await a.command("DATA", 354);
  a.send("small\r\n.\r\n");
  await a.expect(250);
  assert.equal(h.delivered.length, 2);
  assert.equal(h.delivered[0]!.size, Math.ceil(150 * 1024 / 100) * 100);
  assert.equal(text(h.delivered[1]!.raw), "small\r\n");
});

test("MAIL-8 · a declared SIZE that does not fit what is left is told 452 at DATA", async (t) => {
  const h = await start(t, { maxBytes: 4 * 1024 * 1024, memoryBytes: 256 * 1024 });
  const a = await h.client();
  await inData(a);
  a.send(lines(100 * 1024)); // 192 KiB held
  await pause(200);
  const b = await h.client();
  await b.command("EHLO s.example", 250);
  await b.command("MAIL FROM:<a@b.example> SIZE=100000", 250);
  await b.command("RCPT TO:<x@in.test>", 250);
  await b.command("DATA", 452);
  await b.command("RSET", 250);
  await b.command("MAIL FROM:<a@b.example> SIZE=1000", 250);
  await b.command("RCPT TO:<x@in.test>", 250);
  await b.command("DATA", 354);
});

test("MAIL-8 · a client vanishing mid-DATA gives its memory back", async (t) => {
  const h = await start(t, { maxBytes: 4 * 1024 * 1024, memoryBytes: 192 * 1024 });
  const a = await h.client();
  await inData(a);
  a.send(lines(150 * 1024));
  await pause(200);
  a.socket.resetAndDestroy();
  await pause(100);
  const b = await h.client();
  await inData(b);
  b.send(`${lines(150 * 1024)}.\r\n`);
  await b.expect(250);
});

test("MAIL-8 · a message arrives in pieces, whole and in order, never copied into one buffer", async (t) => {
  const h = await start(t, { maxBytes: 4 * 1024 * 1024 });
  const c = await h.client();
  await inData(c);
  const body = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"q".repeat(200)}`).join("\r\n");
  c.send(`${body}\r\n.\r\n`);
  await c.expect(250);
  const d = h.delivered[0]!;
  assert.ok(d.raw.length > 1, "held in more than one piece");
  assert.equal(d.size, d.raw.reduce((n, p) => n + p.length, 0));
  assert.equal(text(d.raw), `${body}\r\n`);
});

test("MAIL-8 · past the connection cap a newcomer is told 421 and let go", async (t) => {
  const h = await start(t, { maxConnections: 2, maxPerAddress: 10 });
  await h.client();
  const second = await h.client();
  const third = await h.connect();
  assert.match(await third.expect(421), /4\.7\.0 .*Too many connections/);
  await third.waitClosed();
  second.end();
  await pause(100);
  await h.client(); // a place came free
});

test("MAIL-8 · past the per-address cap a newcomer from that address is told 421", async (t) => {
  const h = await start(t, { maxConnections: 10, maxPerAddress: 2 });
  const first = await h.client();
  await h.client();
  const third = await h.connect();
  assert.match(await third.expect(421), /from your address/);
  await third.waitClosed();
  assert.ok(h.logs.some((e) => e.msg === "too many connections from one address"));
  await first.command("QUIT", 221);
  await first.waitClosed();
  await pause(100);
  await h.client();
});

test("MAIL-8 · behind a proxy, the PROXY line names the client the caps and the log use", async (t) => {
  const h = await start(t, { proxyProtocol: true, maxPerAddress: 1 });
  const viaProxy = async (source: string) => {
    const c = await h.connect();
    c.send(`PROXY TCP4 ${source} 10.0.0.1 40000 25\r\n`);
    return c;
  };
  const a = await viaProxy("203.0.113.5");
  await a.expect(220);
  const b = await viaProxy("198.51.100.7"); // same socket address as a, another client
  await b.expect(220);
  const again = await viaProxy("203.0.113.5");
  assert.match(await again.expect(421), /from your address/);

  await inData(a);
  a.send("x\r\n.\r\n");
  await a.expect(250);
  assert.equal(h.delivered[0]!.remoteAddress, "203.0.113.5");

  const bad = await h.connect();
  bad.send("EHLO no-proxy-line\r\n");
  await bad.waitClosed();
});

test("MAIL-8 · PROXY lines: v1 TCP4/TCP6, UNKNOWN, and anything else refused", () => {
  assert.equal(parseProxyLine("PROXY TCP4 203.0.113.5 10.0.0.1 1 25", "p"), "203.0.113.5");
  assert.equal(parseProxyLine("PROXY TCP6 2001:db8::1 2001:db8::2 1 25", "p"), "2001:db8::1");
  assert.equal(parseProxyLine("PROXY UNKNOWN", "p"), "p");
  for (const bad of [
    "EHLO x", "PROXY TCP4 2001:db8::1 10.0.0.1 1 25", "PROXY TCP4 nope 10.0.0.1 1 25",
    "PROXY TCP4 1.2.3.4", "PROXY UDP4 1.2.3.4 1.2.3.4 1 2",
  ]) {
    assert.equal(parseProxyLine(bad, "p"), null, bad);
  }
});

test("MAIL-8 · a session ends at its time limit however busy it keeps", async (t) => {
  // A fake clock for the session timer alone: node's mock timers would also
  // fake the sockets' own, and the test's.
  let now = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const tick = (ms: number) => {
    now += ms;
    for (const timer of timers) if (timer.live && timer.at <= now) { timer.live = false; timer.fn(); }
  };
  const h = await start(t, {
    sessionTimeoutMs: 10 * 60_000,
    schedule(fn, ms) {
      const timer = { at: now + ms, fn, live: true };
      timers.push(timer);
      return () => { timer.live = false; };
    },
  });
  const c = await h.client();
  await inData(c);
  // A byte now and then resets the idle timer, never the session's.
  for (let minute = 1; minute < 10; minute++) {
    tick(60_000);
    c.send("z");
    await pause(10);
  }
  assert.equal(c.closed, false);
  assert.equal(c.buffer, "");
  tick(60_000);
  assert.match(await c.expect(421), /4\.4\.2 .*Session time limit/);
  await c.waitClosed();
  assert.equal(h.delivered.length, 0);
  assert.ok(h.logs.some((e) => e.msg === "session time limit"));
});

test("MAIL-9 · a recipient check that answers later holds the session until it does", async (t) => {
  let release: (v: "ok") => void = () => {};
  const h = await start(t, {
    checkRecipient: (a) => a.startsWith("slow")
      ? new Promise((r) => { release = r; })
      : Promise.resolve({ code: 451, message: "4.4.3 Mailbox service unavailable, try again later" }),
  });
  const c = await h.client();
  await c.command("EHLO s.example", 250);
  await c.command("MAIL FROM:<a@b.example>", 250);
  // Pipelined: nothing after the RCPT is acted on before its answer.
  c.send("RCPT TO:<slow@in.test>\r\nRCPT TO:<down@in.test>\r\nDATA\r\n");
  await pause(100);
  assert.equal(c.buffer, "");
  release("ok");
  await c.expect(250);
  assert.match(await c.expect(451), /4\.4\.3/);
  await c.expect(354);
  c.send("x\r\n.\r\n");
  await c.expect(250);
  assert.deepEqual(h.delivered[0]!.recipients, ["slow@in.test"]);
});
