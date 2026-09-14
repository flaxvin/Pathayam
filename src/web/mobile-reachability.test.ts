/**
 * B116 · The sidebar is a desktop affordance, so nothing may live only in it.
 *
 * Below 900px the sidebar is `display: none` and a five-item bottom bar takes
 * over, with *More* standing in for everything the bar has no room for. That
 * works exactly as long as *More* is kept in step with the sidebar — and it was
 * not. Household, Overview, Portfolio, Allocation, Net worth and Valuations were
 * on the sidebar and on no mobile surface at all: six screens a phone could not
 * reach, including the one that answers *what do we owe each other*.
 *
 * Worse, the budget switcher was sidebar-only, so on a phone there was no way to
 * move between the household's budget and your own — and every screen that means
 * "one budget's money" showed one budget's money with no way to say which.
 *
 * `link-coverage.test.ts` could not see this: every one of those links pointed
 * at a route that existed. The link was fine. The *menu* was missing.
 *
 * So this is the standing rule, checked statically: whatever the sidebar offers,
 * a phone can reach.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const layout = readFileSync(join(here, "layout.ts"), "utf8");
const manage = readFileSync(join(here, "pages", "manage.ts"), "utf8");

/** Every literal internal path a source file renders as an href. */
function hrefs(source: string): Set<string> {
  const found = new Set<string>();
  for (const m of source.matchAll(/href="(\/[^"$]*)"/g)) found.add(m[1]!);
  // The nav arrays are `{ href: "/x", … }` objects rather than attributes.
  for (const m of source.matchAll(/href:\s*"(\/[^"]*)"/g)) found.add(m[1]!);
  // renderMore's groups are tuples: ["/path", "Label", "blurb"].
  for (const m of source.matchAll(/\[\s*"(\/[^"]*)"\s*,\s*"/g)) found.add(m[1]!);
  return found;
}

/**
 * What the sidebar offers. Everything between the `.sidebar` nav's opening tag
 * and its close — read from the source, so adding a sidebar entry adds it here
 * without anybody remembering to.
 */
function sidebarPaths(): Set<string> {
  const start = layout.indexOf('<nav class="sidebar"');
  assert.ok(start > 0, "the sidebar markup moved; this test needs to follow it");
  const end = layout.indexOf("</nav>", start);
  return hrefs(layout.slice(start, end));
}

/** What a phone can reach: the bottom bar, plus everything on the More page. */
function mobilePaths(): Set<string> {
  const navStart = layout.indexOf("const PRIMARY_NAV");
  const navEnd = layout.indexOf("];", navStart);
  return new Set([
    ...hrefs(layout.slice(navStart, navEnd)),
    ...hrefs(manage.slice(manage.indexOf("export function renderMore"))),
  ]);
}

describe("B116 · a phone can reach everything the sidebar offers", () => {
  test("no screen is desktop-only", () => {
    const mobile = mobilePaths();
    const missing = [...sidebarPaths()].filter((p) => !mobile.has(p));
    assert.deepEqual(
      missing, [],
      `these are on the sidebar and on no mobile surface: ${missing.join(", ")}`,
    );
  });

  test("the budget switcher is not sidebar-only", () => {
    // On a phone the header carries it, because the header is on every screen at
    // every width. Both are driven by the same honoursBudget(path) test, so they
    // appear and disappear together.
    assert.ok(
      // N6 · One component, two places: the header's copy carries the extra
      // class that keeps it inside a phone header and off a desktop one.
      layout.includes('"budget-switch scope-switch"'),
      "the header has no budget switcher, so a phone cannot change budget",
    );
    const header = layout.slice(
      layout.indexOf("function renderHeader"),
      layout.indexOf("function renderNotice"),
    );
    assert.ok(
      header.includes("honoursBudget(path)"),
      "the header's switcher must appear only where switching does something, " +
      "the same as the sidebar's",
    );
    assert.ok(
      header.includes("?budget="),
      "and it must actually carry the budget the reader picked",
    );
  });

  test("the switcher is hidden where the sidebar already carries it", () => {
    const styles = readFileSync(join(here, "styles.ts"), "utf8");
    const rule = styles.slice(styles.indexOf(".budget-switch"));
    assert.ok(
      /@media \(min-width: 900px\) \{ \.budget-switch \{ display: none/.test(rule),
      "two controls for one choice, side by side, on the same screen",
    );
  });
});
