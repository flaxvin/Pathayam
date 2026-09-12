/**
 * B83 · A backtick in a comment inside an html`` template.
 *
 * This has now cost time five separate times: in client.ts, in styles.ts, in a
 * migration's SQL comment, and twice in page markup. Writing `payeeStats` in an
 * HTML comment ends the template literal, and TypeScript then reports a syntax
 * error somewhere further down the file that has nothing to do with the comment.
 *
 * The compiler does catch it, so this is not about correctness — it is about
 * the ten minutes between the error message and the cause. This test names the
 * cause.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.isFile() && e.name.endsWith(".ts") && !e.name.includes(".test") ? [path] : [];
  });
}

describe("B83 · no backtick inside an HTML comment in a template", () => {
  test("page and layout sources are clean", () => {
    const offenders: string[] = [];

    for (const file of sources(here)) {
      const text = readFileSync(file, "utf8");
      // Only HTML comments, which is where this keeps happening: JSDoc above a
      // function is outside any template and backticks there are fine.
      for (const match of text.matchAll(/<!--[\s\S]*?-->/g)) {
        if (match[0].includes("`")) {
          const line = text.slice(0, match.index).split("\n").length;
          offenders.push(
            `${file.replace(here, "src/web")}:${line} — backtick in an HTML comment`,
          );
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "a backtick here ends the template literal; use plain words instead",
    );
  });
});

describe("B104 · no backtick inside any template literal's own comments", () => {
  /*
   * B83 guarded HTML comments in web pages. The same mistake has since happened
   * twice more outside that scope — in a SQL comment inside a migration's
   * template, and in a block comment inside the client script's String.raw
   * template. Both ended the literal early: one failed to compile with an
   * "octal literal" error 200 lines away, the other truncated the asset so the
   * browser got a syntax error instead of the app.
   *
   * So the guard now covers the two other places code lives inside a template:
   * SQL comments in migrations, and block comments in the client script.
   */

  test("SQL comments in migrations carry no backtick", () => {
    const text = readFileSync(join(here, "..", "db", "schema.ts"), "utf8");
    const offenders: string[] = [];
    for (const match of text.matchAll(/^\s*--.*$/gm)) {
      if (match[0].includes("`")) {
        offenders.push(`schema.ts:${text.slice(0, match.index).split("\n").length} — ${match[0].trim()}`);
      }
    }
    assert.deepEqual(offenders, [], "a backtick ends the migration's template literal");
  });

  test("the client script's comments carry no backtick", () => {
    const text = readFileSync(join(here, "client.ts"), "utf8");
    const start = text.indexOf("String.raw`");
    assert.ok(start > 0, "the client script is a String.raw template");
    // Everything after the opening delimiter is inside the literal.
    const body = text.slice(start + "String.raw`".length);
    const offenders: string[] = [];
    for (const match of body.matchAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm)) {
      if (match[0].includes("`")) {
        offenders.push(`client.ts:${text.slice(0, start + match.index!).split("\n").length}`);
      }
    }
    assert.deepEqual(offenders, [], "a backtick truncates the served client script");
  });
});
