/**
 * FWD-2 · Routing and the signed hand-off, plus the assembled receiver
 * (`startMx`) end to end with a fake app behind a fake fetch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { parseRoutes, resolveRecipient, relayMessage, type Route } from "./relay.ts";
import { loadMxConfig, startMx } from "./main.ts";
import { verifyInbound, SIGNATURE_HEADER, RECIPIENT_HEADER } from "../mail/signature.ts";

const ROUTES = JSON.stringify({
  ab12cd: { url: "https://hh1.example.com/", secret: "s1" },
  "": { url: "http://app:3000", secret: "self" },
});

test("parseRoutes accepts https, localhost and compose service names, and trims trailing slashes", () => {
  const routes = parseRoutes(JSON.stringify({
    AB12CD: { url: "https://hh1.example.com/base/", secret: "s1" },
    "": { url: "http://app:3000", secret: "self" },
    local: { url: "http://localhost:8080", secret: "x" },
    loop: { url: "http://127.0.0.1:8080", secret: "x" },
  }));
  assert.deepEqual(routes.get("ab12cd"), { url: "https://hh1.example.com/base", secret: "s1" });
  assert.deepEqual(routes.get(""), { url: "http://app:3000", secret: "self" });
  assert.equal(routes.size, 4);
});

test("parseRoutes refuses bad config with a clear message", () => {
  const bad: [string | undefined, RegExp][] = [
    [undefined, /MX_ROUTES is not set/],
    ["  ", /MX_ROUTES is not set/],
    ["{not json", /not valid JSON/],
    ["[]", /must be a JSON object/],
    ["{}", /no routes/],
    [JSON.stringify({ "a-b": { url: "https://x.example", secret: "s" } }), /letters and digits/],
    [JSON.stringify({ a: { url: "https://x.example", secret: "" } }), /secret must be a non-empty string/],
    [JSON.stringify({ a: { url: "https://x.example" } }), /secret/],
    [JSON.stringify({ a: { url: "nope", secret: "s" } }), /not a valid URL/],
    [JSON.stringify({ a: { url: "http://hh.example.com", secret: "s" } }), /must use https/],
    [JSON.stringify({ a: { url: "ftp://x.example", secret: "s" } }), /must use https/],
    [JSON.stringify({ a: { url: "https://x.example?q=1", secret: "s" } }), /query/],
    [JSON.stringify({ a: "https://x.example" }), /must be an object/],
    [JSON.stringify({ a: { url: "https://x.example", secret: "s" }, A: { url: "https://y.example", secret: "t" } }), /twice/],
  ];
  for (const [json, message] of bad) assert.throws(() => parseRoutes(json), message, String(json));
  // The secret never appears in an error.
  assert.throws(() => parseRoutes(JSON.stringify({ a: { url: "http://x.example", secret: "topsecret" } })),
    (err: Error) => !err.message.includes("topsecret"));
});

test("resolveRecipient: route.token form, case, plus-tags, wrong domain, unknown route", () => {
  const routes = parseRoutes(ROUTES);
  const ok = resolveRecipient("AB12CD.K3J5MZ+hdfc@In.Pathayam.App.", "in.pathayam.app", routes);
  assert.ok("recipient" in ok);
  assert.equal(ok.recipient, "ab12cd.k3j5mz@in.pathayam.app");
  assert.equal(ok.route.secret, "s1");

  const self = resolveRecipient("K3J5MZ@in.pathayam.app", "in.pathayam.app", routes);
  assert.ok("recipient" in self);
  assert.equal(self.recipient, "k3j5mz@in.pathayam.app");
  assert.equal(self.route.secret, "self");

  const denied = resolveRecipient("ab12cd.tok@gmail.com", "in.pathayam.app", routes);
  assert.deepEqual(denied, { code: 550, message: "5.7.1 Relay access denied" });
  for (const a of ["zz99.tok@in.pathayam.app", "ab12cd.to.k@in.pathayam.app", "ab12cd.@in.pathayam.app", "+x@in.pathayam.app", "a_b@in.pathayam.app"]) {
    const r = resolveRecipient(a, "in.pathayam.app", routes);
    assert.ok("code" in r && r.code === 550 && r.message.startsWith("5.1.1"), a);
  }
  assert.ok("code" in resolveRecipient("noat", "in.pathayam.app", routes));

  // With no "" route, a bare token is unknown.
  const hostedOnly = parseRoutes(JSON.stringify({ ab12cd: { url: "https://h.example", secret: "s" } }));
  assert.ok("code" in resolveRecipient("tok@in.pathayam.app", "in.pathayam.app", hostedOnly));
});

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const ROUTE: Route = { url: "https://hh1.example.com", secret: "s1" };
const RAW = new Uint8Array(Buffer.from("Subject: x\r\n\r\nbody\r\n"));

test("relayMessage posts the raw bytes, signed for the recipient", async () => {
  const now = new Date("2026-11-08T10:00:00Z");
  const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 202 }));
  const r = await relayMessage(ROUTE, "ab12cd.tok@in.pathayam.app", RAW, fetchImpl, now);
  assert.deepEqual(r, { code: 250, message: "2.0.0 OK" });
  const call = calls[0]!;
  assert.equal(call.url, "https://hh1.example.com/inbound/email");
  assert.equal(call.init.method, "POST");
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("content-type"), "message/rfc822");
  assert.equal(headers.get(RECIPIENT_HEADER), "ab12cd.tok@in.pathayam.app");
  assert.equal(call.init.body, RAW);
  assert.ok(verifyInbound("s1", headers.get(SIGNATURE_HEADER), "ab12cd.tok@in.pathayam.app", RAW, now));
  assert.ok(!verifyInbound("s1", headers.get(SIGNATURE_HEADER), "other.tok@in.pathayam.app", RAW, now));
  assert.ok(!verifyInbound("wrong", headers.get(SIGNATURE_HEADER), "ab12cd.tok@in.pathayam.app", RAW, now));
});

test("relayMessage maps app answers to SMTP replies", async () => {
  const cases: [number, number, RegExp][] = [
    [202, 250, /^2\.0\.0/],
    [404, 550, /^5\.1\.1/],
    [413, 552, /^5\.3\.4/],
    [400, 554, /HTTP 400/],
    [401, 554, /HTTP 401/],
    [403, 554, /HTTP 403/],
    [429, 451, /^4\.3\.0/],
    [500, 451, /^4\.3\.0/],
    [503, 451, /^4\.3\.0/],
    [302, 451, /^4\.3\.0/],
  ];
  for (const [status, code, message] of cases) {
    const { fetchImpl } = fakeFetch(() => new Response(status === 302 ? null : "x", { status }));
    const r = await relayMessage(ROUTE, "a.b@in.test", RAW, fetchImpl);
    assert.equal(r.code, code, `HTTP ${status}`);
    assert.match(r.message, message, `HTTP ${status}`);
  }
});

test("relayMessage turns network errors and timeouts into 451", async () => {
  const network = fakeFetch(() => { throw new TypeError("fetch failed"); });
  assert.deepEqual(await relayMessage(ROUTE, "a.b@in.test", RAW, network.fetchImpl),
    { code: 451, message: "4.3.0 Mailbox service unreachable, try again later" });
  const timeout = fakeFetch(() => { throw new DOMException("timed out", "TimeoutError"); });
  assert.match((await relayMessage(ROUTE, "a.b@in.test", RAW, timeout.fetchImpl)).message, /timed out/);
  // The real signal is a 30 s timeout.
  assert.ok(network.calls[0]!.init.signal instanceof AbortSignal);
});

test("loadMxConfig: defaults, required vars, number checks, TLS both-or-neither", () => {
  const base = { MX_DOMAIN: "In.Pathayam.App", MX_ROUTES: ROUTES };
  const c = loadMxConfig(base);
  assert.equal(c.domain, "in.pathayam.app");
  assert.equal(c.hostname, "in.pathayam.app");
  assert.equal(c.port, 25);
  assert.equal(c.maxBytes, 26_214_400);
  assert.equal(c.tls, undefined);
  assert.equal(loadMxConfig({ ...base, MX_HOSTNAME: "mx1.pathayam.app" }).hostname, "mx1.pathayam.app");
  assert.throws(() => loadMxConfig({ MX_ROUTES: ROUTES }), /MX_DOMAIN is required/);
  assert.throws(() => loadMxConfig({ MX_DOMAIN: "bad domain", MX_ROUTES: ROUTES }), /MX_DOMAIN/);
  assert.throws(() => loadMxConfig({ MX_DOMAIN: "in.test" }), /MX_ROUTES is not set/);
  assert.throws(() => loadMxConfig({ ...base, MX_PORT: "70000" }), /MX_PORT/);
  assert.throws(() => loadMxConfig({ ...base, MX_MAX_BYTES: "lots" }), /MX_MAX_BYTES/);
  assert.throws(() => loadMxConfig({ ...base, MX_TLS_CERT: "pem" }), /both a certificate and a key/);
  assert.throws(() => loadMxConfig({ ...base, MX_TLS_KEY_FILE: "/nonexistent/key.pem", MX_TLS_CERT: "pem" }), /MX_TLS_KEY_FILE: cannot read/);
});

test("startMx refuses an unloadable TLS pair", async () => {
  await assert.rejects(
    startMx({ MX_DOMAIN: "in.test", MX_ROUTES: ROUTES, MX_PORT: "0", MX_TLS_CERT: "nope", MX_TLS_KEY: "nope" }, { log: () => {} }),
    /TLS certificate\/key could not be loaded/,
  );
});

/** Sends lines one at a time and collects the reply code to each. */
async function dialog(port: number, lines: string[]): Promise<number[]> {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  let buffer = "";
  const codes: number[] = [];
  const nextReply = async (): Promise<number> => {
    for (let i = 0; i < 200; i++) {
      const m = /^(?:\d{3}-[^\n]*\n)*(\d{3})[^\n]*\n/.exec(buffer);
      if (m) {
        buffer = buffer.slice(m[0].length);
        return Number(m[1]);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no reply; unread ${JSON.stringify(buffer)}`);
  };
  socket.on("data", (d) => { buffer += d.toString("utf8"); });
  await nextReply(); // banner
  for (const line of lines) {
    socket.write(`${line}\r\n`);
    codes.push(await nextReply());
  }
  socket.destroy();
  return codes;
}

test("startMx end to end: routes, self-host form, plus-tags, 404 from the app, dedupe", async (t) => {
  const logs: Record<string, unknown>[] = [];
  const { fetchImpl, calls } = fakeFetch(({ init }) => {
    const recipient = new Headers(init.headers).get(RECIPIENT_HEADER);
    return new Response(null, { status: recipient?.includes("gone") ? 404 : 202 });
  });
  const mx = await startMx(
    { MX_DOMAIN: "in.pathayam.app", MX_ROUTES: ROUTES, MX_PORT: "0", MX_HOSTNAME: "mx.test" },
    { log: (e) => logs.push(e), fetchImpl },
  );
  t.after(() => mx.close(500));

  const codes = await dialog(mx.port, [
    "EHLO bank.example",
    "MAIL FROM:<alerts@bank.example>",
    "RCPT TO:<ab12cd.tok+hdfc@IN.pathayam.app>",
    "RCPT TO:<ab12cd.tok+icici@in.pathayam.app>",
    "RCPT TO:<selfhosttok@in.pathayam.app>",
    "RCPT TO:<zz99.tok@in.pathayam.app>",
    "RCPT TO:<ab12cd.tok@evil.example>",
    "DATA",
    "Subject: debit\r\n\r\nRs 100\r\n.",
    "MAIL FROM:<alerts@bank.example>",
    "RCPT TO:<ab12cd.gone@in.pathayam.app>",
    "DATA",
    "x\r\n.",
    "QUIT",
  ]);
  assert.deepEqual(codes, [250, 250, 250, 250, 250, 550, 550, 354, 250, 250, 250, 354, 550, 221]);

  // Two plus-tagged RCPTs for one mailbox are one hand-off; the self-host one goes to its own route.
  const first = calls.slice(0, 2).map((c) => [c.url, new Headers(c.init.headers).get(RECIPIENT_HEADER)]);
  assert.deepEqual(first.sort(), [
    ["http://app:3000/inbound/email", "selfhosttok@in.pathayam.app"],
    ["https://hh1.example.com/inbound/email", "ab12cd.tok@in.pathayam.app"],
  ]);
  assert.equal(calls.length, 3);
  const body = calls[0]!.init.body as Uint8Array;
  assert.equal(Buffer.from(body).toString("utf8"), "Subject: debit\r\n\r\nRs 100\r\n");
  for (const c of calls) {
    const h = new Headers(c.init.headers);
    const secret = c.url.startsWith("http://app") ? "self" : "s1";
    assert.ok(verifyInbound(secret, h.get(SIGNATURE_HEADER), h.get(RECIPIENT_HEADER)!, c.init.body as Uint8Array));
  }
  const messages = logs.filter((e) => e.msg === "message");
  assert.deepEqual(messages.map((e) => e.reply), [250, 550]);
  assert.doesNotMatch(JSON.stringify(logs), /Rs 100|debit|"s1"|self"/);
});

test("startMx: a 401 from the app is a 554 and an error log naming the route", async (t) => {
  const logs: Record<string, unknown>[] = [];
  const { fetchImpl } = fakeFetch(() => new Response(null, { status: 401 }));
  const mx = await startMx({ MX_DOMAIN: "in.test", MX_ROUTES: ROUTES, MX_PORT: "0" }, { log: (e) => logs.push(e), fetchImpl });
  t.after(() => mx.close(500));
  const codes = await dialog(mx.port, ["HELO x", "MAIL FROM:<a@b.example>", "RCPT TO:<tok@in.test>", "DATA", "x\r\n."]);
  assert.deepEqual(codes, [250, 250, 250, 354, 554]);
  const err = logs.find((e) => e.level === "error");
  assert.ok(err);
  assert.equal(err.route, "http://app:3000");
});
