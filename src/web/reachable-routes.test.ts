/**
 * Every POST route has something that posts to it.
 *
 * B72 already holds that every domain mutation is called from app.ts, and the
 * component test holds that every page component is rendered by something.
 * Between them sat a gap wide enough to lose a feature in: a route can be
 * properly registered, call its domain function, be covered by tests, and have
 * nothing anywhere that submits to it.
 *
 * That is what happened to /schedules/:id/splits. The engine worked, the route
 * worked, the tests passed, and a household had no way to reach it — the same
 * shape as every other bug this codebase has found, which is a thing that
 * exists, works, and is connected to nothing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Routes reached by something other than a form in a page: the API, a
 * redirect, or a client script. Each needs a reason.
 */
const NOT_FROM_A_FORM: Record<string, string> = {
  "/auth/dev": "The development sign-in, rendered by a module a production build deletes.",
  "/demo/enter": "The demo front door, rendered only when DEMO_MODE is on.",
  "/auth/password": "Rendered on /signin, which this scan does not read as a page component.",
  "/auth/first-run": "Its own bare page, posted to by the form it renders.",
  "/tax": "Posted to by the tax page's own form, which is built in web/pages/tax.ts.",

  /*
   * Reachable, but by markup this scan cannot see: the action is built from a
   * variable, or the path has two parameters. Each was checked by hand.
   */
  "/transaction/:id": "review.ts posts to /transaction/${t.id}/categorise; the bare :id is the edit form.",
  "/accounts/:id/cards/:cardId/close": "accounts.ts:893 — two parameters, which the prefix match cannot follow.",
  "/categories/:id/reorder": "manage.ts builds the action through the reorder() helper, from a variable.",
  "/groups/:id/reorder": "manage.ts, the same reorder() helper.",
};

function pageSources(): string {
  const dir = join(here, "pages");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

describe("B72 · a route nobody can reach is not a feature", () => {
  test("every POST route has a form somewhere that submits to it", () => {
    const app = readFileSync(join(here, "..", "app.ts"), "utf8");
    /*
     * app.ts with its own route registrations stripped out.
     *
     * The first version of this scanned app.ts whole, so every route matched
     * its own `router.post("/schedules/:id/splits"` line and the test passed
     * with the form deleted — a test that cannot fail, which is worse than no
     * test. Only markup counts as reaching a route.
     */
    const appMarkup = app.replace(/router\.(post|get)\("[^"]+"/g, "");
    const pages = pageSources() + appMarkup;

    const posts = [...app.matchAll(/router\.post\("([^"]+)"/g)].map((m) => m[1]!);
    const unreachable: string[] = [];

    for (const route of posts) {
      if (route in NOT_FROM_A_FORM) continue;
      /*
       * A route with :params is matched by its literal prefix, because the
       * form writes `action="/categories/${c.id}/merge"` — the shape around
       * the parameter is what identifies it.
       */
      const literal = route.split("/:")[0]!;
      const tail = route.includes("/:") ? route.slice(route.indexOf("/:")).split("/").slice(2) : [];
      const needle = tail.length > 0 ? `/${tail.join("/")}"` : `${literal}"`;

      const reachable = tail.length > 0
        ? pages.includes(needle) && pages.includes(literal)
        : pages.includes(`action="${route}"`) || pages.includes(`"${route}"`);

      if (!reachable) unreachable.push(route);
    }

    assert.deepEqual(
      unreachable, [],
      "these routes have no form pointing at them — add one, or list it in " +
      "NOT_FROM_A_FORM with the reason it is reached another way",
    );
  });

  test("the exemptions all give a reason", () => {
    for (const [route, reason] of Object.entries(NOT_FROM_A_FORM)) {
      assert.ok(reason.length > 20, `${route} needs a real reason, not "${reason}"`);
    }
  });
});
