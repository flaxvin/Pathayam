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

describe("what it still refuses", () => {
  test("claiming the whole amount leaves the first line nothing", () => {
    assert.throws(
      () => resolveCategoryLines(OUT, [
        { categoryId: "a", amount: null },
        { categoryId: "b", amount: -rupees(2_400) as Paise },
      ]),
      Refusal,
    );
  });

  test("claiming more than there is would make the first line negative", () => {
    /*
     * Money appearing in an envelope because two others took too much — the
     * quiet impossibility the accounting identity exists to prevent.
     */
    assert.throws(
      () => resolveCategoryLines(OUT, [
        { categoryId: "a", amount: null },
        { categoryId: "b", amount: -rupees(3_000) as Paise },
      ]),
      (e: Error) => e instanceof Refusal && /leaves nothing for the first/.test(e.message),
    );
  });

  test("and says both figures, so the fix is obvious", () => {
    try {
      resolveCategoryLines(OUT, [
        { categoryId: "a", amount: null },
        { categoryId: "b", amount: -rupees(3_000) as Paise },
      ]);
      assert.fail("should have refused");
    } catch (e) {
      assert.match((e as Error).message, /3,000/);
      assert.match((e as Error).message, /2,400/);
    }
  });
});
