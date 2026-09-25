import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  rupees,
  allocate,
  allocateByWeight,
  formatPaise,
  formatCompact,
  speakPaise,
  parseAmount,
  evaluateAmountExpression,
} from "./money.ts";

describe("rupees", () => {
  test("converts to whole paise", () => {
    assert.equal(rupees(1), 100);
    assert.equal(rupees(1234.56), 123456);
    assert.equal(rupees(0.1), 10);
  });

  test("does not accumulate float error", () => {
    // 0.1 + 0.2 in floats is the canonical example; in paise it is exact.
    assert.equal(rupees(0.1) + rupees(0.2), rupees(0.3));
  });
});

describe("allocate", () => {
  test("splits evenly when it divides", () => {
    assert.deepEqual(allocate(rupees(300), 3), [rupees(100), rupees(100), rupees(100)]);
  });

  test("distributes the remainder and loses nothing", () => {
    const parts = allocate(100, 3);
    assert.deepEqual(parts, [34, 33, 33]);
    assert.equal(parts.reduce((a, b) => a + b, 0), 100);
  });

  test("sums exactly over an awkward split", () => {
    // ₹10,000 over 7 months, the shape a "savings by date" target produces.
    const parts = allocate(rupees(10_000), 7);
    assert.equal(parts.reduce((a, b) => a + b, 0), rupees(10_000));
    assert.equal(parts.length, 7);
  });

  test("handles negatives symmetrically", () => {
    assert.deepEqual(allocate(-100, 3), [-34, -33, -33]);
  });

  test("rejects a non-positive part count", () => {
    assert.throws(() => allocate(100, 0), RangeError);
  });
});

describe("allocateByWeight", () => {
  test("distributes by weight and sums exactly", () => {
    const parts = allocateByWeight(rupees(1000), [1, 1, 2]);
    assert.equal(parts.reduce((a, b) => a + b, 0), rupees(1000));
    assert.equal(parts[2], rupees(500));
  });

  test("gives everything to the last part when weights are all zero", () => {
    assert.deepEqual(allocateByWeight(100, [0, 0]), [0, 0]);
  });
});

describe("formatPaise — L1 Indian grouping", () => {
  test("groups the last three digits then pairs", () => {
    assert.equal(formatPaise(rupees(1_234_567.89)), "₹12,34,567.89");
    assert.equal(formatPaise(rupees(100_000)), "₹1,00,000");
    assert.equal(formatPaise(rupees(1_000)), "₹1,000");
    assert.equal(formatPaise(rupees(999)), "₹999");
    assert.equal(formatPaise(rupees(10_000_000)), "₹1,00,00,000");
  });

  test("L11 — hides paise when they are zero, shows them when they are not", () => {
    assert.equal(formatPaise(rupees(1200)), "₹1,200");
    assert.equal(formatPaise(rupees(1200.5)), "₹1,200.50");
    assert.equal(formatPaise(rupees(1200), { alwaysPaise: true }), "₹1,200.00");
  });

  test("puts the sign before the symbol", () => {
    assert.equal(formatPaise(rupees(-1400)), "-₹1,400");
  });

  test("formats zero", () => {
    assert.equal(formatPaise(0), "₹0");
  });
});

describe("formatCompact — L2", () => {
  test("uses lakh and crore", () => {
    assert.equal(formatCompact(rupees(1_234_567)), "₹12.35L");
    assert.equal(formatCompact(rupees(12_000_000)), "₹1.2Cr");
    assert.equal(formatCompact(rupees(45_000)), "₹45K");
  });

  test("falls back to the exact form below a thousand", () => {
    assert.equal(formatCompact(rupees(840)), "₹840");
  });
});

