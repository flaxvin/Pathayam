/**
 * B72 · A domain mutation with no way to reach it is not a feature.
 *
 * This has now happened often enough to be a class rather than a run of bad
 * luck. `reopenMonth` shipped with no control (B51). One envelope per goal
 * shipped with no editor (B58). Universal undo was complete, handler by
 * handler, and callable from exactly one route (B65). An auto-assign engine was
 * written, tested ten times over, and driven by a table nothing wrote (B67). A
 * rate-reset comparison was written, styled and rendered by nobody (B71). An
 * account could be created and never closed, though F2.7 promised otherwise
 * (B70).
 *
 * Every one of those passed the whole test suite, because a function can be
 * correct and unreachable at the same time and unit tests only ask about the
 * first. This test asks the second question: does anything the household could
 * press eventually call this?
 *
 * The allowlist is the point of the design. A name on it is a deliberate
 * statement that the function is internal or not yet surfaced — which is fine,
 * as long as somebody wrote it down.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..");

/**
 * Functions that change data and are deliberately not reachable from a screen.
 * Each needs a reason. Delete the entry when you wire it up; add one only when
 * you mean it.
 */
const NOT_YET_SURFACED: Record<string, string> = {
  restoreTransaction:
    "Reachable as Activity's undo of the delete event, which is the better route — " +
    "a separate 'restore' screen would need a list of deleted transactions first.",
  reopenFamilyLoan:
    "A family arrangement is closed when the money comes back; reopening is rare " +
    "enough that Activity's undo covers it.",
  backfillMonthlySnapshots:
    "A one-off repair for a database that predates dated net-worth history. It is " +
    "run from a console, not a screen, because it rewrites history.",
  recordReturnOfCapital:
    "07 supports it; no holding this household owns has ever paid one. Surface it " +
    "when one does, rather than shipping a form nobody can test against reality.",
  reanchorToLenderBalance:
    "Drift against the lender is surfaced on the loan page, which routes to the " +
    "statement form; re-anchoring directly would bypass that reconciliation.",
  closeLoan:
    "A loan closes by being repaid, which the instalment and prepayment screens " +
    "already do. An explicit close is for a settlement, which is not yet modelled.",
};

/**
 * Whether a function writes, read from its body rather than guessed from its
 * name. `recordedDisbursements` sums a column and `recordDividend` inserts
 * rows; a verb list cannot tell those apart, and the one that matters is the
 * one that changes data.
 *
 * Finding the body means stepping over the parameter list first — several of
 * these declare an inline object type, so the first brace after the name
 * belongs to the parameters, not the function.
 */
function bodyOf(source: string, name: string): string | null {
  const signature = new RegExp(`^export (?:async )?function ${name}\\b`, "m");
  const start = source.search(signature);
  if (start < 0) return null;

  let i = source.indexOf("(", start);
  if (i < 0) return null;
  for (let depth = 0; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const open = source.indexOf("{", i);
  if (open < 0) return null;

  let depth = 0;
  let end = open;
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(open, end);
}

function isMutation(source: string, name: string): boolean {
  const body = bodyOf(source, name);
  return body !== null && /\bexecute\(|\bappendEvent\(/.test(body);
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return walk(path);
    return e.isFile() && e.name.endsWith(".ts") && !e.name.includes(".test") ? [path] : [];
  });
}

describe("B72 · every domain mutation is reachable", () => {
  const domainFiles = walk(join(src, "domain"));
  const allSource = walk(src).map((f) => readFileSync(f, "utf8"));

  test("the domain layer was found", () => {
    assert.ok(domainFiles.length >= 8, `expected the domain modules, found ${domainFiles.length}`);
  });

  test("no mutation is stranded without a caller in app.ts", () => {
    const stranded: string[] = [];

    for (const file of domainFiles) {
      const source = readFileSync(file, "utf8");
      const exported = [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]!);

      for (const name of exported) {
        if (name in NOT_YET_SURFACED) continue;
        if (!isMutation(source, name)) continue;

        // Reachable means something outside its own declaration mentions it —
        // a route, the housekeeping loop, the seed, or another domain module
        // that is itself reachable. createGoal calling createCategory is a
        // perfectly good way to be reachable; nothing at all calling
        // closeAccount is not.
        const mentions = allSource
          .map((text) => [...text.matchAll(new RegExp(`\\b${name}\\b`, "g"))].length)
          .reduce((a, b) => a + b, 0);

        // One mention is the `export function` line itself.
        if (mentions <= 1) stranded.push(`${name} (${file.replace(src, "src")})`);
      }
    }

    assert.deepEqual(
      stranded,
      [],
      "these change data and nothing can reach them — wire them to a route, or " +
      "add them to NOT_YET_SURFACED with the reason",
    );
  });

  test("the allowlist has no stale entries", () => {
    const all = domainFiles
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const stale = Object.keys(NOT_YET_SURFACED).filter(
      (name) => !new RegExp(`^export (?:async )?function ${name}\\b`, "m").test(all),
    );
    assert.deepEqual(stale, [], "these are allowlisted but no longer exist");
  });
});

describe("B72 · rendered components are rendered by something", () => {
  test("every exported page component is used by app.ts or another page", () => {
    const pageFiles = walk(join(src, "web", "pages"));
    const appSource = readFileSync(join(src, "app.ts"), "utf8");
    const orphans: string[] = [];

    for (const file of pageFiles) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/^export function (render\w+)/gm)) {
        const name = m[1]!;
        const inApp = new RegExp(`\\b${name}\\b`).test(appSource);
        const inOtherPage = pageFiles
          .filter((f) => f !== file)
          .some((f) => new RegExp(`\\b${name}\\b`).test(readFileSync(f, "utf8")));
        // Used within its own file counts too — a shared sub-component.
        const usesLeft = [...source.matchAll(new RegExp(`\\b${name}\\b`, "g"))].length > 1;
        if (!inApp && !inOtherPage && !usesLeft) orphans.push(`${name} (${file.replace(src, "src")})`);
      }
    }

    assert.deepEqual(
      orphans,
      [],
      "these screens are built and nothing renders them — B71 was exactly this",
    );
  });
});
