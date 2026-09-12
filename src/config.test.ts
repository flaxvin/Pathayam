import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  loadConfig, productionIndicators, assertDevLoginSafeAgainstData, UnsafeConfiguration, assertDemoModeSafeAgainstData,
} from "./config.ts";

const base = { DATA_DIR: "/tmp/budget-test" };

describe("R38.3 · the dev login bypass refuses to start near production", () => {
  test("starts happily on a development machine", () => {
    const config = loadConfig({ ...base, DEV_LOGIN: "true", BASE_URL: "http://localhost:8080" });
    assert.equal(config.devLogin, true);
    assert.deepEqual(productionIndicators(config), []);
  });

  test("allows a homelab LAN address, which is still development", () => {
    const config = loadConfig({ ...base, DEV_LOGIN: "true", BASE_URL: "http://192.168.1.40:8080" });
    assert.equal(config.devLogin, true);
  });

  test("refuses when NODE_ENV is production", () => {
    assert.throws(
      () => loadConfig({ ...base, DEV_LOGIN: "true", NODE_ENV: "production", BASE_URL: "http://localhost:8080" }),
      (err: unknown) =>
        err instanceof UnsafeConfiguration && /NODE_ENV is 'production'/.test(err.message),
    );
  });

  test("refuses on a public hostname", () => {
    assert.throws(
      () => loadConfig({ ...base, DEV_LOGIN: "true", BASE_URL: "https://pathayam.example.com" }),
      (err: unknown) =>
        err instanceof UnsafeConfiguration && /public hostname/.test(err.message),
    );
  });

  test("refuses when real Google credentials are configured", () => {
    assert.throws(
      () =>
        loadConfig({
          ...base,
          DEV_LOGIN: "true",
          BASE_URL: "http://localhost:8080",
          GOOGLE_CLIENT_ID: "1234.apps.googleusercontent.com",
        }),
      (err: unknown) => err instanceof UnsafeConfiguration && /OAuth/.test(err.message),
    );
  });

  test("refuses when the database holds more than a seed dataset", () => {
    const config = loadConfig({ ...base, DEV_LOGIN: "true", BASE_URL: "http://localhost:8080" });
    assert.doesNotThrow(() => assertDevLoginSafeAgainstData(config, 40));
    assert.throws(
      () => assertDevLoginSafeAgainstData(config, 5_000),
      (err: unknown) => err instanceof UnsafeConfiguration && /5000 transactions/.test(err.message),
    );
  });

  test("none of those indicators matter when the bypass is off", () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: "production",
      BASE_URL: "https://pathayam.example.com",
      GOOGLE_CLIENT_ID: "real",
      GOOGLE_CLIENT_SECRET: "secret",
    });
    assert.equal(config.devLogin, false);
    assert.doesNotThrow(() => assertDevLoginSafeAgainstData(config, 100_000));
  });

  test("is off by default (R38.2)", () => {
    assert.equal(loadConfig(base).devLogin, false);
  });
});

describe("defaults", () => {
  test("carry the documented decisions", () => {
    const config = loadConfig(base);
    assert.equal(config.sessionDays, 30); // Q22
    assert.equal(config.features.multiCurrency, false); // Q18: ₹ only
    assert.equal(config.features.loans, true);
    assert.equal(config.environment, "development");
  });

  test("strip a trailing slash from the base URL so redirects do not double up", () => {
    assert.equal(loadConfig({ ...base, BASE_URL: "https://x.example.com/" }).baseUrl, "https://x.example.com");
  });
});

describe("R38 · demo mode is a separate bypass with its own guards", () => {
  const base = { ...process.env, DATA_DIR: "/tmp/x", BASE_URL: "https://pathayam.example.com" };

  test("off by default, so a household deployment is untouched", () => {
    assert.equal(loadConfig({ ...base }).demoMode, false);
  });

  test("it may run on a public hostname, unlike the development bypass", () => {
    // This is the whole difference between the two: DEV_LOGIN refuses anywhere
    // production-shaped, and a public demo is production-shaped by definition.
    assert.doesNotThrow(() => loadConfig({ ...base, DEMO_MODE: "true" }));
    assert.throws(() => loadConfig({ ...base, DEV_LOGIN: "true" }), UnsafeConfiguration);
  });

  test("two bypasses at once is refused rather than resolved by precedence", () => {
    assert.throws(
      () => loadConfig({ ...base, DEMO_MODE: "true", DEV_LOGIN: "true", BASE_URL: "http://localhost:8080" }),
      UnsafeConfiguration,
    );
  });

  test("it refuses a database that somebody actually uses", () => {
    const config = loadConfig({ ...base, DEMO_MODE: "true" });
    assert.doesNotThrow(() =>
      assertDemoModeSafeAgainstData(config, { gmailConnections: 0, statementIdentities: 0 }));

    // A connected mailbox or a saved PAN cannot be explained away as demo data,
    // and demo mode opens the front door to anyone who can reach the URL.
    assert.throws(
      () => assertDemoModeSafeAgainstData(config, { gmailConnections: 1, statementIdentities: 0 }),
      /real use/,
    );
    assert.throws(
      () => assertDemoModeSafeAgainstData(config, { gmailConnections: 0, statementIdentities: 1 }),
      /real use/,
    );
  });

  test("the refusal names the setting that is actually set", () => {
    // Telling an operator to unset DEV_LOGIN when DEMO_MODE is the problem
    // sends them looking for something that is not there.
    const config = loadConfig({ ...base, DEMO_MODE: "true" });
    assert.throws(
      () => assertDemoModeSafeAgainstData(config, { gmailConnections: 1, statementIdentities: 0 }),
      (err: Error) => err.message.includes("DEMO_MODE") && !err.message.includes("DEV_LOGIN"),
    );
  });

  test("with demo mode off, the data guard does nothing at all", () => {
    const config = loadConfig({ ...base });
    assert.doesNotThrow(() =>
      assertDemoModeSafeAgainstData(config, { gmailConnections: 9, statementIdentities: 9 }));
  });
});