describe("speakPaise — A5", () => {
  test("announces rupees rather than the symbol", () => {
    assert.equal(speakPaise(rupees(1.5)), "1 rupee 50 paise");
    assert.equal(speakPaise(rupees(-40)), "minus 40 rupees");
    assert.equal(speakPaise(rupees(999)), "999 rupees");
  });

  test("B95 · says large amounts the way the screen writes them", () => {
    // The screen shows ₹52,75,874; saying "5275874 rupees" leaves a reader to
    // render it in millions or spell it out digit by digit.
    assert.equal(speakPaise(rupees(5275874)), "52 lakh 75 thousand 874 rupees");
    assert.equal(speakPaise(rupees(1200)), "1 thousand 200 rupees");
    assert.equal(speakPaise(rupees(100000)), "1 lakh rupees");
    assert.equal(speakPaise(rupees(12500000)), "1 crore 25 lakh rupees");
    assert.equal(speakPaise(rupees(-250000)), "minus 2 lakh 50 thousand rupees");
  });

  test("B95 · skips the groups that are empty", () => {
    assert.equal(speakPaise(rupees(10000000)), "1 crore rupees");
    assert.equal(speakPaise(rupees(1000045)), "10 lakh 45 rupees");
  });
});

describe("parseAmount", () => {
  test("accepts plain and grouped input", () => {
    assert.equal(parseAmount("1234"), rupees(1234));
    assert.equal(parseAmount("12,34,567.89"), rupees(1_234_567.89));
    assert.equal(parseAmount("₹450"), rupees(450));
    assert.equal(parseAmount("  450.50  "), rupees(450.5));
  });

  test("accepts lakh, crore and thousand suffixes", () => {
    assert.equal(parseAmount("1.2L"), rupees(120_000));
    assert.equal(parseAmount("3Cr"), rupees(30_000_000));
    assert.equal(parseAmount("45k"), rupees(45_000));
  });

  test("handles the Cr/Dr suffixes on Indian statements", () => {
    assert.equal(parseAmount("1,200.00 Cr"), rupees(1200));
    assert.equal(parseAmount("1,200.00 Dr"), rupees(-1200));
  });

  test("handles accounting parentheses", () => {
    assert.equal(parseAmount("(450)"), rupees(-450));
  });

  test("returns null rather than guessing", () => {
    assert.equal(parseAmount(""), null);
    assert.equal(parseAmount("abc"), null);
    assert.equal(parseAmount("12.34.56"), null);
    assert.equal(parseAmount("."), null);
  });
});

describe("evaluateAmountExpression — F4.10", () => {
  test("evaluates the documented example", () => {
    assert.equal(evaluateAmountExpression("450+120*2"), rupees(690));
  });

  test("respects precedence and parentheses", () => {
    assert.equal(evaluateAmountExpression("(450+120)*2"), rupees(1140));
    assert.equal(evaluateAmountExpression("1000-250-100"), rupees(650));
    assert.equal(evaluateAmountExpression("1000/4"), rupees(250));
  });

  test("passes a plain amount straight through", () => {
    assert.equal(evaluateAmountExpression("1,200"), rupees(1200));
    assert.equal(evaluateAmountExpression("1.2L"), rupees(120_000));
  });

  test("handles a leading negative", () => {
    assert.equal(evaluateAmountExpression("-450+100"), rupees(-350));
  });

  test("returns null on malformed input rather than a partial result", () => {
    assert.equal(evaluateAmountExpression("450+"), null);
    assert.equal(evaluateAmountExpression("450++120"), null);
    assert.equal(evaluateAmountExpression("450/0"), null);
    assert.equal(evaluateAmountExpression("(450"), null);
    assert.equal(evaluateAmountExpression("450)"), null);
  });

  // "(1,234.00)" typed or pasted into an amount field came back +₹1,234: the
  // bracket was read as grouping, not as the accounting negative.
  test("a bracketed plain amount is negative; brackets around arithmetic group", () => {
    assert.equal(evaluateAmountExpression("(1,234.00)"), rupees(-1234));
    assert.equal(evaluateAmountExpression("(450)"), rupees(-450));
    assert.equal(evaluateAmountExpression("(450+120)*2"), rupees(1140));
    assert.equal(evaluateAmountExpression("(-450)"), rupees(-450));
  });

  test("does not execute anything that is not arithmetic", () => {
    assert.equal(evaluateAmountExpression("process.exit(1)"), null);
    assert.equal(evaluateAmountExpression("1;2"), null);
  });
});

