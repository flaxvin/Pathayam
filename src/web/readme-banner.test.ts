/**
 * The README's banner has to be true.
 *
 * "1,119 tests · 37 migrations · 162 routes" sat at the top of the README while
 * the real figures were 1,371, 40 and 209. Nobody lied; the numbers were
 * written once and the project kept going. A README that overstates is
 * forgivable, but one that *understates* by 250 tests is quietly telling a
 * reader the project is less finished than it is — and either way, a figure
 * nobody checks is decoration.
 *
 * So it is checked. The tolerance is deliberate: an exact test count would fail
 * on every commit that adds one, which trains people to edit the number without
 * reading it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/*
 * The banner is the line with all four figures on it, not merely one that
 * mentions dependencies — the prose above it says "no runtime dependencies"
 * too, and matching that found a sentence instead of the banner.
 */
const banner = readFileSync(join(root, "README.md"), "utf8")
  .split("\n")
  .find((l) => /tests\s+·/.test(l) && l.includes("routes")) ?? "";

function claimed(label: string): number {
  const m = new RegExp(`([\\d,]+) ${label}`).exec(banner);
  return m ? Number(m[1]!.replace(/,/g, "")) : NaN;
}

describe("the README banner is not decoration", () => {
  test("it exists and carries the four figures", () => {
    assert.ok(banner, "the banner line is gone from the README");
    for (const label of ["tests", "migrations", "routes"]) {
      assert.ok(Number.isFinite(claimed(label)), `the banner no longer states ${label}`);
    }
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

  test("the test count is within a hundred of the suite", () => {
    /*
     * Counted by scanning for test() calls rather than by running the suite,
     * which this is part of. Close enough to catch a figure that has fallen
     * hundreds behind, loose enough not to fail on every new case.
     */
    const out = execSync(
      `grep -arhoE "^[[:space:]]*(test|it)\\(" ${join(root, "src")} --include=*.test.ts | wc -l`,
      { encoding: "utf8" },
    );
    const actual = Number(out.trim());
    assert.ok(
      Math.abs(claimed("tests") - actual) <= 100,
      `the banner says ${claimed("tests")} tests; the files define about ${actual}`,
    );
  });
});
