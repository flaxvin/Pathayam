/**
 * PRINT-1 · Printable reports.
 *
 * docs/limitations.md said "No printing stylesheet", and printing any screen
 * gave you the sidebar, the sticky header, every button and — in the dark theme
 * — a page of toner. The tax estimate, the reports, the month close, the net
 * worth statement and a loan's schedule are the screens people take to paper,
 * so those now print as a document and offer a Print button.
 *
 * The full-fidelity check is a browser in print emulation, and
 * docs/screenshots/print-tax.png is one. What the suite holds is the rules
 * themselves, each one deletion away from coming back, and which pages carry the
 * button.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { STYLESHEET } from "./styles.ts";
import { CLIENT_SCRIPT } from "./client.ts";
import { page } from "./layout.ts";
import { raw } from "../http/html.ts";
import { execute } from "../db/db.ts";
import { formatDate, todayIST } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createLoan } from "../domain/loans.ts";
import { TAX_PRINT_CAVEAT } from "./pages/tax.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

/** The body of the one print block, so a rule elsewhere cannot satisfy a test. */
function printBlock(): string {
  const start = STYLESHEET.indexOf("@media print {");
  assert.ok(start >= 0, "there is a print stylesheet");
  let depth = 0;
  for (let i = start; i < STYLESHEET.length; i++) {
    if (STYLESHEET[i] === "{") depth++;
    if (STYLESHEET[i] === "}" && --depth === 0) return STYLESHEET.slice(start, i + 1);
  }
  throw new Error("the print block never closes");
}

