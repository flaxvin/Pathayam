/**
 * The stylesheet, served as one static asset.
 *
 * R39.7: every colour is a token with a light and a dark value. Nothing is
 * hard-coded, because dark mode is where red-on-dark contrast quietly fails
 * (R39.6). Both themes are checked against WCAG 2.1 AA (A3).
 *
 * A2 is a standing constraint here: colour is never the only signal for a
 * funded or overspent state, so every state colour is paired with an icon or a
 * text label in the markup.
 */

export const STYLESHEET = `
/* ---------------------------------------------------------------------------
   Tokens
   --------------------------------------------------------------------------- */
:root {
  color-scheme: light;

  --bg:            #f6f7f9;
  --surface:       #ffffff;
  --surface-2:     #eef0f4;
  --border:        #d6dae1;
  --border-strong: #b3bac5;

  --text:          #14181f;      /* 15.8:1 on --surface */
  --text-muted:    #545c6b;      /*  7.1:1 on --surface */
  --text-faint:    #6b7382;      /*  4.9:1 on --surface */

  --accent:        #1f5fa9;
  --accent-text:   #ffffff;
  --accent-soft:   #e4edf8;

  /* State colours. Each is AA against its own surface. */
  --positive:      #1a6b3c;
  --positive-bg:   #e3f3e9;
  --warning:       #8a5a00;
  --warning-bg:    #fdf0d5;
  --danger:        #ab2020;
  --danger-bg:     #fbe6e6;
  --info-bg:       #e8eefc;

  /* Categorical chart series — distinct, AA-legible on --surface. */
  --chart-1: #2f6db0;
  --chart-2: #2f9e6f;
  --chart-3: #c9700f;
  --chart-4: #9b3fb5;
  --chart-5: #c0324c;
  --chart-6: #0f8b8d;
  --chart-7: #8a6d1f;
  --chart-8: #5a6b7a;
  --chart-grid: #e5e8ee;

  --focus:         #1f5fa9;
  --shadow:        0 1px 2px rgba(15, 20, 30, .08), 0 4px 12px rgba(15, 20, 30, .06);

  --radius:        10px;
  --radius-sm:     6px;
  --tap:           44px;         /* A1: minimum interactive target */
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}

@media (prefers-color-scheme: dark) {
  /* R39.4: "follow system" needs no storage and no JavaScript. */
  :root:not([data-theme]) { color-scheme: dark; }
  :root:not([data-theme]) {
    --bg:            #11141a;
    --surface:       #1a1e26;
    --surface-2:     #232833;
    --border:        #333b49;
    --border-strong: #4a5464;

    --text:          #eef1f6;
    --text-muted:    #a8b1c0;
    --text-faint:    #8b94a3;

    --accent:        #6ba6f0;
    --accent-text:   #10141a;
    --accent-soft:   #1d2a3d;

    --positive:      #5fd08c;
    --positive-bg:   #14301f;
    --warning:       #f0b849;
    --warning-bg:    #33270d;
    --danger:        #ff8a8a;     /* lightened: #ab2020 fails AA on dark */
    --danger-bg:     #351717;
    --info-bg:       #17233a;

    --chart-1: #6ba6f0;
    --chart-2: #5fd08c;
    --chart-3: #f0a955;
    --chart-4: #c78be6;
    --chart-5: #ff8a8a;
    --chart-6: #4fd0d2;
    --chart-7: #d8c26a;
    --chart-8: #9aa8b8;
    --chart-grid: #2c333f;

    --focus:         #6ba6f0;
    --shadow:        0 1px 2px rgba(0,0,0,.4), 0 4px 12px rgba(0,0,0,.3);
  }
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --bg:            #11141a;
  --surface:       #1a1e26;
  --surface-2:     #232833;
  --border:        #333b49;
  --border-strong: #4a5464;
  --text:          #eef1f6;
  --text-muted:    #a8b1c0;
  --text-faint:    #8b94a3;
  --accent:        #6ba6f0;
  --accent-text:   #10141a;
  --accent-soft:   #1d2a3d;
  --positive:      #5fd08c;
  --positive-bg:   #14301f;
  --warning:       #f0b849;
  --warning-bg:    #33270d;
  --danger:        #ff8a8a;
  --danger-bg:     #351717;
  --info-bg:       #17233a;
  --chart-1: #6ba6f0;
  --chart-2: #5fd08c;
  --chart-3: #f0a955;
  --chart-4: #c78be6;
  --chart-5: #ff8a8a;
  --chart-6: #4fd0d2;
  --chart-7: #d8c26a;
  --chart-8: #9aa8b8;
  --chart-grid: #2c333f;
  --focus:         #6ba6f0;
  --shadow:        0 1px 2px rgba(0,0,0,.4), 0 4px 12px rgba(0,0,0,.3);
}

/* ---------------------------------------------------------------------------
   Base
   --------------------------------------------------------------------------- */
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  font-size: 16px;
  line-height: 1.5;
  -webkit-text-size-adjust: 100%;
  padding-bottom: env(safe-area-inset-bottom);
}

/* A6 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    transition-duration: .01ms !important;
    scroll-behavior: auto !important;
  }
}

:focus-visible {
  outline: 3px solid var(--focus);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

a { color: var(--accent); }
h1, h2, h3 { line-height: 1.25; margin: 0 0 .5rem; }
h1 { font-size: 1.5rem; }
h2 { font-size: 1.15rem; }
h3 { font-size: 1rem; }

.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

.skip-link {
  position: absolute; left: -9999px; top: 0; z-index: 100;
  background: var(--accent); color: var(--accent-text); padding: .75rem 1rem;
}
.skip-link:focus { left: 0; }

/* ---------------------------------------------------------------------------
   Banners — R38.4, R38.7, and §12 failure states
   --------------------------------------------------------------------------- */
.banner {
  padding: .6rem 1rem; font-weight: 600; font-size: .9rem;
  display: flex; gap: .75rem; align-items: center; justify-content: center;
  flex-wrap: wrap;
}
/* R38.7: never a subtle chip, never dismissible. */
.banner-impersonation { background: var(--danger); color: #fff; }
:root[data-theme="dark"] .banner-impersonation { background: #7d1414; color: #fff; }
/* R38.4: visually distinct from impersonation, impossible to confuse. */
.banner-dev { background: repeating-linear-gradient(45deg, #6b21a8, #6b21a8 12px, #581c87 12px, #581c87 24px); color: #fff; }
.banner-maintenance { background: var(--warning-bg); color: var(--warning); }
.banner a, .banner button { color: inherit; }

/* ---------------------------------------------------------------------------
   Layout
   --------------------------------------------------------------------------- */
.app-header {
  position: sticky; top: 0; z-index: 20;
  background: var(--surface); border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: .5rem; padding: .5rem 1rem;
}
.app-header .brand { font-weight: 700; letter-spacing: -.01em; text-decoration: none; color: var(--text); }
.app-header .spacer { flex: 1; }

main { padding: 1rem; max-width: 1200px; margin: 0 auto; }
@media (min-width: 900px) {
  .with-sidebar { display: grid; grid-template-columns: 220px 1fr; gap: 1.5rem; max-width: 1400px; margin: 0 auto; }
  /* B62: the auto margin above centres the single-column layout, but on a grid
     item an auto margin also makes the item shrink to its max-content width and
     sit centred in its track. That left the budget grid 836px wide inside a
     1156px column — and, because max-content differs per screen, a different
     width on every page. Reset it so main fills the track it was given. */
  .with-sidebar main { padding: 1.5rem 1.5rem 4rem; max-width: none; margin: 0; }
}

/* Desktop sidebar (03 §2) */
.sidebar { display: none; }
@media (min-width: 900px) {
  .sidebar {
    display: block; padding: 1rem .75rem; border-right: 1px solid var(--border);
    background: var(--surface); min-height: calc(100vh - 57px);
    position: sticky; top: 57px; align-self: start;
  }
  .sidebar a {
    display: flex; align-items: center; gap: .6rem; min-height: var(--tap);
    padding: 0 .75rem; border-radius: var(--radius-sm);
    color: var(--text); text-decoration: none; font-size: .95rem;
  }
  .sidebar a[aria-current="page"] { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
  .sidebar a:hover { background: var(--surface-2); }
  .sidebar .group-label {
    font-size: .72rem; text-transform: uppercase; letter-spacing: .06em;
    color: var(--text-faint); padding: 1rem .75rem .25rem;
  }
}

/* Mobile bottom bar — five items, Add prominent (03 §2) */
.bottom-nav {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 30;
  display: grid; grid-template-columns: repeat(5, 1fr);
  background: var(--surface); border-top: 1px solid var(--border);
  padding-bottom: env(safe-area-inset-bottom);
}
@media (min-width: 900px) { .bottom-nav { display: none; } }
body:has(.bottom-nav) main { padding-bottom: 5.5rem; }
.bottom-nav a {
  min-height: var(--tap); display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: .1rem;
  text-decoration: none; color: var(--text-muted); font-size: .68rem; padding: .35rem 0;
}
.bottom-nav a[aria-current="page"] { color: var(--accent); font-weight: 600; }
.bottom-nav .nav-icon { font-size: 1.15rem; line-height: 1; }
.bottom-nav .add a { color: var(--accent); }

/* ---------------------------------------------------------------------------
   Controls
   --------------------------------------------------------------------------- */
button, .button {
  font: inherit; font-weight: 600; cursor: pointer;
  min-height: var(--tap); padding: .5rem 1rem;
  border-radius: var(--radius-sm); border: 1px solid var(--border-strong);
  background: var(--surface); color: var(--text);
  display: inline-flex; align-items: center; justify-content: center; gap: .4rem;
  text-decoration: none;
}
button:hover, .button:hover { background: var(--surface-2); }
.button-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.button-primary:hover { filter: brightness(1.08); background: var(--accent); }
.button-danger { color: var(--danger); border-color: var(--danger); }
.button-quiet { border-color: transparent; background: transparent; }
.button-quiet:hover { background: var(--surface-2); }
.button-small { min-height: 34px; padding: .25rem .6rem; font-size: .85rem; }
button[disabled] { opacity: .55; cursor: not-allowed; }

input, select, textarea {
  font: inherit; color: var(--text); background: var(--surface);
  border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  padding: .5rem .65rem; min-height: var(--tap); width: 100%;
}
input[type="checkbox"], input[type="radio"] { width: auto; min-height: 0; accent-color: var(--accent); }
label { display: block; font-size: .85rem; font-weight: 600; color: var(--text-muted); margin-bottom: .25rem; }
.field { margin-bottom: .9rem; }
.field-hint { font-size: .8rem; color: var(--text-faint); margin-top: .25rem; font-weight: 400; }
fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: .9rem; margin: 0 0 1rem; }
legend { font-weight: 600; font-size: .9rem; padding: 0 .35rem; }

/* Amounts get the numeric keypad with a decimal (A7) via inputmode in markup. */
.amount-input { font-variant-numeric: tabular-nums; font-size: 1.25rem; }

/* A long read: the legal pages. Measure capped for readability, and headings
   given room so the document scans rather than runs together. */
.prose-page { max-width: 44rem; margin: 2rem auto; padding: 0 1rem; }
.prose-page h2 { margin-top: 2rem; }
.prose-page li { margin-bottom: .4rem; }
.prose-page code { word-break: break-all; }
.prose-page table { margin: 1rem 0; }

/* ---------------------------------------------------------------------------
   Cards, tables, chips
   --------------------------------------------------------------------------- */
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1rem; margin-bottom: 1rem;
}
.card-tight { padding: .75rem; }
.card h2 { margin-top: 0; }

.stack > * + * { margin-top: .75rem; }
.row { display: flex; gap: .75rem; align-items: center; }
.row-between { display: flex; gap: .75rem; align-items: center; justify-content: space-between; }
.grid-2 { display: grid; gap: .75rem; }
@media (min-width: 640px) { .grid-2 { grid-template-columns: 1fr 1fr; } }

table { width: 100%; border-collapse: collapse; font-size: .92rem; }
th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--border); }
th { font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.table-scroll { overflow-x: auto; }

.chip {
  display: inline-flex; align-items: center; gap: .3rem;
  font-size: .78rem; font-weight: 600; padding: .15rem .5rem;
  border-radius: 999px; background: var(--surface-2); color: var(--text-muted);
  white-space: nowrap;
}
.chip-positive { background: var(--positive-bg); color: var(--positive); }
.chip-warning  { background: var(--warning-bg);  color: var(--warning); }
.chip-danger   { background: var(--danger-bg);   color: var(--danger); }
.chip-info     { background: var(--info-bg);     color: var(--accent); }

.amount { font-variant-numeric: tabular-nums; }
.amount-positive { color: var(--positive); }
.amount-negative { color: var(--danger); }
.muted { color: var(--text-muted); }
.faint { color: var(--text-faint); font-size: .85rem; }

/* ---------------------------------------------------------------------------
   Budget screen (S1)
   --------------------------------------------------------------------------- */
/* F3.6: RTA visible at all times, on every viewport, without scrolling. */
.rta-bar {
  position: sticky; top: 57px; z-index: 15;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: .85rem 1rem; margin-bottom: 1rem;
  box-shadow: var(--shadow);
}
.rta-figure { font-size: 2rem; font-weight: 700; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.rta-positive .rta-figure { color: var(--warning); }
.rta-zero     .rta-figure { color: var(--positive); }
.rta-negative .rta-figure { color: var(--danger); }
.rta-label { font-size: .8rem; font-weight: 600; color: var(--text-muted); }
.rta-secondary { font-size: .85rem; margin-top: .35rem; }

.month-switch { display: flex; align-items: center; gap: .35rem; }
.month-switch .month-name { font-weight: 700; min-width: 9.5rem; text-align: center; }
.month-switch a { min-width: var(--tap); min-height: var(--tap); display: inline-flex; align-items: center; justify-content: center; text-decoration: none; border-radius: var(--radius-sm); }
.month-switch a:hover { background: var(--surface-2); }

.category-group { margin-bottom: 1rem; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; background: var(--surface); }
.category-group > summary {
  padding: .6rem 1rem; background: var(--surface-2); cursor: pointer;
  font-weight: 700; display: flex; align-items: center; gap: .6rem; min-height: var(--tap);
}
.category-group > summary::marker { color: var(--text-faint); }
.group-totals { margin-left: auto; display: flex; gap: 1rem; font-size: .82rem; font-weight: 600; color: var(--text-muted); }

.category-row {
  display: grid; gap: .25rem .75rem; padding: .6rem 1rem;
  border-top: 1px solid var(--border); align-items: center;
  grid-template-columns: 1fr auto;
}
@media (min-width: 760px) {
  .category-row { grid-template-columns: 1fr 7.5rem 7.5rem 8rem; }
}
.category-name { font-weight: 600; }
.category-name a { color: inherit; text-decoration: none; }
.category-name a:hover { text-decoration: underline; }
.category-meta { grid-column: 1 / -1; font-size: .8rem; color: var(--text-faint); display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
@media (min-width: 760px) { .category-meta { grid-column: 1; } }
.category-balance { font-weight: 700; text-align: right; font-variant-numeric: tabular-nums; }
.assign-cell input { min-height: 38px; text-align: right; font-variant-numeric: tabular-nums; }

/* A2: the bar is reinforced by a text label, never colour alone. */
.target-bar { height: 5px; border-radius: 3px; background: var(--surface-2); overflow: hidden; max-width: 9rem; }
.target-bar > span { display: block; height: 100%; background: var(--positive); }
.target-bar.partial > span { background: var(--warning); }
.target-bar.unfunded > span { background: var(--border-strong); }

.state-overspent { background: var(--danger-bg); }
.state-overspent .category-balance { color: var(--danger); }

/* ---------------------------------------------------------------------------
   Messages
   --------------------------------------------------------------------------- */
.notice { border-radius: var(--radius); padding: .75rem 1rem; margin-bottom: 1rem; border: 1px solid transparent; font-size: .92rem; }
.notice-error   { background: var(--danger-bg);  color: var(--danger);  border-color: var(--danger); }
.notice-success { background: var(--positive-bg); color: var(--positive); border-color: var(--positive); }
.notice-info    { background: var(--info-bg); border-color: var(--accent); color: var(--text); }
.notice-warning { background: var(--warning-bg); color: var(--warning); border-color: var(--warning); }

.empty-state { text-align: center; padding: 2.5rem 1rem; color: var(--text-muted); }
.empty-state h2 { color: var(--text); }
.empty-state .empty-icon { font-size: 2.5rem; margin-bottom: .5rem; }

/* ---------------------------------------------------------------------------
   Explain popover (F25.10)
   --------------------------------------------------------------------------- */
.explain-link { font-size: .75rem; color: var(--text-faint); text-decoration: none; border-bottom: 1px dotted currentColor; }
.explain-link:hover { color: var(--accent); }
.explain-list { list-style: none; padding: 0; margin: 0; }
.explain-list li { padding: .6rem 0; border-bottom: 1px solid var(--border); font-size: .9rem; }
.explain-list li:last-child { border-bottom: none; }
.explain-when { color: var(--text-faint); font-size: .8rem; }

dialog {
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface); color: var(--text); box-shadow: var(--shadow);
  padding: 1rem; max-width: min(560px, 94vw); width: 100%;
}
dialog::backdrop { background: rgba(0,0,0,.45); }

/* ---------------------------------------------------------------------------
   Charts (S15) — inline SVG, themed by --chart-* tokens
   --------------------------------------------------------------------------- */
.chart-donut { display: flex; align-items: center; gap: 1.25rem; flex-wrap: wrap; }
.chart-donut > svg { flex: 0 0 auto; }
.chart-wide { width: 100%; }
.chart-wide > svg { display: block; width: 100%; }

.chart-legend { list-style: none; margin: 0; padding: 0; min-width: 190px; flex: 1 1 190px; }
.chart-legend li {
  display: flex; align-items: baseline; gap: .5rem;
  padding: .3rem 0; border-bottom: 1px solid var(--border); font-size: .9rem;
}
.chart-legend li:last-child { border-bottom: none; }
.chart-legend-label { flex: 1 1 auto; color: var(--text); }
.chart-legend-value { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.chart-legend-value .faint { margin-left: .35rem; color: var(--text-faint); }

.chart-legend-inline {
  display: flex; flex-wrap: wrap; gap: .35rem 1rem;
  margin-top: .6rem; min-width: 0;
}
.chart-legend-inline li { border: none; padding: 0; font-size: .82rem; color: var(--text-muted); }

.chart-swatch {
  display: inline-block; width: 12px; height: 12px; border-radius: 3px;
  flex: 0 0 auto; vertical-align: middle; margin-right: .1rem;
}

.linkish {
  background: none; border: none; padding: 0; margin: 0; font: inherit;
  color: var(--accent); cursor: pointer; text-decoration: underline;
}
.linkish:hover { color: var(--text); }

.sparkline-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: .75rem 1rem; margin-top: .5rem; }
.sparkline-cell { display: flex; flex-direction: column; gap: .1rem; }
.sparkline-name { font-size: .8rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.chart-hbars { display: flex; flex-direction: column; gap: .5rem; }
.chart-hbar { display: grid; grid-template-columns: minmax(6rem, 34%) 1fr auto; align-items: center; gap: .6rem; }
.chart-hbar-label { font-size: .9rem; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chart-hbar-track { background: var(--chart-grid); border-radius: 4px; height: 12px; overflow: hidden; }
.chart-hbar-fill { display: block; height: 100%; border-radius: 4px; min-width: 2px; }
.chart-hbar-value { font-size: .85rem; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--text-muted); }

.goal-ring-row { display: flex; align-items: center; gap: 1rem; }

.insight-list { list-style: none; margin: .25rem 0 0; padding: 0; }
.insight { display: flex; gap: .6rem; padding: .55rem 0; border-top: 1px solid var(--border); font-size: .95rem; }
.insight:first-child { border-top: none; }
.insight-mark { flex: 0 0 1.1rem; text-align: center; font-size: .8rem; line-height: 1.5; }
.insight-up .insight-mark { color: var(--danger); }
.insight-down .insight-mark { color: var(--positive); }
.insight-new .insight-mark { color: var(--accent); }
.insight a { margin-left: .35rem; white-space: nowrap; }

/* Overview dashboard (S16) */
.overview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1rem; }
.overview-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; }
.overview-tile { display: flex; flex-direction: column; gap: .35rem; }
.overview-label { color: var(--text-muted); font-size: .85rem; text-transform: uppercase; letter-spacing: .03em; }
.overview-figure { font-size: 1.75rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.overview-list { list-style: none; margin: .25rem 0 0; padding: 0; }
.overview-list li { display: flex; gap: .6rem; align-items: baseline; padding: .45rem 0; border-top: 1px solid var(--border); font-size: .92rem; }
.overview-list li:first-child { border-top: none; }
.overview-date { flex: 0 0 3.2rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.overview-items { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.overview-list .amount { white-space: nowrap; }
`;
