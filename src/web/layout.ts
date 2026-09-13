/**
 * The page shell.
 *
 * R39.3: the resolved theme is rendered into the initial HTML as an attribute
 * on `<html>`, so the correct theme paints on the first frame. That is the
 * entire reason this is a server-rendered value and not a script — a script
 * runs after the first paint, which is a flash of the wrong theme.
 *
 * F21.2: no service worker is registered. There is no exception (R35.1).
 */

import { createHash } from "node:crypto";
import { html, raw, escape, when, type SafeHtml } from "../http/html.ts";
import { CLIENT_SCRIPT } from "./client.ts";
import { STYLESHEET } from "./styles.ts";
import { ICON_BACKGROUND, APP_LOGO_SVG } from "./icon.ts";

/**
 * Content-hash the client assets so their URLs change when they change. Without
 * this, `/assets/app.js` was cached for an hour (R35 permits caching *code*),
 * so a fix to the client script could not reach a browser that had loaded the
 * page in the last hour — a stale app.js is exactly how a client-side bug
 * "survives" a deploy. The hash makes the fresh HTML request the new file.
 */
const ASSET_VERSION = {
  js: createHash("sha256").update(CLIENT_SCRIPT).digest("hex").slice(0, 10),
  css: createHash("sha256").update(STYLESHEET).digest("hex").slice(0, 10),
};

export type Theme = "light" | "dark" | "system";

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  badge?: number;
}

export interface LayoutOptions {
  title: string;
  /** The member's stored preference (R39.2). */
  theme: Theme;
  memberName?: string | null;
  /** R38.7: shown on every screen while active, and not dismissible. */
  impersonating?: { name: string; readOnly: boolean } | null;
  /** R38.4: distinct from impersonation, impossible to confuse with production. */
  devMode?: boolean;
  /** A public demonstration instance: fictional data, and it says so. */
  demoMode?: boolean;
  /** The path used to mark the current nav item. */
  path?: string;
  reviewCount?: number;
  notice?: { kind: "error" | "success" | "info" | "warning"; message: string } | null;
  /** Chrome is omitted on the sign-in and first-run screens. */
  bare?: boolean;
  /**
   * 15 · The budgets this member may look at, and which they are looking at.
   *
   * In the chrome rather than on the budget screen, because the screens that
   * show one budget's money are not only the budget screen: Categories, the
   * household page and the month close all do. Having to go back to the grid to
   * change budget and then forward again is the same three-taps problem the Add
   * button fixed.
   */
  budgets?: { id: string; name: string; kind: string }[];
  currentBudgetId?: string | null;
  features?: {
    loans: boolean;
    assets: boolean;
    /**
     * 15 · Whether anybody in the household keeps a separate budget. The
     * household screen only means something once one does, and F28.2 says a
     * module nobody uses leaves the navigation rather than sitting there greyed.
     */
    separateBudgets?: boolean;
  };
}

const PRIMARY_NAV: NavItem[] = [
  { href: "/", label: "Budget", icon: "◧" },
  { href: "/accounts", label: "Accounts", icon: "▤" },
  { href: "/add", label: "Add", icon: "＋" },
  { href: "/review", label: "Review", icon: "◍" },
  { href: "/more", label: "More", icon: "⋯" },
];

