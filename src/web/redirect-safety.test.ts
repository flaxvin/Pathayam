/**
 * Somewhere inside this app, and nowhere else.
 *
 * Four places took a redirect target straight from the request: the theme
 * toggle, the review queue, the impersonation banner, and sign-in. The last is
 * the one that matters — an open redirect on a sign-in flow lands somebody on
 * another site at the exact moment they have proved who they are and are
 * expecting to be somewhere familiar.
 *
 * One of the four did check, with `startsWith("/")`, which reads as safe and is
 * not: `//evil.example` starts with a slash and is a protocol-relative URL the
 * browser resolves to another host.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

const RAVI = "m-ravi";
const app = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "app.ts"), "utf8",
);

/** Where a redirect target can come in from the request. */
const SOURCES = [
  'field(ctx.body, "return_to")',
  "pending.next",
];

describe("a redirect goes somewhere inside this app", () => {
  test("every request-supplied target is filtered", () => {
    const unfiltered: string[] = [];
    for (const source of SOURCES) {
      let from = 0;
      for (;;) {
        const at = app.indexOf(source, from);
        if (at === -1) break;
        from = at + source.length;
        // The 120 characters before it: a filtered use reads
        // `redirect: safePath(<source>, "/…")`.
        const before = app.slice(Math.max(0, at - 120), at);
        if (/redirect:\s*$/.test(before.replace(/\s+/g, " ").trimEnd() + " ")) {
          unfiltered.push(`${source} at ${app.slice(0, at).split("\n").length}`);
        }
      }
    }
    assert.deepEqual(
      unfiltered, [],
      "a redirect target reaches the response without going through safePath",
    );
  });

  test("the bypass that reads as safe is rejected", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    const signed = await startTestApp(db, { memberId: RAVI });
    try {
      for (const target of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
        const res = await signed.post("/settings/theme", { theme: "dark", return_to: target });
        assert.equal(
          res.headers.get("location"), "/",
          `${target} was accepted as a redirect target`,
        );
      }
      // And an ordinary path still works, or the fix has broken the feature.
      const ok = await signed.post("/settings/theme", { theme: "light", return_to: "/accounts" });
      assert.equal(ok.headers.get("location"), "/accounts");
      assert.deepEqual(signed.failures, []);
    } finally {
      await signed.close();
    }
  });
});
