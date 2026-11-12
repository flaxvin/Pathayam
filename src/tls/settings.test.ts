/**
 * TLS-1 · Reading the ACME settings, for the receiver and the app alike, and
 * the app's own switch: off by default, so the Fly demo is unchanged.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadAcmeSettings } from "./settings.ts";
import { LETS_ENCRYPT_PRODUCTION, LETS_ENCRYPT_STAGING } from "./acme.ts";
import { loadConfig, InvalidConfiguration } from "../config.ts";

const TOKEN = { CLOUDFLARE_API_TOKEN: "placeholder-token" };

test("off unless the domain variable is set", () => {
  assert.equal(loadAcmeSettings({}, "MX_TLS_ACME_DOMAIN"), null);
  assert.equal(loadAcmeSettings({ MX_TLS_ACME_DOMAIN: "  ", ...TOKEN }, "MX_TLS_ACME_DOMAIN"), null);
});

test("defaults: Let's Encrypt production, the acme folder under DATA_DIR, Cloudflare", () => {
  const s = loadAcmeSettings({ MX_TLS_ACME_DOMAIN: "In.Pathayam.App.", DATA_DIR: "/data", ...TOKEN }, "MX_TLS_ACME_DOMAIN")!;
  assert.deepEqual(s, {
    domains: ["in.pathayam.app"], directoryUrl: LETS_ENCRYPT_PRODUCTION, email: null, dir: "/data/acme",
    dnsProvider: "cloudflare", cloudflareToken: "placeholder-token", cloudflareZoneId: null,
  });
  assert.equal(loadAcmeSettings({ TLS_ACME_DOMAIN: "a.example.com", ...TOKEN }, "TLS_ACME_DOMAIN")!.dir, resolve("./data/acme"));
});

test("staging, several names, an email, a zone id and ACME_DIR", () => {
  const s = loadAcmeSettings({
    TLS_ACME_DOMAIN: "budget.example.com, *.example.com budget.example.com", ACME_DIRECTORY: "Staging",
    ACME_EMAIL: "ops@example.com", ACME_DIR: "/srv/acme", CLOUDFLARE_ZONE_ID: "abc", ...TOKEN,
  }, "TLS_ACME_DOMAIN")!;
  assert.deepEqual(s.domains, ["budget.example.com", "*.example.com"]);
  assert.equal(s.directoryUrl, LETS_ENCRYPT_STAGING);
  assert.equal(s.email, "ops@example.com");
  assert.equal(s.dir, "/srv/acme");
  assert.equal(s.cloudflareZoneId, "abc");
});

test("anything unreadable is refused, naming the variable", () => {
  const d = { MX_TLS_ACME_DOMAIN: "in.pathayam.app" };
  assert.throws(() => loadAcmeSettings(d, "MX_TLS_ACME_DOMAIN"), /CLOUDFLARE_API_TOKEN is required/);
  assert.throws(() => loadAcmeSettings({ MX_TLS_ACME_DOMAIN: "in_pathayam", ...TOKEN }, "MX_TLS_ACME_DOMAIN"), /MX_TLS_ACME_DOMAIN: "in_pathayam" is not a domain/);
  assert.throws(() => loadAcmeSettings({ ...d, ...TOKEN, ACME_DIRECTORY: "http://ca.example.com/dir" }, "MX_TLS_ACME_DOMAIN"), /https:\/\//);
  assert.throws(() => loadAcmeSettings({ ...d, ...TOKEN, ACME_DIRECTORY: "prod" }, "MX_TLS_ACME_DOMAIN"), /ACME_DIRECTORY/);
  assert.throws(() => loadAcmeSettings({ ...d, ...TOKEN, ACME_EMAIL: "nobody" }, "MX_TLS_ACME_DOMAIN"), /ACME_EMAIL/);
  assert.throws(() => loadAcmeSettings({ ...d, ...TOKEN, ACME_DNS_PROVIDER: "route53" }, "MX_TLS_ACME_DOMAIN"), /ACME_DNS_PROVIDER/);
  // A local test CA (Pebble) may be plain http.
  assert.equal(loadAcmeSettings({ ...d, ...TOKEN, ACME_DIRECTORY: "http://127.0.0.1:14000/dir" }, "MX_TLS_ACME_DOMAIN")!.directoryUrl, "http://127.0.0.1:14000/dir");
});

test("the app: HTTPS is off by default, and the Fly demo's settings leave it off", () => {
  assert.equal(loadConfig({ DATA_DIR: "/tmp/x" }).tls, null);
  const fly = { DEMO_MODE: "1", DATABASE_PATH: "/app/demo.sqlite", BASE_URL: "https://demo.pathayam.app", PORT: "8080", TRUST_PROXY: "1", NODE_ENV: "production", DATA_DIR: "/data" };
  assert.equal(loadConfig(fly).tls, null);
});

test("the app: TLS_ACME_DOMAIN turns HTTPS on at 443, and needs a token and an https BASE_URL", () => {
  const base = { DATA_DIR: "/tmp/x", BASE_URL: "https://budget.example.com", TLS_ACME_DOMAIN: "budget.example.com", ...TOKEN };
  const tls = loadConfig(base).tls!;
  assert.equal(tls.httpsPort, 443);
  assert.deepEqual(tls.domains, ["budget.example.com"]);
  assert.equal(tls.dir, "/tmp/x/acme");
  assert.equal(loadConfig({ ...base, HTTPS_PORT: "8443" }).tls!.httpsPort, 8443);
  assert.throws(() => loadConfig({ ...base, HTTPS_PORT: "443x" }), (e: Error) => e instanceof InvalidConfiguration && /HTTPS_PORT/.test(e.message));
  assert.throws(() => loadConfig({ ...base, BASE_URL: "http://budget.example.com" }), /BASE_URL must be the https/);
  assert.throws(() => loadConfig({ ...base, CLOUDFLARE_API_TOKEN: "" }), (e: Error) => e instanceof InvalidConfiguration && /CLOUDFLARE_API_TOKEN/.test(e.message));
});
