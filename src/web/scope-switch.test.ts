/**
 * N6 · Two controls for one question is one control too many.
 *
 * The header and the sidebar carry a row of pills — Household, Ravi, Priya —
 * that says which budget a screen is about. Reports and Query asked the same
 * question with a dropdown, in a card, in different words ("The household's"
 * where the header says "Household"), in a different place on the page.
 *
 * `16`'s decision that those two screens offer *every* scope rather than
 * picking one is untouched. The extra scope is now an extra pill —
 * **Everything** — rather than an extra kind of control.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderScopeSwitch } from "./scope-switch.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), "utf8");

const BUDGETS = [
  { id: "b-house", name: "Household budget", kind: "household" },
  { id: "b-ravi", name: "Ravi", kind: "personal" },
];

describe("N6 · one control for whose money", () => {
  test("the header, Reports and Query all render the same component", () => {
    for (const [file, where] of [
      ["layout.ts", "the header"],
      ["pages/analysis.ts", "Reports and Query"],
    ] as const) {
      assert.match(
        read(file), /renderScopeSwitch\(/,
        `${where} builds its own scope control instead of using the shared one`,
      );
    }
  });

  test("Reports no longer asks with a dropdown", () => {
    const analysis = read("pages/analysis.ts");
    assert.ok(
      !analysis.includes('id="report-scope"') && !analysis.includes('<label for="scope">'),
      "the select is back, so the app has two different controls for one question",
    );
  });

  test("the words are the header's words", () => {
    const out = renderScopeSwitch({
      budgets: BUDGETS, current: "all", everything: true,
      href: (s) => `/reports?scope=${s}`, label: "Whose money",
    }).value;
    assert.match(out, /Everything/);
    assert.match(out, /Household/);
    assert.ok(!out.includes("The household's"), "Reports still says it its own way");
  });

  test("the one in force is marked, and not by colour alone", () => {
    const out = renderScopeSwitch({
      budgets: BUDGETS, current: "b-ravi",
      href: (s) => `/x?scope=${s}`, label: "Which budget",
    }).value;
    // A2 · a mark and a word, for somebody who cannot see the highlight.
    assert.match(out, /aria-current="true"/);
    assert.match(out, /●/);
    assert.match(out, /<span class="sr-only">\(selected\)<\/span>/);
    assert.ok(!out.includes("Everything"), "a screen that scopes to one budget offered all of them");
  });

  test("it works without scripting, which the dropdown did not", () => {
    const out = renderScopeSwitch({
      budgets: BUDGETS, current: "all", everything: true,
      href: (s) => `/reports?scope=${s}`, label: "Whose money",
    }).value;
    assert.ok(!out.includes("onchange"), "it needs a script to do anything");
    assert.match(out, /<a href="\/reports\?scope=b-ravi"/);
  });

  test("switching scope on Query keeps the question you were asking", () => {
    // The dropdown was inside the filter form, so submitting carried every other
    // field. A link has to carry them itself or the switch silently resets the
    // period, the grouping, the text and the account.
    const analysis = read("pages/analysis.ts");
    const builder = analysis.slice(analysis.indexOf("function filterQueryString"));
    const body = builder.slice(0, builder.indexOf("\n}"));
    for (const carried of ["period", "group_by", "q", "scope", "account", "category"]) {
      assert.match(
        body, new RegExp(`\\b${carried}\\b`),
        `the filter link drops ${carried}, so switching scope resets it`,
      );
    }
  });
});
