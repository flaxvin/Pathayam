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
import { queryOne } from "../db/db.ts";

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

  test("SECURITY-OPS-3 · the theme toggle is a POST that returns only inside the app", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    const signed = await startTestApp(db, { memberId: RAVI });
    const theme = () => queryOne<{ theme: string }>(db, `SELECT theme FROM members WHERE id = ?`, RAVI)!.theme;
    try {
      // A cross-site link is a GET with the cookie attached (SameSite=Lax), so
      // a GET must not write; and the prefix-matching Referer went elsewhere.
      const before = theme();
      const link = await signed.get("/settings/theme-toggle", {
        headers: { Referer: "http://127.0.0.1.evil.example/phish" },
      });
      assert.notEqual(link.status, 303);
      assert.equal(link.headers.get("location"), null);
      assert.equal(theme(), before, "a GET flipped the theme");

      // A cross-site form post is refused by the origin check.
      const forged = await signed.post("/settings/theme-toggle", { return_to: "/accounts" }, {
        headers: { Origin: "https://evil.example" },
      });
      assert.equal(forged.status, 403);
      assert.equal(theme(), before);

      // The palette's post flips it and comes back to where it was.
      const ok = await signed.post("/settings/theme-toggle", { return_to: "/accounts?x=1" });
      assert.equal(ok.headers.get("location"), "/accounts?x=1");
      assert.notEqual(theme(), before);
      const away = await signed.post("/settings/theme-toggle", { return_to: "//evil.example" });
      assert.equal(away.headers.get("location"), "/");
      assert.deepEqual(signed.failures, []);
    } finally {
      await signed.close();
    }
  });
});
