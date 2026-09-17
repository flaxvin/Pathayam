/**
 * The legal pages say different things depending on who is running the app.
 *
 * The same binary serves a household's private server and the public demo, and
 * the sentence "there is no company behind it and no support desk" is exactly
 * right on the first and a falsehood on the second — demo.pathayam.app is
 * operated by a named company that is the Data Fiduciary for whatever reaches
 * it. A page that averaged the two would be wrong for both, and being wrong on
 * a published privacy policy is not the kind of wrong that stays cosmetic.
 *
 * So these are the claims each deployment is allowed to make, and the ones it
 * must not. They are also what keeps these pages in step with
 * `website/privacy.html` and `website/terms.html`, which cover the same ground
 * for the public site: if the substance moves there and not here, one of these
 * fails.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderPrivacy, renderTerms } from "./pages/legal.ts";

const updated = "17 September 2026";

/*
 * Collapsed to single spaces before matching. These are assertions about what
 * the prose says, and prose gets rewrapped; without this, reflowing a
 * paragraph fails a test that has nothing to do with the change.
 */
function flat(value: string): string {
  return value.replace(/\s+/g, " ");
}
function privacy(mode: "self-hosted" | "demo"): string {
  return flat(renderPrivacy({ appName: "Pathayam", updated, mode }).value);
}
function terms(mode: "self-hosted" | "demo"): string {
  return flat(renderTerms({ appName: "Pathayam", updated, mode }).value);
}

describe("the demo names who is responsible for it", () => {
  test("the privacy policy names the operator and the law it answers to", () => {
    const html = privacy("demo");
    assert.match(html, /Flaxvin Technologies/, "nobody is named as responsible");
    assert.match(
      html,
      /Digital Personal Data Protection Act, 2023/,
      "the Act that makes somebody the Data Fiduciary goes unmentioned",
    );
    assert.match(html, /privacy@pathayam\.app/, "there is no address to complain to");
  });

  test("it does not tell a visitor that nobody is behind it", () => {
    const html = privacy("demo");
    assert.doesNotMatch(
      html,
      /no operating company|no company behind it|no support desk/i,
      "the demo is operated by a company, so this is a false statement on a public page",
    );
    assert.doesNotMatch(
      html,
      /stays on the server you run/i,
      "on the demo the data is on somebody else's server",
    );
  });

  test("it warns that the instance is public, shared and disposable", () => {
    const html = privacy("demo");
    assert.match(html, /shared and public/i, "a visitor is not told others can see this");
    assert.match(html, /resets/i, "a visitor is not told it is wiped");
    assert.match(html, /real PAN/i, "the one thing never to type here is not named");
  });

  test("the terms carry a jurisdiction and a contact, because there is a counterparty", () => {
    const html = terms("demo");
    assert.match(html, /Flaxvin Technologies/, "the terms are between you and nobody");
    assert.match(html, /Kochi, Kerala/, "no forum is named");
    assert.match(html, /support@pathayam\.app/, "no way to reach the operator");
  });
});

describe("the contact addresses survive the CDN in front of them", () => {
  /*
   * Cloudflare's email obfuscation rewrites anything that looks like an address
   * into a /cdn-cgi/l/email-protection link reading "[email protected]". On the
   * page that has to say where a grievance goes, that means it no longer says.
   * `<!--email_off-->` is Cloudflare's documented opt-out, and it has to wrap
   * every address or the one it misses is the one that disappears.
   */
  for (const [label, page] of [
    ["privacy", privacy("demo")],
    ["terms", terms("demo")],
  ] as const) {
    test(`${label}: every mailto is inside an email_off marker`, () => {
      const unwrapped = page
        .split("<!--email_off-->")
        .map((chunk, i) => (i === 0 ? chunk : chunk.split("<!--/email_off-->")[1] ?? ""))
        .join("");
      assert.doesNotMatch(
        unwrapped,
        /mailto:/,
        "an address is exposed to the CDN rewrite and will render as [email protected]",
      );
    });
  }
});

describe("a self-hosted install does not claim somebody is running it", () => {
  test("the privacy policy puts the data and the responsibility on your own server", () => {
    const html = privacy("self-hosted");
    assert.match(html, /stays on the server you run/i, "it does not say where the data is");
    assert.match(
      html,
      /no outbound request|sends no telemetry/i,
      "it does not say the install phones nobody",
    );
  });

  test("it does not offer a grievance address for a service nobody is providing", () => {
    const html = privacy("self-hosted");
    assert.doesNotMatch(
      html,
      /privacy@pathayam\.app/,
      "a self-hoster's data never reaches that address, so pointing them at it is misdirection",
    );
  });

  test("the terms do not claim a jurisdiction over somebody running their own copy", () => {
    const html = terms("self-hosted");
    assert.doesNotMatch(html, /exclusive jurisdiction/i, "there is no contract to have a forum");
    assert.match(html, /provides no service with it/i, "it does not disclaim operating anything");
  });
});

describe("what both deployments have to say", () => {
  for (const mode of ["self-hosted", "demo"] as const) {
    test(`${mode}: the Limited Use disclosure Google requires is present, verbatim`, () => {
      // Without this exact sentence the restricted gmail.readonly scope is
      // refused at verification, whoever is running the app.
      assert.match(
        privacy(mode),
        /adhere to the[\s\S]*Google API Services User Data Policy[\s\S]*including the Limited Use requirements/,
        "the disclosure has been reworded, and verification will fail",
      );
    });

    test(`${mode}: the statement identity promise is stated`, () => {
      assert.match(
        privacy(mode),
        /excluded from every export/i,
        "the promise that an export cannot leak a PAN is missing",
      );
    });

    test(`${mode}: the licence that governs the code is named`, () => {
      assert.match(
        terms(mode),
        /PolyForm Noncommercial License 1\.0\.0/,
        "the terms do not say what licence the software is under",
      );
      assert.match(terms(mode), /Commercial use is not permitted/i, "the restriction is unstated");
    });

    test(`${mode}: the figures are disclaimed as arithmetic, not advice`, () => {
      assert.match(terms(mode), /none of it is financial, tax or investment advice/i);
    });
  }
});
