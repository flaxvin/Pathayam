import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  loadConfig,
  productionIndicators,
  assertDevLoginSafeAgainstData,
  UnsafeConfiguration,
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
      () => loadConfig({ ...base, DEV_LOGIN: "true", BASE_URL: "https://budget.example.com" }),
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
      BASE_URL: "https://budget.example.com",
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