export function page(options: LayoutOptions, content: SafeHtml): string {
  const {
    title, theme, path = "/", impersonating, devMode, demoMode, notice, bare,
    reviewCount = 0, memberName, features = { loans: true, assets: true },
    budgets = [], currentBudgetId = null,
  } = options;

  // "system" leaves the attribute off entirely so the CSS `prefers-color-scheme`
  // block governs, with no storage and no JavaScript involved (R39.4).
  const themeAttr = theme === "system" ? "" : ` data-theme="${escape(theme)}"`;

  return `<!doctype html>
<html lang="en-IN"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escape(title)} · Pathayam</title>
<link rel="stylesheet" href="/assets/app.css?v=${ASSET_VERSION.css}">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="${theme === "dark" ? "#11141a" : ICON_BACKGROUND}">
<!--
  F21.1 · An SVG for the browsers that take one, PNGs for the ones that do not,
  and the small mark at the two sizes where the full one turns to mush. iOS
  ignores every one of these and takes apple-touch-icon, so that is here too;
  without it a home-screen tile is a screenshot of the page.
-->
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="icon" href="/assets/favicon-32.png" sizes="32x32" type="image/png">
<link rel="icon" href="/assets/favicon-16.png" sizes="16x16" type="image/png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Pathayam">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
</head>
<body data-features="${[features.loans ? "loans" : "", features.assets ? "assets" : ""].filter(Boolean).join(" ")}">
${String(renderBanners(impersonating, devMode, demoMode, path))}
${bare ? "" : String(renderHeader(theme, memberName, budgets, currentBudgetId, path))}
<a class="skip-link" href="#main">Skip to content</a>
${bare
    ? `<main id="main">${String(renderNotice(notice))}${content}</main>`
    : `<div class="with-sidebar">
${String(renderSidebar(path, reviewCount, features, budgets, currentBudgetId))}
<main id="main">${String(renderNotice(notice))}${content}</main>
</div>
${String(renderBottomNav(path, reviewCount))}`}
<script src="/assets/app.js?v=${ASSET_VERSION.js}" defer></script>
</body>
</html>`;
}

function renderBanners(
  impersonating: LayoutOptions["impersonating"],
  devMode: boolean | undefined,
  demoMode: boolean | undefined,
  path: string,
): SafeHtml {
  return html`
    ${when(
      demoMode,
      () => html`
        <div class="banner banner-demo" role="status">
          <span>
            Demo — every figure, name and account here is invented, and the data
            resets periodically. Nothing you do affects anything real.
          </span>
        </div>
      `,
    )}
    ${when(
      devMode,
      () => html`
        <div class="banner banner-dev" role="alert">
          <span>⚠ Development login is enabled — authentication is bypassed on this machine.</span>
        </div>
      `,
    )}
    ${when(
      impersonating,
      () => html`
        <div class="banner banner-impersonation" role="alert">
          <span>Viewing as ${impersonating!.name}${impersonating!.readOnly ? " — read only" : " — writes enabled"}</span>
          <!-- B51: R38.10's write toggle shipped as POST /impersonate/writes but
               had no control; read-only impersonation could never be lifted. -->
          <form method="post" action="/impersonate/writes" style="display:inline">
            <input type="hidden" name="allow" value="${impersonating!.readOnly ? "1" : "0"}">
            <input type="hidden" name="return_to" value="${escape(path)}">
            <button class="button-small" type="submit">
              ${impersonating!.readOnly ? "Enable writes" : "Back to read-only"}
            </button>
          </form>
          <form method="post" action="/impersonate/exit" style="display:inline">
            <button class="button-small" type="submit">Exit</button>
          </form>
        </div>
      `,
    )}
  `;
}

