/**
 * Rules that build a value from the transaction rather than repeating a
 * constant.
 *
 * The case: a bank narration carries a UPI reference and a VPA the household
 * actually wants kept, and a rule could only set a fixed memo — so every
 * imported row got identical words and the one useful fact was lost.
 *
 * The deliberate limits are as much the feature as the substitution is. It is
 * not an expression language: no arithmetic, no conditionals, no calls. A rules
 * engine that evaluates expressions is one that can loop, fail at run time, or
 * be handed something hostile out of a bank statement.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees, type Paise } from "../core/money.ts";
import { renderTemplate, applyRules, TEMPLATE_FIELDS, type RuleSubject, type Rule } from "./rules.ts";

function subject(over: Partial<RuleSubject> = {}): RuleSubject {
  return {
    narration: "UPI/SWIGGY/412345678901/Order",
    importedPayee: "SWIGGY",
    payee: null,
    accountId: "acc-1",
    amount: -rupees(450) as Paise,
    date: "2026-08-10",
    memo: null,
    tags: [],
    categoryId: null,
    cleared: false,
    source: "statement",
    cardLast4: null,
    channel: "UPI",
    vpa: "swiggy@ybl",
    merchant: "Swiggy",
    reference: "412345678901",
    ...over,
  };
}

describe("substitution", () => {
  test("a field is replaced by its value", () => {
    assert.equal(
      renderTemplate(subject(), "Ref {reference} via {channel}"),
      "Ref 412345678901 via UPI",
    );
  });

  test("several fields at once", () => {
    assert.equal(
      renderTemplate(subject(), "{merchant} — {vpa} — {date}"),
      "Swiggy — swiggy@ybl — 2026-08-10",
    );
  });

  test("a known field that is empty becomes empty, because that is its value", () => {
    assert.equal(renderTemplate(subject({ vpa: null }), "Paid to [{vpa}]"), "Paid to []");
  });

  test("an unknown placeholder is left exactly as written", () => {
    /*
     * A typo that silently became "" would look like the rule working, and the
     * household would find empty memos with no reason for them.
     */
    assert.equal(
      renderTemplate(subject(), "Ref {refrence}"), "Ref {refrence}",
      "a misspelt field was swallowed",
    );
  });

  test("text with no placeholders is unchanged", () => {
    assert.equal(renderTemplate(subject(), "Weekly groceries"), "Weekly groceries");
  });

  test("every advertised field actually resolves", () => {
    for (const field of TEMPLATE_FIELDS) {
      const out = renderTemplate(subject(), `<{${field}}>`);
      assert.doesNotMatch(
        out, /\{/,
        `${field} is offered but does not resolve`,
      );
    }
  });
});

describe("what it refuses to be", () => {
  test("it does not evaluate anything", () => {
    // Not an expression language, deliberately.
    for (const attempt of ["{1+1}", "{amount * 2}", "{narration.length}", "{constructor}"]) {
      assert.equal(
        renderTemplate(subject(), attempt), attempt,
        `${attempt} was interpreted rather than left alone`,
      );
    }
  });

  test("a narration cannot inject a placeholder of its own", () => {
    /*
     * The narration comes from a bank statement, which is data this app did not
     * write. If substitution recursed, a narration containing "{vpa}" would be
     * expanded on the next pass.
     */
    const s = subject({ narration: "PAYMENT {vpa} {reference}" });
    const out = renderTemplate(s, "{narration}");
    assert.equal(out, "PAYMENT {vpa} {reference}", "the narration's braces were expanded");
  });
});

describe("rules using it", () => {
  // A rule with no conditions deliberately never matches, so these carry one
  // that the fixture satisfies.
  const rule = (actions: Rule["actions"]): Rule => ({
    id: "r1", name: "t", stage: "default",
    conditions: [{ field: "merchant", op: "contains", value: "Swiggy" }],
    match: "all", actions, enabled: true, proposed: false,
  });

  test("setMemo interpolates", () => {
    const out = applyRules(subject(), [rule([{ type: "setMemo", memo: "UPI ref {reference}" }])]);
    assert.equal(out.subject.memo, "UPI ref 412345678901");
  });

  test("append sees the memo already there, not itself", () => {
    const out = applyRules(
      subject({ memo: "Dinner" }),
      [rule([{ type: "setMemo", memo: "(ref {reference})", mode: "append" }])],
    );
    assert.equal(out.subject.memo, "Dinner (ref 412345678901)");
  });

  test("setPayee interpolates too", () => {
    const out = applyRules(subject(), [rule([{ type: "setPayee", payee: "{merchant}" }])]);
    assert.equal(out.subject.payee, "Swiggy");
  });

  test("a rule with no placeholders behaves exactly as before", () => {
    const out = applyRules(subject(), [rule([{ type: "setMemo", memo: "Groceries" }])]);
    assert.equal(out.subject.memo, "Groceries");
  });
});
