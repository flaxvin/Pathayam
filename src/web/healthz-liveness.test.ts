/**
 * /healthz answers "can this instance serve?", not "is everything perfect?"
 *
 * It used to return 503 whenever any check read "failed" — and one of those
 * checks is "a request failed in the last 24 hours". So a single bad request
 * took the whole instance out of rotation for a day: the platform's health
 * check failed, the proxy stopped routing, every visitor got 503, and the
 * recorded failure that caused it could not be cleared because nobody could
 * reach the app to clear it.
 *
 * That is what happened to the demo. A diagnostic observation was wired to an
 * outage switch.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, testConfig } from "./harness.test-data.ts";
import { recordRequestFailure } from "../ops/errors.ts";

async function appWith(seed: (db: ReturnType<typeof freshDb>) => void = () => {}) {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  seed(db);
  const app = await startTestApp(db, { memberId: "m-ravi", config: testConfig({}) });
  return { db, app };
}

describe("a past failure does not stop it serving", () => {
  test("healthz stays 200 after a recorded request failure", async () => {
    const { app } = await appWith((db) => {
      recordRequestFailure(db, {
        method: "POST", path: "/add", status: 500,
        error: new Error("That account does not exist."),
      });
    });
    try {
      const res = await app.get("/healthz");
      assert.equal(
        res.status, 200,
        "one bad request took the instance out of rotation — the demo went down this way",
      );
    } finally { await app.close(); }
  });

  test("but it still reports the problem in the body", async () => {
    // Taken out of the status code, not out of sight: an operator still needs
    // to see it on the health page.
    const { app } = await appWith((db) => {
      recordRequestFailure(db, {
        method: "POST", path: "/add", status: 500, error: new Error("boom"),
      });
    });
    try {
      const body = await (await app.get("/healthz")).json() as {
        status: string; serving: boolean; checks: { name: string; state: string }[];
      };
      assert.equal(body.serving, true, "it is serving and should say so");
      assert.equal(body.status, "failed", "the diagnosis was softened as well as disconnected");
      assert.ok(
        body.checks.some((c) => c.name.includes("Request failures") && c.state === "failed"),
        "the failing check vanished from the body",
      );
    } finally { await app.close(); }
  });

  test("a healthy instance is 200 and says it is serving", async () => {
    const { app } = await appWith();
    try {
      const res = await app.get("/healthz");
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { serving: boolean }).serving, true);
    } finally { await app.close(); }
  });
});

describe("naming an account that is not there", () => {
  test("is a refusal, so it is never recorded as a fault", async () => {
    /*
     * A stale link, a typo, an API caller with an old id. As a plain Error this
     * counted as a server fault, and a fault was what took the instance down.
     */
    const { db, app } = await appWith();
    try {
      const res = await app.post("/add", {
        account_id: "no-such-account", amount: "100", direction: "out", date: "2026-09-10",
      });
      assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);

      const body = await (await app.get("/healthz")).json() as {
        checks: { name: string; state: string }[];
      };
      const failures = body.checks.find((c) => c.name.includes("Request failures"))!;
      assert.equal(
        failures.state, "healthy",
        "a mistyped account id was recorded as a server fault",
      );
      void db;
    } finally { await app.close(); }
  });
});

/*
 * /healthz is public, and it answered anybody with the whole diagnosis: "12
 * transactions, 40 events", the review queue, which backups were missing and
 * whether a development-login bypass was in the build. Signed out, it now says
 * whether the instance is alive and nothing else.
 */
describe("signed out, it is a liveness probe and nothing more", () => {
  test("three fields, no counts, and still 200 after a recorded failure", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    recordRequestFailure(db, { method: "POST", path: "/add", status: 500, error: new Error("boom") });
    const app = await startTestApp(db, { memberId: null, config: testConfig({}) });
    try {
      const res = await app.get("/healthz");
      assert.equal(res.status, 200, "a past failure failed the liveness check");
      const text = await res.text();
      assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["serving", "status", "version"], text);
      assert.doesNotMatch(text, /transactions|events|backup|login|review/i);
    } finally { await app.close(); }
  });
});

/*
 * Not configured is a deployment state. /auth/google already answered 503 for
 * it; /gmail/connect answered 500, which reads as the app having broken and
 * is what a monitor pages somebody for.
 */
describe("Google not configured", () => {
  test("/gmail/connect is 503, like /auth/google, not 500", async () => {
    const { app } = await appWith();
    try {
      assert.equal((await app.get("/gmail/connect")).status, 503);
      assert.equal((await app.get("/auth/google")).status, 503);
    } finally { await app.close(); }
  });
});