function renderHeader(
  theme: Theme,
  memberName: string | null | undefined,
  budgets: { id: string; name: string; kind: string }[],
  currentBudgetId: string | null,
  path: string,
): SafeHtml {
  // R39.5: the toggle is in the header on every screen, never buried in
  // settings. It is a form post, so it works with no JavaScript at all.
  const next = theme === "dark" ? "light" : "dark";
  return html`
    <header class="app-header">
      <!--
        Inline rather than an <img>, because the mark is drawn in currentColor
        and an image cannot inherit one: it is the logo taking the page's colour,
        not a tile pasted into the header.
      -->
      <a class="brand" href="/">
        ${raw(APP_LOGO_SVG.replace("<svg", '<svg class="brand-mark" width="24" height="24"'))}
        <!--
          The wordmark steps aside on a narrow screen. The header carries the
          budget switcher, and at 375px the two of them together clipped it
          mid-name — "Household" and "Ra" — so the control that says *whose money
          you are looking at* was unreadable. The mark still says whose app it is.
        -->
        <span class="brand-word">Pathayam</span>
      </a>
      <!--
        15 · The switcher lived only in the sidebar, and the sidebar is a desktop
        affordance — so on a phone there was no way to move between the household
        and your own budget at all. Every screen that means "one budget's money"
        showed one budget's money and offered no way to say which.

        Here it is in the header, which is on every screen at every width, and
        hidden on desktop where the sidebar already carries it.
      -->
      ${when(budgets.length > 1 && honoursBudget(path), () => html`
        <nav class="budget-switch" aria-label="Which budget">
          ${budgets.map(
            (b) => html`
              <a href="${path || "/"}?budget=${encodeURIComponent(b.id)}"
                 ${raw(b.id === currentBudgetId ? 'aria-current="true"' : "")}>
                <!--
                  A2 · A word and a mark, never colour alone — the same ● and ○
                  the sidebar uses. It also tells these apart from the member
                  link at the other end of the header, which on a phone is the
                  same name twice: one meaning "whose money" and one meaning
                  "who you are".
                -->
                <span aria-hidden="true">${b.id === currentBudgetId ? "●" : "○"}</span>
                ${b.kind === "household" ? "Household" : b.name}
                ${when(b.id === currentBudgetId, () => html`<span class="sr-only">(selected)</span>`)}
              </a>
            `,
          )}
        </nav>
      `)}
      <span class="spacer"></span>
      <!--
        Adding a transaction is the one thing a household does every day, and it
        was three taps away on a desktop: the bottom bar that carries it is a
        phone affordance. Here it is — on desktop only, because on a phone the
        bottom bar already has it, and two Add buttons on one screen is one
        button's worth of header room the budget switcher needs.
      -->
      <a class="button button-primary button-small header-add" href="/add"
         title="Add a transaction (a)">
        <span aria-hidden="true">＋</span> Add
      </a>
      <form method="post" action="/settings/theme">
        <input type="hidden" name="theme" value="${next}">
        <!--
          B117 · This was empty, so changing the theme sent you to the budget
          screen from wherever you were — and the browser, given no cache
          directive on the page, often answered that redirect from its own cache
          and showed the old theme. Between the two, the control looked like it
          did nothing until the next link click.
        -->
        <input type="hidden" name="return_to" value="${path || "/"}">
        <button class="button-quiet button-small" type="submit"
                aria-label="Switch to ${next} theme" title="Switch to ${next} theme">
          ${theme === "dark" ? "☀" : "☾"}
        </button>
      </form>
      ${when(
        memberName,
        () => html`<a class="button button-quiet button-small" href="/settings">${memberName}</a>`,
      )}
    </header>
  `;
}

function renderNotice(notice: LayoutOptions["notice"]): SafeHtml {
  if (!notice) return raw("");
  return html`<div class="notice notice-${notice.kind}" role="status">${notice.message}</div>`;
}

function isCurrent(path: string, href: string): boolean {
  return href === "/" ? path === "/" : path.startsWith(href);
}

function renderBottomNav(path: string, reviewCount: number): SafeHtml {
  return html`
    <nav class="bottom-nav" aria-label="Primary">
      ${PRIMARY_NAV.map(
        (item) => html`
          <a href="${item.href}" ${raw(isCurrent(path, item.href) ? 'aria-current="page"' : "")}>
            <span class="nav-icon" aria-hidden="true">${item.icon}</span>
            <span>${item.label}</span>
            ${when(
              item.href === "/review" && reviewCount > 0,
              () => html`<span class="sr-only">, ${reviewCount} items</span>`,
            )}
          </a>
        `,
      )}
    </nav>
  `;
}

/**
 * 15 · The screens that mean "one budget's money", and so honour the switcher.
 *
 * Everything else — the household page, Activity, Settings, Review, the portfolio
 * — is either about the arrangement as a whole or about things that belong to no
 * budget. Offering a switch there did nothing at all: the link carried `?budget=`,
 * the page ignored it, and the highlight stayed where it was. A control that does
 * not move when clicked reads as a frozen app, which is exactly how it was
 * reported.
 *
 * Reports and Query are deliberately absent too. They ask *whose money* as a
 * filter of their own (`16`), and a second control saying something adjacent would
 * be two answers to one question.
 */
const BUDGET_SCOPED = ["/", "/categories", "/overview", "/cards", "/schedules", "/accounts", "/goals", "/months"];

function honoursBudget(path: string): boolean {
  return BUDGET_SCOPED.some((p) => (p === "/" ? path === "/" : path.startsWith(p)));
}

