/**
 * TLS-1 · The receiver with MX_TLS_ACME_DOMAIN: it answers at once, offers
 * STARTTLS as soon as Let's Encrypt (here the fake CA) has issued, swaps a
 * renewed certificate in for new sessions while an open one carries on, and
 * an explicit MX_TLS_CERT still wins.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMxConfig, startMx } from "./main.ts";
import { CloudflareSolver } from "../tls/cloudflare.ts";
import { startFakeAcme, startFakeCloudflare } from "../tls/fakes.test-data.ts";

const ROUTES = JSON.stringify({ "": { url: "http://127.0.0.1:9", secret: "x".repeat(32) } });

/** Reads SMTP replies (multi-line aware) from a socket that can be swapped for its TLS upgrade. */
class Session {
  private buf = "";
  private waiter: (() => void) | null = null;
  socket: net.Socket;
  constructor(socket: net.Socket) {
    this.socket = socket;
    this.listen(socket);
  }
  private listen(s: net.Socket) {
    s.on("data", (d: Buffer) => { this.buf += d.toString(); this.waiter?.(); });
  }
  static open(port: number): Promise<Session> {
    return new Promise((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1", () => resolve(new Session(s)));
      s.on("error", reject);
    });
  }
  async reply(): Promise<string> {
    for (;;) {
      const m = this.buf.match(/^((?:\d{3}-.*\r\n)*\d{3} .*\r\n)/);
      if (m) {
        this.buf = this.buf.slice(m[1]!.length);
        return m[1]!;
      }
      await new Promise<void>((r) => { this.waiter = r; });
    }
  }
  async command(line: string): Promise<string> {
    this.socket.write(`${line}\r\n`);
    return this.reply();
  }
  async startTls(ca: string): Promise<tls.PeerCertificate> {
    assert.match(await this.command("STARTTLS"), /^220/);
    this.socket.removeAllListeners("data");
    const secure = tls.connect({ socket: this.socket, ca, servername: "in.pathayam.app" });
    await new Promise<void>((resolve, reject) => { secure.once("secureConnect", resolve); secure.once("error", reject); });
    this.socket = secure;
    this.listen(secure);
    return secure.getPeerCertificate();
  }
}

test("the receiver gets a certificate, offers STARTTLS with it, and hot-swaps a renewal", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pathayam-mx-acme-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cf = await startFakeCloudflare({ token: "tok", zoneName: "pathayam.app" });
  // 20-day certificates are always under the 30-day mark, so a check renews.
  const ca = await startFakeAcme({ txt: (n) => cf.txt(n), validForMs: 20 * 86_400_000 });
  t.after(() => cf.close());
  t.after(() => ca.close());

  const logs: Record<string, unknown>[] = [];
  const mx = await startMx({
    MX_DOMAIN: "in.pathayam.app", MX_ROUTES: ROUTES, MX_PORT: "0",
    MX_TLS_ACME_DOMAIN: "in.pathayam.app", ACME_DIRECTORY: ca.directoryUrl, ACME_DIR: join(dir, "acme"),
    CLOUDFLARE_API_TOKEN: "tok",
  }, {
    log: (e) => logs.push(e),
    acme: {
      solver: new CloudflareSolver({ token: "tok", apiBase: cf.apiBase }),
      client: { sleep: async () => {}, propagation: { lookup: async (_s, n) => cf.txt(n), timeoutMs: 0 } },
    },
  });
  t.after(() => mx.close(100));
  assert.equal(logs[0]!.tls, "lets-encrypt");
  await mx.acmeReady;
  assert.ok(mx.acme?.current(), "a certificate was issued");
  assert.equal(cf.records.size, 0);

  const s1 = await Session.open(mx.port);
  assert.match(await s1.reply(), /^220 /);
  assert.match(await s1.command("EHLO sender.example"), /250[- ]STARTTLS/);
  const cert1 = await s1.startTls(ca.caPem);
  assert.match(await s1.command("EHLO sender.example"), /^250/);

  assert.equal(await mx.acme!.check(), true, "renewed");
  // The open session carries on over its TLS connection.
  assert.match(await s1.command("NOOP"), /^250/);
  // A new session is handed the renewed certificate.
  const s2 = await Session.open(mx.port);
  await s2.reply();
  await s2.command("EHLO sender.example");
  const cert2 = await s2.startTls(ca.caPem);
  assert.notEqual(cert2.serialNumber, cert1.serialNumber);
  s1.socket.destroy();
  s2.socket.destroy();
});

test("explicit MX_TLS_CERT wins over MX_TLS_ACME_DOMAIN; the token is required when ACME is on", () => {
  const base = { MX_DOMAIN: "in.pathayam.app", MX_ROUTES: ROUTES };
  assert.throws(() => loadMxConfig({ ...base, MX_TLS_ACME_DOMAIN: "in.pathayam.app" }), /Let's Encrypt for the receiver: .*CLOUDFLARE_API_TOKEN/);
  const acme = loadMxConfig({ ...base, MX_TLS_ACME_DOMAIN: "in.pathayam.app", CLOUDFLARE_API_TOKEN: "tok", DATA_DIR: "/data" });
  assert.equal(acme.acme?.dir, "/data/acme");
  assert.equal(acme.tls, undefined);
  const both = loadMxConfig({
    ...base, MX_TLS_ACME_DOMAIN: "in.pathayam.app", CLOUDFLARE_API_TOKEN: "tok", MX_TLS_CERT: "CERT", MX_TLS_KEY: "KEY",
  });
  assert.equal(both.acme, undefined);
  assert.equal(both.acmeIgnored, true);
  assert.deepEqual(both.tls, { cert: "CERT", key: "KEY" });
  assert.equal(loadMxConfig(base).acme, undefined);
});
