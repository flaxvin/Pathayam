/**
 * TLS-1 · A whole Let's Encrypt order, end to end, against the in-process fake
 * CA and fake Cloudflare API: account, order, DNS-01 through Cloudflare,
 * finalize with our CSR, the chain back, and the TXT records gone afterwards,
 * including when something fails. No network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { AcmeClient, AcmeError } from "./acme.ts";
import { CloudflareSolver } from "./cloudflare.ts";
import { waitForTxt } from "./dns.ts";
import { generateEcKeyPem } from "./jose.ts";
import { startFakeAcme, startFakeCloudflare } from "./fakes.test-data.ts";

const TOKEN = "cf-test-token-not-real";

async function setup(t: { after(fn: () => unknown): void }) {
  const cf = await startFakeCloudflare({ token: TOKEN, zoneName: "pathayam.app" });
  const ca = await startFakeAcme({ txt: (name) => cf.txt(name) });
  t.after(() => cf.close());
  t.after(() => ca.close());
  const solver = new CloudflareSolver({ token: TOKEN, apiBase: cf.apiBase });
  const logs: Record<string, unknown>[] = [];
  const client = (accountKeyPem = generateEcKeyPem(), accountUrl: string | null = null) => new AcmeClient({
    directoryUrl: ca.directoryUrl,
    accountKeyPem,
    accountUrl,
    email: "ops@example.com",
    sleep: async () => {},
    log: (e) => logs.push(e),
    propagation: { lookup: async (_server, name) => cf.txt(name), sleep: async () => {}, timeoutMs: 0 },
  });
  return { cf, ca, solver, client, logs };
}

test("issues a certificate by DNS-01 on Cloudflare and removes the TXT record", async (t) => {
  const { cf, ca, solver, client, logs } = await setup(t);
  const c = client();
  const issued = await c.obtainCertificate(["in.pathayam.app"], solver);

  const leaf = new X509Certificate(issued.certPem);
  assert.equal(leaf.subjectAltName, "DNS:in.pathayam.app");
  assert.ok(leaf.checkPrivateKey(createPrivateKey(issued.keyPem)));
  assert.match(issued.certPem, /(-----BEGIN CERTIFICATE-----[\s\S]*){2}/, "the chain includes the issuer");
  assert.ok(leaf.verify(new X509Certificate(ca.caPem).publicKey));
  assert.equal(cf.records.size, 0, "the challenge record is gone");
  assert.ok(cf.calls.some((c) => c === "GET /zones?name=in.pathayam.app&status=active"));
  assert.ok(cf.calls.some((c) => c === "GET /zones?name=pathayam.app&status=active"), "walked up to the zone");
  assert.ok(cf.calls.some((c) => c.startsWith("POST /zones/zone123/dns_records")));
  assert.ok(cf.calls.some((c) => c.startsWith("DELETE /zones/zone123/dns_records/rec1")));
  assert.ok(c.accountUrl?.includes("/acct/"));
  assert.ok(logs.some((l) => l.msg === "acme certificate issued"));
  assert.ok(!JSON.stringify(logs).includes(TOKEN), "the token is never logged");
});

test("an existing account is used by URL, without newAccount; a name and its wildcard both validate", async (t) => {
  const { ca, solver, client } = await setup(t);
  const key = generateEcKeyPem();
  const first = client(key);
  await first.ensureAccount();
  ca.log.length = 0;
  const again = client(key, first.accountUrl);
  const issued = await again.obtainCertificate(["in.pathayam.app", "*.in.pathayam.app"], solver);
  assert.ok(!ca.log.includes("/new-account"));
  assert.equal(new X509Certificate(issued.certPem).subjectAltName, "DNS:in.pathayam.app, DNS:*.in.pathayam.app");
});

test("a badNonce answer is retried with the fresh nonce", async (t) => {
  const { ca, solver, client } = await setup(t);
  ca.badNonceNext = 2;
  const issued = await client().obtainCertificate(["in.pathayam.app"], solver);
  assert.match(issued.certPem, /BEGIN CERTIFICATE/);
});

test("a failed challenge throws with the CA's reason, and the TXT record is still removed", async (t) => {
  const { cf, ca, client } = await setup(t);
  // A solver that publishes the wrong value: the CA will not find what it wants.
  const real = new CloudflareSolver({ token: TOKEN, apiBase: cf.apiBase });
  const wrong = { name: "wrong", present: (n: string) => real.present(n, "not-the-value"), cleanup: (h: unknown) => real.cleanup(h) };
  await assert.rejects(client().obtainCertificate(["in.pathayam.app"], wrong), (err: Error) => {
    assert.ok(err instanceof AcmeError);
    assert.match(err.message, /authorization for in.pathayam.app is invalid: unauthorized: No TXT record found/);
    return true;
  });
  assert.equal(cf.records.size, 0);
  void ca;
});

test("a Cloudflare refusal is reported without the token, and nothing is left behind", async (t) => {
  const { cf, ca } = await setup(t);
  const bad = new CloudflareSolver({ token: "wrong-token", apiBase: cf.apiBase });
  const c = new AcmeClient({ directoryUrl: ca.directoryUrl, accountKeyPem: generateEcKeyPem(), sleep: async () => {} });
  await assert.rejects(c.obtainCertificate(["in.pathayam.app"], bad), (err: Error) => {
    assert.match(err.message, /Cloudflare GET \/zones failed: 9109 Invalid access token/);
    assert.ok(!err.message.includes("wrong-token"));
    return true;
  });
  cf.failCreate = true;
  cf.calls.length = 0;
  const good = new CloudflareSolver({ token: TOKEN, apiBase: cf.apiBase, zoneId: "zone123" });
  await assert.rejects(c.obtainCertificate(["in.pathayam.app"], good), /Record already exists/);
  assert.ok(!cf.calls.some((x) => x.startsWith("GET /zones?")), "a configured zone id skips the lookup");
  assert.equal(cf.records.size, 0);
});

test("with two names, a failure on the second still removes the first record", async (t) => {
  const { cf, client } = await setup(t);
  const real = new CloudflareSolver({ token: TOKEN, apiBase: cf.apiBase });
  let n = 0;
  const flaky = {
    name: "flaky",
    present: async (name: string, value: string) => {
      if (n++ === 1) throw new Error("provider down");
      return real.present(name, value);
    },
    cleanup: (h: unknown) => real.cleanup(h),
  };
  await assert.rejects(client().obtainCertificate(["in.pathayam.app", "mx.pathayam.app"], flaky), /provider down/);
  assert.equal(cf.records.size, 0);
});

test("an unknown zone is named in the error", async (t) => {
  const { cf } = await setup(t);
  const s = new CloudflareSolver({ token: TOKEN, apiBase: cf.apiBase });
  await assert.rejects(s.zoneFor("_acme-challenge.example.org"), /no Cloudflare zone found for _acme-challenge.example.org/);
  assert.throws(() => new CloudflareSolver({ token: "" }), /CLOUDFLARE_API_TOKEN/);
});

test("propagation: waits until every resolver sees the value, and gives up at the deadline", async () => {
  let clock = 0;
  const seen: Record<string, number> = { "1.1.1.1": 1, "8.8.8.8": 3 };
  const calls: Record<string, number> = {};
  const lookup = async (server: string) => {
    calls[server] = (calls[server] ?? 0) + 1;
    if (calls[server]! < seen[server]!) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return ["other", "v1"];
  };
  const ok = await waitForTxt("_acme-challenge.x", "v1", {
    lookup, sleep: async (ms) => { clock += ms; }, now: () => clock, intervalMs: 5_000, timeoutMs: 60_000,
  });
  assert.equal(ok, true);
  assert.equal(calls["1.1.1.1"], 1, "a resolver that has it is not asked again");
  assert.equal(calls["8.8.8.8"], 3);

  clock = 0;
  const never = await waitForTxt("_acme-challenge.x", "v2", {
    lookup: async () => [], sleep: async (ms) => { clock += ms; }, now: () => clock, intervalMs: 5_000, timeoutMs: 20_000,
  });
  assert.equal(never, false);
  assert.equal(clock, 20_000);
});
