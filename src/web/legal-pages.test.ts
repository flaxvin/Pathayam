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

const updated = "19 September 2026";

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

describe("Google access is described only where it exists", () => {
  /*
   * The demo is never configured with a Google project, and connecting a
   * mailbox is refused there rather than hidden, so a policy describing scopes
   * and Gmail ingestion would be telling a visitor the demo can reach their
   * email. It cannot.
   */
  test("the demo claims no Google sign-in and no mailbox access", () => {
    const html = privacy("demo");
    assert.doesNotMatch(html, /gmail\.readonly/, "a scope the demo never requests is listed");
    assert.doesNotMatch(
      html,
      /searches the mailbox/i,
      "the demo is described as reading a mailbox it cannot reach",
    );
    assert.match(html, /no access to any mailbox/i, "the demo does not say it cannot reach email");
    assert.match(
      html,
      /There is no account and no sign-in/i,
      "the demo claims an account identity it never collects",
    );
  });

  test("the demo does not claim to hold a statement identity it refuses to store", () => {
    assert.match(
      privacy("demo"),
      /refused here/i,
      "saving a statement identity is refused in demo mode, and the policy should say so",
    );
  });

  test("a self-hosted install carries the Limited Use disclosure, verbatim", () => {
    // Each self-hoster points their own Google project at their own instance's
    // /privacy, so this is the page Google reviews for the restricted
    // gmail.readonly scope. Without this exact sentence, verification fails.
    assert.match(
      privacy("self-hosted"),
      /adhere to the[\s\S]*Google API Services User Data Policy[\s\S]*including the Limited Use requirements/,
      "the disclosure has been reworded, and verification will fail",
    );
    assert.match(privacy("self-hosted"), /gmail\.readonly/, "the scopes table is gone");
  });
});

describe("the pages keep up with what the app does", () => {
  /*
   * These exist because the terms once said "It computes no tax liability"
   * after the app had started doing exactly that. A legal page that disclaims
   * something the software does is the worst kind of stale.
   */
  for (const mode of ["self-hosted", "demo"] as const) {
    test(`${mode}: the tax estimate is disclaimed where the advice clause is`, () => {
      const html = terms(mode);
      assert.match(html, /tax screen is an estimate/i, "the tax screen is not disclaimed");
      assert.doesNotMatch(
        html, /computes no tax/i,
        "a clause still says the app computes no tax, which it does",
      );
    });
  }

  test("self-hosted: the privacy policy accounts for the tax figures it stores", () => {
    const html = privacy("self-hosted");
    assert.match(html, /Tax figures/i, "income and deductions are held and not disclosed");
    assert.match(html, /per member and per financial year/i, "the per-person scoping is not stated");
  });

  test("self-hosted: a password is disclosed as something held", () => {
    assert.match(privacy("self-hosted"), /scrypt hash/i);
  });

  test("self-hosted: sign-in is not described as Google's alone", () => {
    const html = privacy("self-hosted");
    assert.match(html, /OpenID Connect/i, "OIDC sign-in is not mentioned");
    assert.match(html, /Three ways/i);
  });

  test("the demo says the injected analytics never runs", () => {
    /*
     * The network in front of the demo injects an analytics script and the CSP
     * blocks it. Saying nothing would leave a visitor who opens the console to
     * conclude the app is quietly measuring them.
     */
    const html = privacy("demo");
    assert.match(html, /No analytics runs here/i);
    assert.match(html, /blocked before it executes/i);
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
  test("the promise that an export cannot leak a PAN is stated", () => {
    assert.match(privacy("self-hosted"), /excluded from every export/i);
  });


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
