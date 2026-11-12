/**
 * TLS-1 · The renewal scheduler on a fake clock: first certificate at start,
 * a check every twelve hours, renewal under thirty days, backoff on failure
 * with the old certificate kept, and reuse of what is on disk after a restart.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BACKOFF_MS, CHECK_EVERY_MS, DAY_MS, createAcmeManager, createCertManager, type Clock,
} from "./manager.ts";
import { AcmeStore, type CertBundle } from "./store.ts";
import { generateEcKeyPem } from "./jose.ts";
import { createTestCa, startFakeAcme, startFakeCloudflare } from "./fakes.test-data.ts";
import { CloudflareSolver } from "./cloudflare.ts";
import { loadAcmeSettings, type AcmeSettings } from "./settings.ts";

const START = Date.parse("2026-11-12T00:00:00Z");

function fakeClock(): Clock & { advance(ms: number): Promise<void>; pending(): number[] } {
  let now = START;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  return {
    now: () => now,
    setTimeout(fn, ms) {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout(h) { timers.delete(h as number); },
    pending: () => [...timers.values()].map((t) => t.at - now),
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = until;
    },
  };
}

function tempDir(t: { after(fn: () => unknown): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "pathayam-acme-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "acme");
}

const DOMAINS = ["in.pathayam.app"];
const DIRECTORY = "https://acme.test/directory";

function harness(t: { after(fn: () => unknown): void }, opts: { dir?: string; validDays?: number } = {}) {
  const clock = fakeClock();
  const ca = createTestCa(clock.now);
  const dir = opts.dir ?? tempDir(t);
  const store = new AcmeStore(dir);
  const state = { issued: 0, failNext: 0, validDays: opts.validDays ?? 90 };
  const used: CertBundle[] = [];
  const logs: Record<string, unknown>[] = [];
  const manager = createCertManager({
    domains: DOMAINS,
    directoryUrl: DIRECTORY,
    store,
    clock,
    log: (e) => logs.push(e),
    onCert: (b) => used.push(b),
    async issue(domains) {
      if (state.failNext > 0) {
        state.failNext--;
        throw new Error("rateLimited: too many failed authorizations");
      }
      state.issued++;
      const keyPem = generateEcKeyPem();
      const spki = createPublicKey(createPrivateKey(keyPem)).export({ type: "spki", format: "der" });
      return { certPem: ca.issue(spki, domains, state.validDays * DAY_MS) + ca.certPem, keyPem };
    },
  });
  t.after(() => manager.stop());
  return { clock, store, state, used, logs, manager, dir };
}

test("with nothing stored, a certificate is requested at start, saved 0600, and checked again in 12 hours", async (t) => {
  const h = harness(t);
  await h.manager.start();
  assert.equal(h.state.issued, 1);
  assert.equal(h.used.length, 1);
  assert.equal(h.manager.current(), h.used[0]);
  assert.deepEqual(h.clock.pending(), [CHECK_EVERY_MS]);
  assert.equal(statSync(h.dir).mode & 0o777, 0o700);
  for (const f of readdirSync(h.dir)) assert.equal(statSync(join(h.dir, f)).mode & 0o777, 0o600, f);
  assert.ok(readdirSync(h.dir).includes("cert-in.pathayam.app.pem"));
});

test("renews only once fewer than 30 days are left, on a 12-hourly check", async (t) => {
  const h = harness(t);
  await h.manager.start();
  await h.clock.advance(60 * DAY_MS); // 90-day certificate: exactly 30 days left, not yet due
  assert.equal(h.state.issued, 1);
  await h.clock.advance(CHECK_EVERY_MS);
  assert.equal(h.state.issued, 2, "renewed at the first check under 30 days");
  assert.equal(h.used.length, 2);
  assert.ok(h.used[1]!.notAfter > h.used[0]!.notAfter);
  assert.deepEqual(h.clock.pending(), [CHECK_EVERY_MS]);
});

test("a failed renewal keeps the old certificate, backs off, and recovers", async (t) => {
  const h = harness(t);
  await h.manager.start();
  const first = h.manager.current();
  await h.clock.advance(60 * DAY_MS); // the next check is the first one due
  h.state.failNext = 3;
  await h.clock.advance(CHECK_EVERY_MS);
  assert.equal(h.manager.current(), first, "still serving the old certificate");
  assert.deepEqual(h.clock.pending(), [BACKOFF_MS[0]]);
  const failure = h.logs.find((l) => l.level === "error")!;
  assert.match(String(failure.msg), /still serving the current certificate/);
  assert.equal(failure.retryInMinutes, 10);
  assert.equal(typeof failure.daysLeft, "number");

  await h.clock.advance(BACKOFF_MS[0]!);
  assert.deepEqual(h.clock.pending(), [BACKOFF_MS[1]]);
  await h.clock.advance(BACKOFF_MS[1]!);
  assert.deepEqual(h.clock.pending(), [BACKOFF_MS[2]]);
  await h.clock.advance(BACKOFF_MS[2]!);
  assert.notEqual(h.manager.current(), first, "the fourth attempt succeeded");
  assert.deepEqual(h.clock.pending(), [CHECK_EVERY_MS], "and the backoff is reset");
});

test("backoff never waits longer than the 12-hour check", async (t) => {
  const h = harness(t);
  h.state.failNext = 100;
  await h.manager.start();
  assert.equal(h.used.length, 0);
  for (const step of [...BACKOFF_MS, CHECK_EVERY_MS, CHECK_EVERY_MS]) {
    assert.deepEqual(h.clock.pending(), [Math.min(step, CHECK_EVERY_MS)]);
    await h.clock.advance(step);
  }
  assert.match(String(h.logs.at(-1)!.msg), /serving without TLS for now/);
});

test("after a restart the stored certificate is used without a new order", async (t) => {
  const first = harness(t);
  await first.manager.start();
  first.manager.stop();
  const second = harness(t, { dir: first.dir });
  await second.manager.start();
  assert.equal(second.state.issued, 0);
  assert.equal(second.used.length, 1);
  assert.equal(second.used[0]!.certPem, first.used[0]!.certPem);
});

test("a stored certificate from another ACME directory, or for other names, is replaced", async (t) => {
  const h = harness(t);
  await h.manager.start();
  const store = new AcmeStore(h.dir);
  const stored = store.loadCertificate(DOMAINS)!;
  store.saveCertificate({ ...stored, directoryUrl: "https://staging.test/directory" });
  const again = harness(t, { dir: h.dir });
  await again.manager.start();
  assert.equal(again.state.issued, 1);
  assert.ok(again.logs.some((l) => /another ACME directory/.test(String(l.msg))));
});

test("a certificate that cannot be saved is still served, and not ordered again", async (t) => {
  const parent = tempDir(t);
  mkdirSync(dirname(parent), { recursive: true });
  writeFileSync(parent, "a file, so nothing can be made under it");
  const h = harness(t, { dir: join(parent, "acme") });
  await h.manager.start();
  assert.equal(h.used.length, 1);
  assert.ok(h.logs.some((l) => l.level === "error" && /not saved/.test(String(l.msg))));
  assert.deepEqual(h.clock.pending(), [CHECK_EVERY_MS], "no retry: the certificate is good");
});

test("two checks at once place one order", async (t) => {
  const h = harness(t);
  await Promise.all([h.manager.check(), h.manager.check(), h.manager.start()]);
  assert.equal(h.state.issued, 1);
});

test("createAcmeManager: account key and URL are kept, and reused on the next order", async (t) => {
  const cf = await startFakeCloudflare({ token: "t", zoneName: "pathayam.app" });
  const ca = await startFakeAcme({ txt: (n) => cf.txt(n), validForMs: 20 * DAY_MS });
  t.after(() => cf.close());
  t.after(() => ca.close());
  const settings: AcmeSettings = loadAcmeSettings({
    MX_TLS_ACME_DOMAIN: "in.pathayam.app", ACME_DIRECTORY: ca.directoryUrl, CLOUDFLARE_API_TOKEN: "t", ACME_DIR: tempDir(t),
  }, "MX_TLS_ACME_DOMAIN")!;
  const used: CertBundle[] = [];
  const opts = {
    solver: new CloudflareSolver({ token: "t", apiBase: cf.apiBase }),
    client: { sleep: async () => {}, propagation: { lookup: async (_s: string, n: string) => cf.txt(n), timeoutMs: 0 } },
  };
  const m1 = createAcmeManager(settings, (b) => used.push(b), opts);
  await m1.start();
  m1.stop();
  assert.equal(used.length, 1);
  const accountFiles = readdirSync(settings.dir).filter((f) => f.startsWith("account-"));
  assert.deepEqual(accountFiles.sort(), ["account-127.0.0.1_" + new URL(ca.directoryUrl).port + ".json", "account-127.0.0.1_" + new URL(ca.directoryUrl).port + ".key.pem"]);
  ca.log.length = 0;
  // 20-day certificates are always due: a second manager loads the stored one,
  // then renews at once, with the same account.
  const m2 = createAcmeManager(settings, (b) => used.push(b), opts);
  await m2.start();
  m2.stop();
  assert.equal(used.length, 3);
  assert.equal(used[1]!.certPem, used[0]!.certPem);
  assert.notEqual(used[2]!.certPem, used[0]!.certPem);
  assert.ok(!ca.log.includes("/new-account"));
  assert.equal(ca.accounts.size, 1);
});
