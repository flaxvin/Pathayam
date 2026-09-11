/**
 * The client script is a `String.raw` template, which means a stray backtick or
 * a `${` in a comment does not fail the build — it silently truncates or
 * interpolates the asset, and the browser gets a syntax error instead of the
 * app. It is also the only code in the project a test cannot import and call,
 * so these tests check the two things that have actually broken it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_SCRIPT } from "./client.ts";

describe("S15 · the client script", () => {
  test("parses as JavaScript", () => {
    assert.doesNotThrow(() => new Function(CLIENT_SCRIPT));
  });

  test("carries no backtick or interpolation that would break the raw template", () => {
    assert.equal(CLIENT_SCRIPT.includes("`"), false, "a backtick would end the template early");
    assert.equal(CLIENT_SCRIPT.includes("${"), false, "an interpolation would be evaluated at build time");
  });

  test("R35 · stores nothing on the device", () => {
    for (const banned of ["localStorage", "sessionStorage", "indexedDB", "caches.open", "serviceWorker"]) {
      assert.equal(CLIENT_SCRIPT.includes(banned), false, `${banned} is forbidden by R35`);
    }
  });

  test("B59 · a multipart form is left to submit natively so file bytes survive", () => {
    assert.match(CLIENT_SCRIPT, /multipart\/form-data/);
    assert.match(CLIENT_SCRIPT, /input\[type="file"\]/);
  });

  test("B60 · a successful mutation updates in place rather than navigating", () => {
    // The two calls that threw away the scroll position, and the message.
    assert.equal(
      CLIENT_SCRIPT.includes("window.location.reload()"),
      true,
      "only popstate should reload",
    );
    assert.equal(
      (CLIENT_SCRIPT.match(/window\.location\.reload\(\)/g) ?? []).length,
      1,
      "the sole reload left is the popstate handler",
    );
    assert.match(CLIENT_SCRIPT, /function updatePage\(/);
    assert.match(CLIENT_SCRIPT, /window\.scrollTo\(x, y\)/);
  });
});
