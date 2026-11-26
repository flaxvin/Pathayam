/**
 * UI-3 (weekly 25-11) · Portfolio returns never read "-0.00%".
 *
 * Three holdings still at their purchase prices showed "XIRR money-weighted
 * -0.00%" on Portfolio: the XIRR solver lands a hair below zero and toFixed(2)
 * keeps the minus sign of a value that rounds to nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReturnPct } from "./portfolio.ts";

test("a return that rounds to zero is 0.00%, whichever side of zero it fell", () => {
  assert.equal(formatReturnPct(-0.0000001), "0.00%");
  assert.equal(formatReturnPct(-0.004), "0.00%");
  assert.equal(formatReturnPct(0.004), "0.00%");
  assert.equal(formatReturnPct(-0), "0.00%");
});

test("anything that shows a digit keeps its sign", () => {
  assert.equal(formatReturnPct(-7.0512), "-7.05%");
  assert.equal(formatReturnPct(-0.006), "-0.01%");
  assert.equal(formatReturnPct(6.15), "6.15%");
});
