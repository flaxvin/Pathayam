/**
 * The sitemap is a list that goes stale silently.
 *
 * Nothing in a build fails when a page is added and the sitemap is not told —
 * the page simply stays out of the index, and the first sign of it is somebody
 * wondering months later why the roadmap never appears in search. A hand-kept
 * list of files is exactly the kind of thing this project tests, for the same
 * reason the README banner's figures are tested: the failure mode is silence.
 *
 * So this holds `website/sitemap.xml` to `website/*.html` in both directions,
 * and checks the handful of details that make a sitemap ignorable rather than
 * wrong — the namespace, the canonical host, and `index.html` appearing as the
 * root rather than as a second URL for the same page.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const SITE = "https://pathayam.app";
const sitemap = readFileSync("website/sitemap.xml", "utf8");
const robots = readFileSync("website/robots.txt", "utf8");

/*
 * Comments stripped, for the assertions that are about elements rather than
 * prose — the file's own comment explains why changefreq and priority are
 * absent, and naming them there should not read as using them.
 */
const elements = sitemap.replace(/<!--[\s\S]*?-->/g, "");

const pages = readdirSync("website")
  .filter((f) => f.endsWith(".html"))
  .sort();

/** Every <loc>, in document order. */
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);

function expectedLocFor(page: string): string {
  return page === "index.html" ? `${SITE}/` : `${SITE}/${page}`;
}

describe("the sitemap lists the site, and only the site", () => {
  test("every page is in it", () => {
    const missing = pages.filter((p) => !locs.includes(expectedLocFor(p)));
    assert.deepEqual(
      missing, [],
      "a page exists that the sitemap has never heard of — it will not be indexed",
    );
  });

  test("and nothing in it is a page that does not exist", () => {
    const expected = new Set(pages.map(expectedLocFor));
    const stale = locs.filter((l) => !expected.has(l));
    assert.deepEqual(stale, [], "the sitemap points a crawler at a 404");
  });

  test("no URL appears twice", () => {
    assert.equal(new Set(locs).size, locs.length, "a duplicate <loc>");
  });

  test("the home page is the root, not /index.html", () => {
    // Both are served, and listing the file form invites the two to be treated
    // as separate pages with the same content.
    assert.ok(locs.includes(`${SITE}/`), "the root is not listed");
    assert.ok(
      !locs.includes(`${SITE}/index.html`),
      "index.html is listed as its own URL, which splits the home page in two",
    );
  });
});

describe("the details that decide whether it is read at all", () => {
  test("the namespace is exactly right", () => {
    // A typo here is not an error anywhere — the file parses, and is ignored.
    assert.match(
      sitemap,
      /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/,
      "wrong or misspelled sitemap namespace",
    );
  });

  test("it is well-formed enough to parse", () => {
    assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.equal(
      (sitemap.match(/<url>/g) ?? []).length,
      (sitemap.match(/<\/url>/g) ?? []).length,
      "an unclosed <url>",
    );
    assert.equal((sitemap.match(/<\/urlset>/g) ?? []).length, 1);
  });

  test("every URL is absolute, https, and on the canonical host", () => {
    for (const loc of locs) {
      assert.ok(loc.startsWith(`${SITE}/`), `${loc} is not on ${SITE}`);
    }
  });

  test("every lastmod is a real date, and not in the future", () => {
    const dates = [...sitemap.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]!);
    assert.equal(dates.length, locs.length, "a <url> without a <lastmod>");
    const today = new Date().toISOString().slice(0, 10);
    for (const d of dates) {
      assert.match(d, /^\d{4}-\d{2}-\d{2}$/, `"${d}" is not a date`);
      assert.ok(d <= today, `${d} is in the future, which makes every date here suspect`);
    }
  });

  test("changefreq and priority are absent", () => {
    // Ignored by every major crawler; kept out so there is nothing to go stale.
    assert.doesNotMatch(elements, /<changefreq>/);
    assert.doesNotMatch(elements, /<priority>/);
  });
});

describe("robots.txt points at it", () => {
  test("the sitemap is declared, at its real URL", () => {
    assert.match(
      robots, new RegExp(`^Sitemap: ${SITE}/sitemap\\.xml$`, "m"),
      "a crawler has no way to find the sitemap without being told",
    );
  });

  test("nothing is disallowed", () => {
    // The site is public marketing and docs. If this ever gains a Disallow it
    // should be a deliberate act, with this test updated to say why.
    assert.doesNotMatch(robots, /^Disallow: \S/m);
  });
});
