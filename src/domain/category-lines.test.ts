/**
 * Category lines: one envelope, or several, with the first taking the rest.
 *
 * There was never a "main" category — a transaction has envelopes, usually
 * one. Asking for a category *and* a split section produced a box that meant
 * nothing while the section was open, and a long tail of questions about what
 * it should say, whether it was required, and what happened to what you typed
 * in it.
 *
 * The first line carries no amount. That is what makes the lines unable to
 * disagree with the total: the remainder is computed, not typed.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees, formatPaise, type Paise } from "../core/money.ts";
import { resolveCategoryLines } from "./transactions.ts";
import { Refusal } from "../core/refusal.ts";

const OUT = -rupees(2_400) as Paise;
const IN = rupees(5_000);

describe("one line is not a split", () => {
  test("a single envelope comes back as a plain category", () => {
    const r = resolveCategoryLines(OUT, [{ categoryId: "groceries", amount: null }]);
    assert.equal(r.categoryId, "groceries");
    assert.equal(r.splits, null);
  });

  test("later lines left empty change nothing", () => {
    const r = resolveCategoryLines(OUT, [
      { categoryId: "groceries", amount: null },
      { categoryId: null, amount: null },
      { categoryId: "household", amount: null },
    ]);
    assert.equal(r.categoryId, "groceries");
    assert.equal(r.splits, null, "an envelope with no amount made it a split");
  });

  test("a zero amount is an empty line, not a line worth nothing", () => {
    const r = resolveCategoryLines(OUT, [
      { categoryId: "groceries", amount: null },
      { categoryId: "household", amount: 0 as Paise },
    ]);
    assert.equal(r.splits, null);
  });
});

describe("the first line takes what is left", () => {
  test("₹900 claimed leaves ₹1,500", () => {
    const r = resolveCategoryLines(OUT, [
      { categoryId: "groceries", amount: null },
      { categoryId: "household", amount: -rupees(900) as Paise },
    ]);
    assert.ok(r.splits, "it should be a split");
    assert.equal(r.splits!.length, 2);
    assert.equal(r.splits![0]!.amount, -rupees(1_500));
    assert.equal(r.splits![0]!.categoryId, "groceries");
    assert.equal(r.categoryId, null, "both a category and lines were set");
  });

  test("the lines always add up, because the remainder is computed", () => {
    for (const claim of [100, 900, 1_200, 2_399]) {
      const r = resolveCategoryLines(OUT, [
        { categoryId: "a", amount: null },
        { categoryId: "b", amount: -rupees(claim) as Paise },
      ]);
      assert.equal(
        r.splits!.reduce((t, s) => t + s.amount, 0), OUT,
        `claiming ${claim} did not reconcile`,
      );
    }
  });

  test("several claimed lines all come off the first", () => {
    const r = resolveCategoryLines(OUT, [
      { categoryId: "a", amount: null },
      { categoryId: "b", amount: -rupees(500) as Paise },
      { categoryId: "c", amount: -rupees(400) as Paise },
    ]);
    assert.equal(r.splits!.length, 3);
    assert.equal(r.splits![0]!.amount, -rupees(1_500));
  });

  test("income keeps its sign", () => {
    const r = resolveCategoryLines(IN, [
      { categoryId: "a", amount: null },
      { categoryId: "b", amount: rupees(2_000) },
    ]);
    assert.equal(r.splits![0]!.amount, rupees(3_000));
    assert.ok(r.splits!.every((s) => s.amount > 0));
  });
});

describe("what it still refuses, and what it says when it does", () => {
  /*
   * Two different mistakes, which for a while shared one sentence — and that
   * sentence was wrong about one of them. Told that ₹3,000 of lines "leaves
   * nothing" out of ₹2,400, the reader has to work out for themselves that
   * they are ₹600 over; and somebody whose actual intent was to file the whole
   * amount into one envelope was told to "give the later lines less than the
   * total", which is not the fix. So each case says its own figure and its own
   * way out, and these hold them to it.
   */
  function refusal(lines: { categoryId: string | null; amount: Paise | null }[]): string {
    try {
      resolveCategoryLines(OUT, lines);
      assert.fail("should have refused");
    } catch (e) {
      assert.ok(e instanceof Refusal, "refused as a 500 rather than a 422");
      return (e as Error).message;
    }
  }

  test("claiming the whole amount leaves the first line nothing", () => {
    const message = refusal([
      { categoryId: "a", amount: null },
      { categoryId: "b", amount: -rupees(2_400) as Paise },
    ]);
    assert.match(message, /the whole ₹2,400/);
    assert.match(
      message, /choose it on the first line and clear the amount below/,
      "the one thing they can actually do about it is not offered",
    );
  });

  test("with several lines adding to the total, the fix is to move one up", () => {
    const message = refusal([
      { categoryId: "a", amount: null },
      { categoryId: "b", amount: -rupees(1_400) as Paise },
      { categoryId: "c", amount: -rupees(1_000) as Paise },
    ]);
    assert.match(message, /move one up to the first line/);
  });

  test("claiming more than there is would make the first line negative", () => {
    /*
     * Money appearing in an envelope because two others took too much — the
     * quiet impossibility the accounting identity exists to prevent.
     */
    const message = refusal([
      { categoryId: "a", amount: null },
      { categoryId: "b", amount: -rupees(3_000) as Paise },
    ]);
    assert.match(message, /₹600 more than the ₹2,400/, "the reader is left to do the subtraction");
    assert.match(message, /3,000/, "what they actually typed is not quoted back");
  });

  test("the exact total is not reported as being over by nothing", () => {
    /*
     * Zero is not negative, so on an expense the sign test that catches an
     * overshoot also catches an exact total — and reported it as "₹0 more than
     * ₹2,400". The order of the two checks is the whole of the fix, and this is
     * what holds it: income took the right branch either way, so only the
     * outgoing case ever showed it.
     */
    const message = refusal([
      { categoryId: "a", amount: null },
      { categoryId: "b", amount: -rupees(2_400) as Paise },
    ]);
    assert.doesNotMatch(message, /₹0 more/, "an expense is being told it is over by nothing");
  });
});
