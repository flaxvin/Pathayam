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
