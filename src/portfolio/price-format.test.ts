/**
 * W18-UI-2 · A two-decimal price is shown with two decimals.
 *
 * SBI's closing price from the exchange file, ₹1,108.60, showed on the
 * portfolio and the Tax page's harvest table as "₹1108.6000" beside
 * "₹1367.00" and "₹1130.00". formatPrice asked whether value × 100 was a whole
 * number in floating point, and 1108.6 × 100 is 110859.99999999999 — about one
 * in eight paisa-exact prices took the four-decimal NAV form. The question is
 * asked of the integer micro-rupees instead.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatPrice, PRICE_SCALE } from "./holdings.ts";

describe("W18-UI-2 · formatPrice", () => {
  test("paisa-exact prices that float arithmetic gets wrong show two decimals", () => {
    assert.equal(formatPrice(1_108_600_000), "1108.60");
    assert.equal(formatPrice(550_000), "0.55");
    assert.equal(formatPrice(290_000), "0.29");
  });

  test("every paisa-exact price up to ₹50,000 shows two decimals", () => {
    for (let paise = 1; paise <= 5_000_000; paise++) {
      const shown = formatPrice(paise * (PRICE_SCALE / 100));
      if (!/^\d+\.\d\d$/.test(shown)) assert.fail(`${paise} paise shown as ${shown}`);
    }
  });

  test("a NAV quoted beyond the paisa keeps four decimals", () => {
    assert.equal(formatPrice(84_372_100), "84.3721");
    assert.equal(formatPrice(12_345_600), "12.3456");
  });
});
