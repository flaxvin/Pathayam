/**
 * TLS-1 · The app's HTTPS listener: starts on the first certificate, swaps a
 * renewed one in without closing open connections, and the plain port
 * redirects to BASE_URL once HTTPS is live, keeping /healthz.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { AddressInfo } from "node:net";
import { createHttpsFrontend, redirectingListener } from "./https.ts";
import { generateEcKeyPem } from "./jose.ts";
import { createTestCa } from "./fakes.test-data.ts";
import type { CertBundle } from "./store.ts";

const ca = createTestCa();

function bundle(): CertBundle {
  const keyPem = generateEcKeyPem();
  const spki = createPublicKey(createPrivateKey(keyPem)).export({ type: "spki", format: "der" });
  const certPem = ca.issue(spki, ["localhost"], 90 * 86_400_000) + ca.certPem;
  return { certPem, keyPem, domains: ["localhost"], directoryUrl: "x", notAfter: new Date(new X509Certificate(certPem).validTo) };
}

const app = (req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`app ${req.url}`);
};

function peerSerial(port: number, agent: https.Agent): Promise<{ serial: string; body: string; socket: tls.TLSSocket }> {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: "127.0.0.1", port, path: "/x", servername: "localhost", ca: ca.certPem, agent }, (res) => {
      const socket = res.socket as tls.TLSSocket;
      const serial = socket.getPeerCertificate().serialNumber;
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ serial, body, socket }));
    });
    req.on("error", reject);
  });
}

test("HTTPS starts with the first certificate and takes a renewed one without closing open connections", async (t) => {
  const front = createHttpsFrontend({ port: 0, host: "127.0.0.1", listener: app });
  t.after(() => front.close());
  assert.equal(front.live(), false);
  front.onCert(bundle());
  const port = await front.listening;
  assert.equal(front.live(), true);

  const keep = new https.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => keep.destroy());
  const first = await peerSerial(port, keep);
  assert.equal(first.body, "app /x");

  front.onCert(bundle());
  // The kept-alive connection is still the old one, with the old certificate.
  const again = await peerSerial(port, keep);
  assert.equal(again.serial, first.serial);
  assert.equal(again.socket, first.socket);
  // A new connection gets the new certificate.
  const fresh = await peerSerial(port, new https.Agent({ keepAlive: false }));
  assert.notEqual(fresh.serial, first.serial);
});

test("the plain port serves the app until HTTPS is live, then redirects all but /healthz to BASE_URL", async (t) => {
  let live = false;
  const server = createServer(redirectingListener(app, () => live, "https://budget.example.com"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  assert.equal(await (await fetch(`${base}/budget`)).text(), "app /budget");
  live = true;
  const moved = await fetch(`${base}/budget?month=2026-11`, { redirect: "manual", headers: { Host: "evil.example" } });
  assert.equal(moved.status, 308);
  assert.equal(moved.headers.get("location"), "https://budget.example.com/budget?month=2026-11");
  assert.equal(await (await fetch(`${base}/healthz`)).text(), "app /healthz");
});

test("REV-1 · once HTTPS is live, the mail receiver's signed hand-offs still reach the app on the plain port", async (t) => {
  // compose.yaml points the receiver at http://pathayam:8080; it never follows
  // a redirect (a redirect would re-send the message unsigned-for), so a 308
  // here was a 451 for every forwarded message, for as long as HTTPS was on.
  const server = createServer(redirectingListener(app, () => true, "https://budget.example.com"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  for (const path of ["/inbound/email", "/inbound/check"]) {
    const res = await fetch(`${base}${path}`, { method: "POST", body: "x", redirect: "manual" });
    assert.equal(res.status, 200, path);
    assert.equal(await res.text(), `app ${path}`);
  }
  // Only those two: anything else is a browser's, and moves.
  assert.equal((await fetch(`${base}/inbound/emailx`, { redirect: "manual" })).status, 308);
});
