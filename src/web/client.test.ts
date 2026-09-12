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
import { STYLESHEET } from "./styles.ts";
import { page } from "./layout.ts";
import { raw } from "../http/html.ts";

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

describe("S15 · the stylesheet", () => {
  test("is served whole — a stray backtick would truncate the template", () => {
    // A backtick in a CSS comment ends the template literal, and the failure
    // surfaces as a TypeScript syntax error a long way from the comment.
    assert.equal(STYLESHEET.includes("`"), false);
    assert.equal(STYLESHEET.includes("${"), false);
  });

  test("braces balance, so no rule was cut off mid-block", () => {
    const opens = (STYLESHEET.match(/\{/g) ?? []).length;
    const closes = (STYLESHEET.match(/\}/g) ?? []).length;
    assert.equal(opens, closes, "unbalanced braces mean a truncated stylesheet");
  });

  test("B62 · main fills its grid track rather than shrink-wrapping", () => {
    // The auto margin that centres the single-column layout must not survive
    // into the sidebar grid, where it makes main size to max-content instead.
    assert.match(STYLESHEET, /\.with-sidebar main \{[^}]*margin: 0;/);
  });
});

describe("B103 · the in-place swap must not strip the page chrome", () => {
  /*
   * Entering the demo posts a form from /signin, which renders bare — no
   * header, no sidebar, no bottom nav. The swap replaces the main element and
   * the two navs, and on a bare page there are no navs to replace, so the
   * budget grid arrived inside the sign-in shell with no navigation at all.
   *
   * The fix is a shell comparison before swapping. These tests pin the two
   * halves of it: that the guard exists, and that the shells really do differ
   * so the guard has something to catch.
   */

  test("the client compares shells and navigates instead of swapping", () => {
    assert.match(
      CLIENT_SCRIPT,
      /hadChrome\s*!==\s*wantsChrome/,
      "updatePage must fall back to a real navigation when the shell changes",
    );
    assert.match(
      CLIENT_SCRIPT,
      /wantsChrome\s*=\s*Boolean\(doc\.querySelector\(["']\.with-sidebar["']\)\)/,
      "the target shell has to be read from the fetched document, not the current one",
    );
  });

  test("a bare page and a full page really do have different shells", () => {
    // Without this difference the guard above would be dead code.
    const bare = page(
      { title: "Sign in", theme: "system", bare: true },
      raw("<p>hello</p>"),
    );
    const full = page({ title: "Budget", theme: "system" }, raw("<p>hello</p>"));

    assert.ok(!bare.includes('class="with-sidebar"'), "a bare page has no sidebar shell");
    assert.ok(!bare.includes('class="app-header"'), "a bare page has no header");
    assert.ok(full.includes('class="with-sidebar"'), "a full page has the sidebar shell");
    assert.ok(full.includes('class="app-header"'), "a full page has the header");
  });
});
