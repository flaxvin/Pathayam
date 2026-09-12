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
  /** The path used to mark the current nav item. */
  path?: string;
  reviewCount?: number;
  notice?: { kind: "error" | "success" | "info" | "warning"; message: string } | null;
  /** Chrome is omitted on the sign-in and first-run screens. */
  bare?: boolean;
  features?: { loans: boolean; assets: boolean };
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
    title, theme, path = "/", impersonating, devMode, notice, bare,
    reviewCount = 0, memberName, features = { loans: true, assets: true },
  } = options;

  // "system" leaves the attribute off entirely so the CSS `prefers-color-scheme`
  // block governs, with no storage and no JavaScript involved (R39.4).
  const themeAttr = theme === "system" ? "" : ` data-theme="${escape(theme)}"`;

  return `<!doctype html>
<html lang="en-IN"${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escape(title)} · Budget</title>
<link rel="stylesheet" href="/assets/app.css?v=${ASSET_VERSION.css}">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="${theme === "dark" ? "#11141a" : "#f6f7f9"}">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
</head>
<body data-features="${[features.loans ? "loans" : "", features.assets ? "assets" : ""].filter(Boolean).join(" ")}">
${String(renderBanners(impersonating, devMode, path))}
${bare ? "" : String(renderHeader(theme, memberName))}
<a class="skip-link" href="#main">Skip to content</a>
${bare
    ? `<main id="main">${String(renderNotice(notice))}${content}</main>`
    : `<div class="with-sidebar">
${String(renderSidebar(path, reviewCount, features))}
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
  path: string,
): SafeHtml {
  return html`
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

function renderHeader(theme: Theme, memberName: string | null | undefined): SafeHtml {
  // R39.5: the toggle is in the header on every screen, never buried in
  // settings. It is a form post, so it works with no JavaScript at all.
  const next = theme === "dark" ? "light" : "dark";
  return html`
    <header class="app-header">
      <a class="brand" href="/">Budget</a>
      <span class="spacer"></span>
      <a class="button button-quiet button-small" href="/search" aria-label="Search" title="Search (/)">⌕</a>
      <form method="post" action="/settings/theme">
        <input type="hidden" name="theme" value="${next}">
        <input type="hidden" name="return_to" value="">
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

function renderSidebar(
  path: string,
  reviewCount: number,
  features: { loans: boolean; assets: boolean },
): SafeHtml {
  // F28.2: a disabled module disappears from navigation rather than appearing
  // greyed out.
  const secondary: NavItem[] = [
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

  return html`
    <nav class="sidebar" aria-label="Sections">
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
  name: "Budget",
  short_name: "Budget",
  description: "Envelope budgeting for one household.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#f6f7f9",
  theme_color: "#f6f7f9",
  orientation: "portrait-primary",
  icons: [
    { src: "/assets/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/assets/icon-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});
