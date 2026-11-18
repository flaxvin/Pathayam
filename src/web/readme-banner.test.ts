/**
 * The README's banner has to be true.
 *
 * The banner once claimed 37 migrations and 162 routes while the real figures
 * were 40 and 209. Nobody lied; the numbers were written once and the project
 * kept going. A figure nobody checks is decoration, so these are checked.
 *
 * The banner deliberately states no test count: that figure goes stale on
 * every commit and says little to a reader, so it is kept out of the README,
 * the docs and the website altogether.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/*
 * The banner is the line with the figures on it, not merely one that mentions
 * dependencies — the prose above it says "no runtime dependencies" too, and
 * matching that found a sentence instead of the banner.
 */
const banner = readFileSync(join(root, "README.md"), "utf8")
  .split("\n")
  .find((l) => /migrations\s+·/.test(l) && l.includes("routes")) ?? "";

function claimed(label: string): number {
  const m = new RegExp(`([\\d,]+) ${label}`).exec(banner);
  return m ? Number(m[1]!.replace(/,/g, "")) : NaN;
}

describe("the README banner is not decoration", () => {
  test("it exists and carries its figures", () => {
    assert.ok(banner, "the banner line is gone from the README");
    for (const label of ["migrations", "routes"]) {
      assert.ok(Number.isFinite(claimed(label)), `the banner no longer states ${label}`);
    }
  });

  test("it states no test count", () => {
    assert.ok(!/\btests?\b/i.test(banner), `the banner mentions tests again: ${banner}`);
  });

  test("the migration count is exact, because it only ever goes up by one", () => {
    const schema = readFileSync(join(root, "src", "db", "schema.ts"), "utf8");
    const actual = (schema.match(/name: "\d{4}-/g) ?? []).length;
    assert.equal(claimed("migrations"), actual);
  });

  test("the route count is within ten of the router", () => {
    const app = readFileSync(join(root, "src", "app.ts"), "utf8");
    const actual = (app.match(/router\.(get|post)\("/g) ?? []).length;
    assert.ok(
      Math.abs(claimed("routes") - actual) <= 10,
      `the banner says ${claimed("routes")} routes; app.ts registers ${actual}`,
    );
  });
});