describe("PRINT-1 · the print stylesheet", () => {
  const print = printBlock();

  test("hides the navigation, header, banners, digest, toasts and every control", () => {
    const bare = print.replace(/\/\*[^]*?\*\//g, "");
    const hidden = /([^{}]+)\{\s*display: none !important;\s*\}/.exec(bare);
    assert.ok(hidden, "one rule takes the screen furniture off the page");
    const selectors = hidden![1]!.split(",").map((s) => s.trim());
    for (const wanted of [
      ".banner", ".app-header", ".sidebar", ".bottom-nav", ".digest", ".no-print",
      'main > .notice[role="status"]', "button", ".button", "form:not(.print-keep)",
    ]) {
      assert.ok(selectors.includes(wanted), `${wanted} must not print`);
    }
  });

  test("forces light colours whatever the theme, including an explicit dark one", () => {
    assert.match(print, /:root, :root\[data-theme\], :root:not\(\[data-theme\]\) \{[^}]*color-scheme: light;/);
    assert.match(print, /:root\[data-theme\][^{]*\{[^}]*--bg:\s*#ffffff;[^}]*--text:\s*#000000;/);
    assert.match(print, /html, body \{ background: #fff !important; color: #000; \}/);
    // It has to come after the dark blocks, or they win on equal specificity.
    assert.ok(
      STYLESHEET.indexOf("@media print {") > STYLESHEET.lastIndexOf(':root[data-theme="dark"] {'),
      "the print tokens must follow the dark theme's",
    );
  });

  test("keeps rows and short cards whole, and repeats table headers on each page", () => {
    assert.match(print, /thead \{ display: table-header-group; \}/);
    assert.match(print, /\.card:not\(:has\(table\)\)[^{]*\btr\b[^{]*\{\s*break-inside: avoid;/);
    assert.match(print, /h1, h2, h3[^{]*\{ break-after: avoid;/);
  });

  test("lets a scrolling table print in full", () => {
    // The loan schedule scrolls in a 24rem box on screen, set inline.
    assert.match(print, /\.table-scroll \{ overflow: visible !important; max-height: none !important;/);
  });

  test("keeps chart colours, because two black series are one", () => {
    assert.match(print, /svg, \.chart-swatch[^{]*\{[^}]*print-color-adjust: exact;/);
    assert.match(print, /--chart-1: #2f6db0;/);
  });

  test("prints a link's address only for links that leave the app", () => {
    assert.match(print, /main a\[href\^="http"\]::after \{\s*content: " \(" attr\(href\) "\)";/);
    assert.doesNotMatch(print, /\ba\[href\]::after|\ba::after/, "not after every nav link");
  });

  test("shows the footer on paper and nowhere else", () => {
    assert.match(STYLESHEET, /^\.print-footer \{ display: none; \}$/m);
    assert.match(print, /\.print-footer \{\s*display: block;/);
  });

  test("numbers the pages", () => {
    assert.match(STYLESHEET, /@page \{[^]*@bottom-right \{[^}]*counter\(page\)/);
  });

  test("a hidden Print button stays hidden despite the button display rule", () => {
    assert.match(STYLESHEET, /\.print-button\[hidden\] \{ display: none; \}/);
  });
});

describe("PRINT-1 · the button is progressive enhancement, inside the CSP", () => {
  test("rendered hidden, with no inline handler", () => {
    const html = page({ title: "Tax estimate", theme: "system", print: {} }, raw("<h1>x</h1>"));
    const button = /<button[^>]*data-print[^>]*>/.exec(html)?.[0] ?? "";
    assert.ok(button, "a printable page carries the button");
    assert.match(button, /\bhidden\b/, "no script, no button");
    assert.match(button, /type="button"/);
    assert.doesNotMatch(button, /\son\w+=/, "the CSP forbids inline handlers");
  });

  test("the client script reveals it, after a swap too, and calls window.print", () => {
    assert.match(CLIENT_SCRIPT, /function revealPrintButtons\(root\)/);
    assert.match(CLIENT_SCRIPT, /function initialiseContent\(root\) \{[^}]*\}\);[^]*?revealPrintButtons\(root\);/);
    assert.match(CLIENT_SCRIPT, /closest\("\[data-print\]"\)[^]*?window\.print\(\)/);
  });

  test("collapsed readings are opened for the print and closed after", () => {
    assert.match(CLIENT_SCRIPT, /addEventListener\("beforeprint"/);
    assert.match(CLIENT_SCRIPT, /addEventListener\("afterprint"/);
  });

  test("a bare page has neither button nor footer", () => {
    const html = page({ title: "Sign in", theme: "system", bare: true, print: {} }, raw("<p>x</p>"));
    assert.doesNotMatch(html, /data-print/);
    assert.doesNotMatch(html, /print-footer/);
  });
});

describe("PRINT-1 · which pages offer it", () => {
  async function setup() {
    const db = freshDb();
    execute(db, `UPDATE household SET name = ? WHERE id = 1`, "The Kurup household");
    const ravi = seedMember(db, "m", "Ravi");
    const actor = { memberId: ravi, source: "ui" as const };
    const bank = createAccount(db, actor, {
      name: "Bank", kind: "budget", subtype: "savings",
      openingDate: "2025-01-01", openingBalance: rupees(5_00_000) as Paise,
    }).id;
    const loan = createLoan(db, actor, {
      lender: "Fictional Bank", loanType: "personal", sanctioned: rupees(2_00_000) as Paise,
      sanctionDate: "2025-01-01", interestModel: "reducing", annualRatePct: 11, tenureMonths: 36,
      currentOutstanding: rupees(2_00_000) as Paise, repaymentAccountId: bank,
    });
    const app = await startTestApp(db, { memberId: ravi });
    return { app, loan };
  }

  test("the six printable screens carry the button and a footer that says whose and when", async () => {
    const { app, loan } = await setup();
    try {
      const month = todayIST().slice(0, 7);
      for (const [path, title] of [
        ["/tax", "Tax estimate"],
        ["/reports", "Reports"],
        ["/months", "Month closes"],
        [`/months/${month}/close`, "Closing "],
        ["/net-worth", "Net worth"],
        [`/loans/${loan.id}`, "Fictional Bank"],
      ] as const) {
        const res = await app.get(path);
        assert.equal(res.status, 200, path);
        const body = await res.text();
        assert.match(body, /<button[^>]*data-print/, `${path} offers Print`);
        const footer = /<footer class="print-footer">([^]*?)<\/footer>/.exec(body)?.[1] ?? "";
        assert.match(footer, /The Kurup household ·/, `${path}: whose`);
        assert.ok(footer.includes(title), `${path}: which screen`);
        assert.ok(footer.includes(`generated\n        ${formatDate(todayIST())} (IST)`), `${path}: when, DD-MM-YYYY`);
      }
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("only the tax estimate's footer carries the estimate caveat", async () => {
    const { app } = await setup();
    try {
      const tax = await (await app.get("/tax")).text();
      assert.match(TAX_PRINT_CAVEAT, /^An estimate, not a return/);
      assert.ok(tax.includes(`<p class="print-caveat">${TAX_PRINT_CAVEAT}</p>`));
      assert.doesNotMatch(await (await app.get("/net-worth")).text(), /print-caveat/);
    } finally {
      await app.close();
    }
  });

  test("screens that are not reports do not offer it", async () => {
    const { app, loan } = await setup();
    try {
      for (const path of ["/", "/accounts", "/add", "/loans", "/loans/new", `/loans/${loan.id}/pay`, "/settings", "/categories"]) {
        const res = await app.get(path);
        assert.equal(res.status, 200, path);
        assert.doesNotMatch(await res.text(), /data-print/, `${path} should not offer Print`);
      }
    } finally {
      await app.close();
    }
  });
});
