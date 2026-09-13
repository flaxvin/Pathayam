/**
 * B120 · A route nothing links to is a route nobody will find.
 *
 * `link-coverage.test.ts` checks one direction — every link the UI renders
 * points at a route that exists. This checks the other, which is the direction
 * the bugs keep arriving from: a GET route is registered, rendered, tested, and
 * no screen anywhere offers a way in.
 *
 * It has happened five times now. The rate-reset comparison had a component and
 * no route (B71). A split had a route and no button (B72). The departure page
 * was linked only when the app was not in demo mode, so the demo — the one place
 * people look before installing — could reach it only by typing the URL. And
 * three CSV exports, including the lots file a capital-gains return is built
 * from, were routed and linked from nowhere at all.
 *
 * The allowlist is the design, exactly as in `reachability.test.ts`: a name on
 * it is a deliberate statement that a URL is reached some other way — a machine
 * calls it, an OAuth provider redirects to it, or it is the page you are
 * already on. Adding an entry should feel like a decision.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, "..", "app.ts"), "utf8");

/** GET routes that nothing links to on purpose, each with its reason. */
const REACHED_ANOTHER_WAY: Record<string, string> = {
  "/": "The brand in the header and the first item in every nav.",
  "/signin": "Where an unauthenticated request is sent; linking to it from inside " +
    "the app would be linking to the door you already came through.",
  "/auth/google": "The sign-in page's button, which is built from the provider config.",
  "/auth/google/callback": "Google redirects here. We never link to it.",
  "/gmail/callback": "Google redirects here after the mail-scope consent.",
  "/healthz": "For a monitor, not a person. Deliberately undiscoverable in the UI.",
};

function registeredGets(): string[] {
  return [...new Set(
    [...appSource.matchAll(/router\.get\(\s*"([^"]+)"/g)].map((m) => m[1]!),
  )].sort();
}

/** Everything the UI could navigate to, from any source that renders markup. */
function everythingLinked(): string {
  const files = [
    join(here, "..", "app.ts"),
    ...readdirSync(join(here, "pages")).map((f) => join(here, "pages", f)),
    ...readdirSync(here).filter((f) => f.endsWith(".ts")).map((f) => join(here, f)),
  ].filter((f) => !f.endsWith(".test.ts") && !f.includes("harness"));
  return files.map((f) => readFileSync(f, "utf8")).join("\n");
}

function isLinked(route: string, blob: string): boolean {
  const segments = route.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  const pattern = segments
    .map((s) => (s.startsWith(":") ? "[^\"'\\s`]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  const shapes = [
    // href="/x" and action="/x", with or without an interpolated prefix
    `(?:href|action)="[^"]*?/${pattern}`,
    // the nav arrays: { href: "/x", … }
    `href:\\s*"/${pattern}"`,
    // renderMore's tuples: ["/x", "Label", "blurb"]
    `"/${pattern}"\\s*,\\s*"`,
    // a redirect the app itself issues, or a client-side navigation
    `(?:redirect:|location\\.href\\s*=)\\s*[\`"']/${pattern}`,
  ];
  return shapes.some((s) => new RegExp(s).test(blob));
}

describe("B120 · every page can be reached by pressing something", () => {
  const blob = everythingLinked();

  test("no GET route is orphaned", () => {
    const orphans = registeredGets()
      .filter((r) => !(r in REACHED_ANOTHER_WAY))
      .filter((r) => !isLinked(r, blob));

    assert.deepEqual(
      orphans, [],
      "these routes exist and nothing on any screen leads to them — link them, " +
      `or add them to REACHED_ANOTHER_WAY with a reason: ${orphans.join(", ")}`,
    );
  });

  test("the allowlist has no stale entries", () => {
    const registered = new Set(registeredGets());
    const stale = Object.keys(REACHED_ANOTHER_WAY).filter((r) => !registered.has(r));
    assert.deepEqual(stale, [], `no longer routes at all: ${stale.join(", ")}`);
  });

  test("every allowlist entry carries a reason", () => {
    for (const [route, why] of Object.entries(REACHED_ANOTHER_WAY)) {
      assert.ok(why.length > 25, `${route} needs a real reason, not a placeholder`);
    }
  });
});