function renderSidebar(
  path: string,
  reviewCount: number,
  features: { loans: boolean; assets: boolean; separateBudgets?: boolean },
  budgets: { id: string; name: string; kind: string }[] = [],
  currentBudgetId: string | null = null,
): SafeHtml {
  // F28.2: a disabled module disappears from navigation rather than appearing
  // greyed out.
  const secondary: NavItem[] = [
    ...(features.separateBudgets
      ? [{ href: "/household", label: "Household", icon: "⌂" }]
      : []),
    { href: "/overview", label: "Overview", icon: "◱" },
    { href: "/cards", label: "Cards", icon: "▭" },
    { href: "/reports", label: "Reports", icon: "▦" },
    { href: "/query", label: "Query", icon: "⌗" },
    { href: "/schedules", label: "Schedules", icon: "◷" },
    { href: "/goals", label: "Goals", icon: "◎" },
    ...(features.loans ? [{ href: "/loans", label: "Loans", icon: "▽" }] : []),
    ...(features.assets
      ? [
          { href: "/portfolio", label: "Portfolio", icon: "△" },
          { href: "/net-worth", label: "Net worth", icon: "◈" },
        ]
      : []),
  ];

  const link = (item: NavItem) => html`
    <a href="${item.href}" ${raw(isCurrent(path, item.href) ? 'aria-current="page"' : "")}>
      <span class="nav-icon" aria-hidden="true">${item.icon}</span>
      <span>${item.label}</span>
      ${when(
        item.href === "/review" && reviewCount > 0,
        () => html`<span class="chip chip-warning" style="margin-left:auto">${reviewCount}</span>`,
      )}
    </a>
  `;

  /*
   * Staying on the page you are on: switching budget from Categories should show
   * the other budget's categories, not send you to the grid.
   */
  const switchTo = (id: string) => `${path || "/"}?budget=${encodeURIComponent(id)}`;

  /*
   * One <nav>, not two: `.with-sidebar` is a two-column grid, and a second
   * top-level child would become a third column and push the content out of the
   * layout on every screen.
   */
  return html`
    <nav class="sidebar" aria-label="Sections">
      ${when(budgets.length > 1 && honoursBudget(path), () => html`
        <div class="group-label">Looking at</div>
        ${budgets.map(
          (b) => html`
            <a href="${switchTo(b.id)}"
               ${raw(b.id === currentBudgetId ? 'aria-current="true"' : "")}>
              <!-- A2 · A word and a mark, never colour alone. -->
              <span class="nav-icon" aria-hidden="true">${b.id === currentBudgetId ? "●" : "○"}</span>
              <span>${b.kind === "household" ? "Household" : b.name}</span>
              ${when(b.id === currentBudgetId, () => html`<span class="sr-only">(selected)</span>`)}
            </a>
          `,
        )}
        <div class="group-label">Budget</div>
      `)}
      ${PRIMARY_NAV.filter((i) => i.href !== "/add").map(link)}
      <div class="group-label">Analyse</div>
      ${secondary.map(link)}
      <div class="group-label">Manage</div>
      ${[
        { href: "/payees", label: "Payees", icon: "☖" },
        { href: "/rules", label: "Rules", icon: "⚙" },
        { href: "/import", label: "Import", icon: "⇪" },
        { href: "/activity", label: "Activity", icon: "↺" },
        { href: "/health", label: "Health", icon: "♡" },
        { href: "/settings", label: "Settings", icon: "⚒" },
      ].map(link)}
    </nav>
  `;
}

/**
 * F21.1: a manifest with name, icons at 192 and 512, start_url and display is
 * sufficient for installability. F21.3 covers the install instructions, since
 * under R35 there is no programmatic prompt on either platform.
 */
export const MANIFEST = JSON.stringify({
  name: "Pathayam",
  short_name: "Pathayam",
  description: "Envelope budgeting for one household.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  // The warm ground the light theme paints, so the splash screen is the app's
  // own colour rather than a white flash before it.
  background_color: ICON_BACKGROUND,
  theme_color: ICON_BACKGROUND,
  orientation: "portrait-primary",
  icons: [
    { src: "/assets/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/assets/icon-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});
