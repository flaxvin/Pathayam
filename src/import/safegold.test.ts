/**
 * IMP-30 · Reading a SafeGold statement.
 *
 * SafeGold is digital gold: its monthly statement lists the gold bought and
 * sold (grams, the rate per gram, the amount and its GST) between an opening
 * and a closing gold wallet balance in grams. The layout below follows the
 * shape of a real statement — summary, transaction summary, transaction
 * statement — but every name, number and row is synthetic.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseSafeGoldText, isSafeGoldText, gramsDisagreement, formatGrams } from "./safegold.ts";
import { statement, TWO_ROWS } from "./safegold.test-data.ts";

describe("IMP-30 · a SafeGold statement is recognised", () => {
  test("by its gold wallet balance and SafeGold's name", () => {
    assert.equal(isSafeGoldText(statement(TWO_ROWS)), true);
  });

  test("a bank statement or a CAS is not one", () => {
    assert.equal(isSafeGoldText("HDFC BANK\nStatement of account\n01/10/26 UPI-SAFEGOLD 100.00"), false);
    assert.equal(isSafeGoldText("Consolidated Account Statement\nFolio No: 1\nHDFC Gold Fund"), false);
  });
});

describe("IMP-30 · its rows", () => {
  const parsed = parseSafeGoldText(statement(TWO_ROWS));

  test("the period, opening and closing wallet balance", () => {
    assert.deepEqual(parsed.period, { from: "2026-10-01", to: "2026-10-31" });
    // Units are milligrams to three decimals: 1.0000 g is 1,000 mg.
    assert.equal(parsed.openingUnits, 1_000_000);
    assert.equal(parsed.closingUnits, 1_500_000);
  });

  test("a purchase: grams, rate, amount including GST, and the GST", () => {
    const buy = parsed.rows[0]!;
    assert.equal(buy.date, "2026-10-05");
    assert.equal(buy.time, "10:15");
    assert.equal(buy.kind, "buy");
    assert.equal(buy.units, 700_000);
    // ₹10,000 a gram is ₹10 a milligram, in micro-rupees.
    assert.equal(buy.price, 10_000_000);
    assert.equal(buy.amount, 721_000);
    assert.equal(buy.gst, 21_000);
  });

  test("a sale is negative", () => {
    const sell = parsed.rows[1]!;
    assert.equal(sell.kind, "sell");
    assert.equal(sell.units, -200_000);
    assert.equal(sell.price, 10_500_000);
    assert.equal(sell.amount, 210_000);
    assert.equal(sell.gst, 0);
  });

  test("it reconciles: opening plus its rows is the closing balance", () => {
    assert.equal(parsed.rows.length, 2);
    assert.equal(gramsDisagreement(parsed), null);
    assert.deepEqual(parsed.unparsed, []);
  });

  test("four decimals of a gram survive: a ₹10 purchase of 0.0008 g", () => {
    const small = parseSafeGoldText(statement([
      "05 Oct 2026 10:15 AM  Gold Purchased  Rate ₹12,345.67/g  Amount ₹10.00  GST ₹0.29  0.0008 g  1.0008 g",
    ], "1.0008"));
    assert.equal(small.rows[0]!.units, 800);
    assert.equal(formatGrams(small.rows[0]!.units), "0.0008 g");
    assert.equal(small.rows[0]!.price, 12_345_670);
    assert.equal(gramsDisagreement(small), null);
  });
});

describe("IMP-30 · reading what it cannot reconcile", () => {
  test("a missed row shows as the closing balance disagreeing", () => {
    const parsed = parseSafeGoldText(statement([TWO_ROWS[0]!, TWO_ROWS[1]!]));
    // 1.0000 + 0.7000 = 1.7000, but the statement closes at 1.5000.
    assert.equal(gramsDisagreement(parsed), -200_000);
  });

  test("a dated line with no grams is unparsed, not guessed", () => {
    const parsed = parseSafeGoldText(statement([
      ...TWO_ROWS,
      "25 Oct 2026     Gold Purchased   Amount ₹500.00",
    ]));
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.unparsed.length, 1);
  });

  test("no transactions: opening equals closing, and that reconciles", () => {
    const parsed = parseSafeGoldText(statement(
      ["                                        No transactions found"], "1.0000",
    ));
    assert.equal(parsed.rows.length, 0);
    assert.equal(parsed.closingUnits, 1_000_000);
    assert.equal(gramsDisagreement(parsed), null);
  });

  test("a row's sign comes from its closing balance when the quantity carries none", () => {
    const parsed = parseSafeGoldText(statement([
      "05 Oct 2026     Gold Delivered to address                       0.5000 g          0.5000 g",
      "12 Oct 2026     Lease Rental Earned                             1.0000 g          1.5000 g",
    ]));
    assert.equal(parsed.rows[0]!.kind, "other");
    assert.equal(parsed.rows[0]!.units, -500_000);
    assert.equal(parsed.rows[1]!.units, 1_000_000);
    assert.equal(gramsDisagreement(parsed), null);
  });
});