/*
 * The crore rule. "1,200.00Cr" is how several banks print a ₹1,200 credit;
 * parseAmount read the attached "Cr" as crore and returned 12,00,00,00,00,000
 * paise — ₹120 crore, 10^7 too much — while "1200DR" came back null. A 10^7
 * error is the worst thing this reader can produce, so between a marker and
 * shorthand it now refuses rather than guesses.
 */
describe("parseAmount — Cr is a credit marker before it is crore", () => {
  test("an attached Cr on a statement-shaped figure is ₹1,200, not ₹120 crore", () => {
    assert.equal(parseAmount("1,200.00Cr"), rupees(1200));
    assert.equal(parseAmount("1200CR"), rupees(1200));
    assert.equal(parseAmount("1200.00 CR."), rupees(1200));
  });

  test("Dr is symmetric with Cr, attached or spaced", () => {
    assert.equal(parseAmount("1200DR"), rupees(-1200));
    assert.equal(parseAmount("1,200.00Dr"), rupees(-1200));
    assert.equal(parseAmount("450 dr."), rupees(-450));
  });

  test("typed crore shorthand still works where it cannot be a marker", () => {
    assert.equal(parseAmount("3Cr"), rupees(3_00_00_000));
    assert.equal(parseAmount("1.25Cr"), rupees(1_25_00_000));
  });

  test("a figure that could be either is refused rather than guessed", () => {
    assert.equal(parseAmount("450Cr"), null);
    assert.equal(parseAmount("3 Cr"), null);
    assert.equal(parseAmount("3Cr."), null);
  });

  test("a statement never carries shorthand: every Cr is a credit", () => {
    assert.equal(parseAmount("3Cr", "statement"), rupees(3));
    assert.equal(parseAmount("450Cr", "statement"), rupees(450));
    assert.equal(parseAmount("1.2L", "statement"), null);
    assert.equal(parseAmount("5k", "statement"), null);
  });
});

/*
 * Digit grouping, decimals and doubled signs. The old reader stripped every
 * comma, so "1,23" was ₹123 and "1,2,3,4" ₹1,234; it rounded "1.234" to ₹1.23;
 * and "-450 Dr" cancelled its two minuses into +₹450.
 */
describe("parseAmount — refuses malformed figures instead of reading around them", () => {
  test("grouping must be Indian or Western", () => {
    assert.equal(parseAmount("1,23"), null);
    assert.equal(parseAmount("1,2,3,4"), null);
    assert.equal(parseAmount("12,34,567"), rupees(12_34_567));
    assert.equal(parseAmount("1,234,567"), rupees(1_234_567));
  });

  test("a third decimal place is not paise", () => {
    assert.equal(parseAmount("1.234"), null);
    assert.equal(parseAmount("1.005"), null);
    assert.equal(parseAmount("1.2345Cr"), rupees(1_23_45_000));
  });

  test("two minus signs are refused, not cancelled", () => {
    assert.equal(parseAmount("-450 Dr"), null);
    assert.equal(parseAmount("(450) Dr"), null);
    assert.equal(parseAmount("(-450)"), null);
    assert.equal(parseAmount("-(450)"), null);
    assert.equal(parseAmount("-450 Cr", "statement"), null);
  });

  test("accepts the currency and minus forms the PDF and alert readers accept", () => {
    assert.equal(parseAmount("−450"), rupees(-450));
    assert.equal(parseAmount("Rs.450"), rupees(450));
    assert.equal(parseAmount("Rs. 450"), rupees(450));
    assert.equal(parseAmount("INR 450"), rupees(450));
    assert.equal(parseAmount("-₹450"), rupees(-450));
    assert.equal(parseAmount("₹-450"), rupees(-450));
  });
});
