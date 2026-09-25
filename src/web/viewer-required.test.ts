/**
 * Structural privacy: a screen names who is looking, or says why it does not.
 *
 * Twelve leaks were found in a week and every one had the same shape — a
 * function that *can* take a viewer, called from a route that did not give it
 * one. The fixes were correct and each was found by looking, which is the part
 * that does not scale: the person who writes the thirteenth screen will not
 * remember, because there is nothing to remember it for them.
 *
 * `privacy-sweep.test.ts` catches a leak after it is written, by rendering every
 * screen as somebody else and looking for a planted string. This catches it as
 * it is written, and catches the two kinds the sweep cannot:
 *
 * - **A leaked number.** The Overview's net-worth headline was the whole
 *   household's while the page behind it was the viewer's, so ₹55.6L and ₹28.6L
 *   sat two clicks apart and the difference was the private money — published by
 *   subtraction, with no string to search for.
 * - **A parameterised route.** The sweep skips `/loans/:id` because it addresses
 *   one thing; the charge-category picker on that page was offering every
 *   budget's envelopes.
 *
 * The rule: if a function accepts `viewerMemberId`, every call in `app.ts`
 * passes one — or its line is in `WHOLE_HOUSEHOLD` with a reason. Reading the
 * signature out of the source means a function that gains a viewer tomorrow is
 * enforced tomorrow.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..");
const app = readFileSync(join(src, "app.ts"), "utf8");

/**
 * Calls that deliberately see everything, by the call's own text so the entry
 * cannot drift onto a different line. Each needs a reason.
 */
const WHOLE_HOUSEHOLD: Record<string, string> = {
  // D14 · Auto-assign's plan was the one exemption; it now reads one budget, as
  // the person looking at it, like every other screen.
};

/** Every function in the app that accepts a viewer, read from its signature. */
function viewerTakers(): Set<string> {
  const found = new Set<string>();
  for (const dir of ["domain", "web", "import", "engine"]) {
    for (const file of readdirSync(join(src, dir), { recursive: true }) as string[]) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.includes("test-data")) continue;
      let source: string;
      try {
        source = readFileSync(join(src, dir, file), "utf8");
      } catch {
        continue; // a directory, which recursive listing includes
      }
      for (const m of source.matchAll(/export function ([A-Za-z0-9_]+)\s*\(/g)) {
        let depth = 0;
        let j = m.index + m[0].length - 1;
        while (j < source.length) {
          if (source[j] === "(") depth++;
          else if (source[j] === ")") { depth--; if (depth === 0) break; }
          j++;
        }
        /*
         * The signature, plus the first few lines of the body. Some take a
         * named options type — `opts: AccountListOptions` — whose field is
         * declared elsewhere, and reading `opts.viewerMemberId` in the body is
         * the same promise made a different way.
         */
        const signature = source.slice(m.index, j);
        // A *use* of the parameter's field, not merely the word appearing in a
        // neighbouring function — `getLoan` sits a few lines from one and was
        // being counted.
        const opening = source.slice(j, j + 400);
        if (
          signature.includes("viewerMemberId")
          || /\b(opts|input|filter|q)\.viewerMemberId/.test(opening)
        ) {
          found.add(m[1]!);
        }
      }
    }
  }
  return found;
}

/** Every call to those functions in app.ts, with the text of the call. */
function callsWithoutAViewer(takers: Set<string>): { line: number; call: string }[] {
  const bare: { line: number; call: string }[] = [];
  for (const name of takers) {
    for (const m of app.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
      let depth = 0;
      let j = m.index + m[0].length - 1;
      while (j < app.length) {
        if (app[j] === "(") depth++;
        else if (app[j] === ")") { depth--; if (depth === 0) break; }
        j++;
      }
      const call = app.slice(m.index, j + 1).replace(/\s+/g, " ");
      if (call.includes("viewer(ctx)") || call.includes("viewerMemberId")) continue;
      /*
       * `{ ...filter }` carries one: every filter in app.ts is built by
       * `filterFromQuery`, which sets it. The test below holds that true.
       */
      if (call.includes("...filter")) continue;
      bare.push({ line: app.slice(0, m.index).split("\n").length, call });
    }
  }
  return bare;
}

describe("15 / H2.2 · a screen names who is looking", () => {
  const takers = viewerTakers();

  test("there are functions to check", () => {
    assert.ok(takers.size > 10, `only ${takers.size} functions take a viewer`);
    for (const expected of ["buildBudgetView", "listCategories", "netWorthStatement", "listAccounts"]) {
      assert.ok(takers.has(expected), `${expected} should take a viewer and does not`);
    }
  });

  test("every call in app.ts passes one, or says why not", () => {
    const unexplained = callsWithoutAViewer(takers)
      .filter(({ call }) => !(call in WHOLE_HOUSEHOLD));

    assert.deepEqual(
      unexplained.map((c) => `app.ts:${c.line}  ${c.call}`), [],
      "these read the whole household and hand it to one person — pass " +
      "viewer(ctx), or add the call to WHOLE_HOUSEHOLD with a reason",
    );
  });

  test("the one filter every screen shares carries a viewer", () => {
    // `{ ...filter }` is accepted above on this promise, so it is checked here.
    const builder = app.slice(app.indexOf("function filterFromQuery"));
    const body = builder.slice(0, builder.indexOf("\n  }"));
    assert.match(
      body, /viewerMemberId: viewer\(ctx\)/,
      "filterFromQuery stopped naming the viewer, and Query, Search and the CSV " +
      "all spread it",
    );
  });

  test("the exemptions still exist", () => {
    const stale = Object.keys(WHOLE_HOUSEHOLD)
      .filter((call) => !app.replace(/\s+/g, " ").includes(call));
    assert.deepEqual(stale, [], `no longer in app.ts: ${stale.join(", ")}`);
  });

  test("and each one gives a reason", () => {
    for (const [call, why] of Object.entries(WHOLE_HOUSEHOLD)) {
      assert.ok(why.length > 40, `${call} needs a real reason, not a placeholder`);
    }
  });
});
