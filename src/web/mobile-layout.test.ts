/**
 * B118 · Nothing runs out through the side of the box it is in.
 *
 * On a phone, an account row — name and chips on the left, the balance and a
 * sparkline on the right — pushed the balance clean through the right-hand edge
 * of its card, clipped mid-digit. On a page of balances, a number cut off after
 * "-₹17,46,25" is the worst possible thing to truncate, because it is still
 * legible and it is wrong.
 *
 * The cause was one line of CSS in two halves: a flex item will not go narrower
 * than its content unless told it may, and a row will not become two lines
 * unless told it may. Both are now told.
 *
 * A full-fidelity check needs a browser, and the sweep that found this drives
 * one (`scratchpad/overflow.mjs`). What is worth holding here, in the suite, is
 * the rule itself — because it is one deletion away from coming back, and the
 * symptom appears only at a width no test renders at.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { STYLESHEET } from "./styles.ts";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

describe("B118 · rows may shrink and may wrap", () => {
  test("flex children are allowed to go narrower than their content", () => {
    assert.match(
      STYLESHEET,
      /\.row > \*, \.row-between > \* \{ min-width: 0; \}/,
      "without min-width: 0 a flex item overflows instead of ellipsising",
    );
  });

  test("both row helpers wrap", () => {
    for (const rule of [/\.row \{[^}]*flex-wrap: wrap/, /\.row-between \{[^}]*flex-wrap: wrap/]) {
      assert.match(STYLESHEET, rule, "a row that cannot wrap can only overflow");
    }
  });

  test("a wrapped row keeps its right-hand half on the right", () => {
    assert.match(STYLESHEET, /\.row-between > :first-child ~ :last-child \{ margin-left: auto; \}/);
  });
});

/**
 * Wide content scrolls inside its own box. Six columns of rupees will never fit
 * 375px, and the honest answer is a table that scrolls sideways within the card
 * — not a card pushed off the screen, which takes the page's whole layout with
 * it.
 */
describe("B118 · every table scrolls inside its own box", () => {
  const pages = readdirSync(join(here, "pages")).filter((f) => f.endsWith(".ts") && !f.includes(".test."));

  test(".table-scroll wraps every table a page renders", () => {
    const offenders: string[] = [];
    for (const file of pages) {
      const source = readFileSync(join(here, "pages", file), "utf8");
      const lines = source.split("\n");
      lines.forEach((line, i) => {
        if (!/<table[\s>]/.test(line)) return;
        // The wrapper is allowed to be a few lines up — a comment often sits
        // between them — but it has to be there.
        const above = lines.slice(Math.max(0, i - 6), i).join("\n");
        if (!above.includes("table-scroll")) offenders.push(`${file}:${i + 1}`);
      });
    }
    assert.deepEqual(
      offenders, [],
      `these tables can push their card off a phone screen: ${offenders.join(", ")}`,
    );
  });

  test("and .table-scroll actually scrolls", () => {
    assert.match(STYLESHEET, /\.table-scroll \{[^}]*overflow-x: auto/);
  });
});
