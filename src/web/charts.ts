/**
 * S15 · Server-rendered SVG charts.
 *
 * Charts are inline SVG, themed by the same CSS custom properties as the rest
 * of the app (`--chart-1..8`, `--accent`, `--danger`, `--positive`, `--border`,
 * `--text-*`). No client library, no canvas, no external request — which is
 * what R35.4's CSP requires and what the zero-dependency rule (B1) prefers.
 *
 * Every chart follows A2: it is decoration over numbers that are also present
 * as text (a legend or the table beside it), and carries a `role="img"` with a
 * human `<title>` so a screen reader gets the summary, never a wall of
 * `<path>`. Colours come from CSS variables so a chart repaints with the theme
 * and never hardcodes a hue that fails contrast on the other one.
 */

import { html, raw, escape, type SafeHtml } from "../http/html.ts";
import { formatPaise, formatCompact, type Paise } from "../core/money.ts";

/** Round to keep the SVG markup small; sub-pixel precision buys nothing. */
const r2 = (n: number): number => Math.round(n * 100) / 100;

const CHART_VARS = [
  "--chart-1", "--chart-2", "--chart-3", "--chart-4",
  "--chart-5", "--chart-6", "--chart-7", "--chart-8",
] as const;

/** The colour for series `i`, cycling through the eight-colour palette. */
export function seriesColor(i: number): string {
  return `var(${CHART_VARS[i % CHART_VARS.length]})`;
}

export interface Slice {
  label: string;
  value: Paise;
  /** A CSS colour (e.g. `var(--chart-1)`); defaults to the palette by order. */
  color?: string;
}

function polar(cx: number, cy: number, radius: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)];
}

/** An annular sector (donut slice) path from `startDeg` to `endDeg`. */
function sectorPath(
  cx: number, cy: number, rOuter: number, rInner: number,
  startDeg: number, endDeg: number,
): string {
  const [x1, y1] = polar(cx, cy, rOuter, startDeg);
  const [x2, y2] = polar(cx, cy, rOuter, endDeg);
  const [x3, y3] = polar(cx, cy, rInner, endDeg);
  const [x4, y4] = polar(cx, cy, rInner, startDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return (
    `M${r2(x1)} ${r2(y1)} A${rOuter} ${rOuter} 0 ${large} 1 ${r2(x2)} ${r2(y2)} ` +
    `L${r2(x3)} ${r2(y3)} A${rInner} ${rInner} 0 ${large} 0 ${r2(x4)} ${r2(y4)} Z`
  );
}

/**
 * A donut chart with a legend. Zero and negative slices are dropped; a single
 * remaining slice is drawn as a full ring (arcs degenerate at 360°).
 */
export function donutChart(opts: {
  title: string;
  slices: Slice[];
  /** Shown in the hole; defaults to the total. */
  centerLabel?: string;
  centerSub?: string;
  size?: number;
}): SafeHtml {
  const size = opts.size ?? 200;
  const cx = size / 2, cy = size / 2;
  const rOuter = size / 2 - 2;
  const rInner = rOuter * 0.62;

  const slices = opts.slices
    .map((s, i) => ({ ...s, color: s.color ?? seriesColor(i) }))
    .filter((s) => s.value > 0);
  const total = slices.reduce((sum, s) => sum + s.value, 0);

  const body: string[] = [];
  if (total === 0) {
    body.push(
      `<circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="none" ` +
        `stroke="var(--border)" stroke-width="${r2(rOuter - rInner)}"/>`,
    );
  } else if (slices.length === 1) {
    const w = r2(rOuter - rInner);
    body.push(
      `<circle cx="${cx}" cy="${cy}" r="${r2((rOuter + rInner) / 2)}" fill="none" ` +
        `stroke="${escape(slices[0]!.color)}" stroke-width="${w}"/>`,
    );
  } else {
    let acc = 0;
    for (const s of slices) {
      const start = (acc / total) * 360;
      acc += s.value;
      const end = (acc / total) * 360;
      body.push(
        `<path d="${sectorPath(cx, cy, rOuter, rInner, start, Math.min(end, 359.999))}" ` +
          `fill="${escape(s.color)}"><title>${escape(s.label)}: ${escape(formatPaise(s.value))}</title></path>`,
      );
    }
  }

  const center = opts.centerLabel ?? formatCompact(total as Paise);
  body.push(
    `<text x="${cx}" y="${cy - (opts.centerSub ? 2 : -4)}" text-anchor="middle" ` +
      `font-size="${r2(size * 0.13)}" font-weight="700" fill="var(--text)">${escape(center)}</text>`,
  );
  if (opts.centerSub) {
    body.push(
      `<text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="${r2(size * 0.075)}" ` +
        `fill="var(--text-muted)">${escape(opts.centerSub)}</text>`,
    );
  }

  const svg =
    `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" ` +
    `aria-label="${escape(opts.title)}" style="max-width:100%;height:auto">` +
    `<title>${escape(opts.title)}</title>${body.join("")}</svg>`;

  return html`
    <div class="chart-donut">
      ${raw(svg)}
      <ul class="chart-legend">
        ${slices.map(
          (s) => html`
            <li>
              <span class="chart-swatch" style="background:${raw(escape(s.color))}"></span>
              <span class="chart-legend-label">${s.label}</span>
              <span class="chart-legend-value">
                ${formatPaise(s.value)}
                <span class="faint">${total > 0 ? `${Math.round((s.value / total) * 100)}%` : ""}</span>
              </span>
            </li>
          `,
        )}
      </ul>
    </div>
  `;
}

/**
 * Paired vertical bars per group — income vs spending, month by month. Each
 * group holds one bar per series; a zero baseline runs across the bottom.
 */
export function groupedBarChart(opts: {
  title: string;
  groups: { label: string; values: Paise[] }[];
  series: { label: string; color: string }[];
}): SafeHtml {
  const W = 640, H = 240, padL = 8, padR = 8, padT = 12, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const groups = opts.groups;
  const peak = Math.max(1, ...groups.flatMap((g) => g.values));
  const nSeries = opts.series.length;
  const groupW = plotW / Math.max(1, groups.length);
  const barGap = 3;
  const barW = Math.max(2, (groupW - barGap * (nSeries + 1)) / nSeries);
  const y0 = padT + plotH;

  const bars: string[] = [];
  const labels: string[] = [];
  groups.forEach((g, gi) => {
    const gx = padL + gi * groupW;
    g.values.forEach((v, si) => {
      const h = r2((Math.max(0, v) / peak) * plotH);
      const x = r2(gx + barGap + si * (barW + barGap));
      bars.push(
        `<rect x="${x}" y="${r2(y0 - h)}" width="${r2(barW)}" height="${h}" rx="2" ` +
          `fill="${escape(opts.series[si]!.color)}">` +
          `<title>${escape(g.label)} · ${escape(opts.series[si]!.label)}: ${escape(formatPaise(v))}</title></rect>`,
      );
    });
    // Label every group if few, else every other, to avoid overlap.
    if (groups.length <= 12 || gi % 2 === 0) {
      labels.push(
        `<text x="${r2(gx + groupW / 2)}" y="${H - 8}" text-anchor="middle" ` +
          `font-size="11" fill="var(--text-muted)">${escape(g.label)}</text>`,
      );
    }
  });

  const svg =
    `<svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" role="img" ` +
    `aria-label="${escape(opts.title)}" preserveAspectRatio="none" style="max-width:100%">` +
    `<title>${escape(opts.title)}</title>` +
    `<line x1="${padL}" y1="${y0}" x2="${W - padR}" y2="${y0}" stroke="var(--border)" stroke-width="1"/>` +
    bars.join("") + labels.join("") +
    `</svg>`;

  return html`
    <div class="chart-wide">
      ${raw(svg)}
      <ul class="chart-legend chart-legend-inline">
        ${opts.series.map(
          (s) => html`
            <li><span class="chart-swatch" style="background:${raw(escape(s.color))}"></span>${s.label}</li>
          `,
        )}
      </ul>
    </div>
  `;
}

export interface LineSeries {
  label: string;
  color: string;
  /** y-values aligned with `xLabels`; nulls break the line. */
  points: (number | null)[];
  fill?: boolean;
}

/**
 * A line/area chart over a shared x-axis. Used for net-worth history and a
 * loan's declining balance. y is scaled from 0 (or the min, if negative) to
 * the peak across all series.
 */
export function lineChart(opts: {
  title: string;
  xLabels: string[];
  series: LineSeries[];
  /**
   * Anchor the y-axis at zero (default). Turn off for a series that never
   * approaches zero — net worth, say — so its variation is visible instead of
   * squashed against the top; the axis then spans the data with a little
   * padding. Keep it on when zero is meaningful (a balance falling to nil, a
   * net figure that crosses into the negative).
   */
  zeroBaseline?: boolean;
}): SafeHtml {
  const W = 640, H = 240, padL = 8, padR = 8, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = opts.xLabels.length;
  const all = opts.series.flatMap((s) => s.points.filter((p): p is number => p !== null));
  const zeroBaseline = opts.zeroBaseline ?? true;
  let hi: number, lo: number;
  if (zeroBaseline) {
    hi = Math.max(1, ...all);
    lo = Math.min(0, ...all);
  } else {
    // Span the data itself, not zero — that is the whole point of this branch.
    const dataHi = all.length ? Math.max(...all) : 1;
    const dataLo = all.length ? Math.min(...all) : 0;
    const pad = (dataHi - dataLo) * 0.08 || Math.abs(dataHi) * 0.08 || 1;
    hi = dataHi + pad;
    lo = dataLo - pad;
  }
  const span = hi - lo || 1;
  const xAt = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = (v: number) => padT + plotH - ((v - lo) / span) * plotH;
  const zeroY = yAt(0);
  // Where a filled area drops to: the zero line if it's on-screen, else the
  // plot floor (so an all-positive auto-scaled series fills to the bottom, not
  // to an off-screen zero).
  const fillBase = Math.max(padT, Math.min(padT + plotH, zeroY));

  const parts: string[] = [];
  // A faint zero baseline when the range dips below zero (loans, net drawdown).
  if (lo < 0) {
    parts.push(
      `<line x1="${padL}" y1="${r2(zeroY)}" x2="${W - padR}" y2="${r2(zeroY)}" ` +
        `stroke="var(--border)" stroke-dasharray="3 3"/>`,
    );
  }
  for (const s of opts.series) {
    const pts: [number, number][] = [];
    s.points.forEach((p, i) => { if (p !== null) pts.push([xAt(i), yAt(p)]); });
    if (pts.length === 0) continue;
    const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${r2(x)} ${r2(y)}`).join(" ");
    if (s.fill) {
      const area =
        `M${r2(pts[0]![0])} ${r2(fillBase)} ` +
        pts.map(([x, y]) => `L${r2(x)} ${r2(y)}`).join(" ") +
        ` L${r2(pts[pts.length - 1]![0])} ${r2(fillBase)} Z`;
      parts.push(`<path d="${area}" fill="${escape(s.color)}" opacity="0.14"/>`);
    }
    parts.push(
      `<path d="${line}" fill="none" stroke="${escape(s.color)}" stroke-width="2.5" ` +
        `stroke-linejoin="round" stroke-linecap="round"/>`,
    );
    // End-point dot.
    const [ex, ey] = pts[pts.length - 1]!;
    parts.push(`<circle cx="${r2(ex)}" cy="${r2(ey)}" r="3.5" fill="${escape(s.color)}"/>`);
  }

  // A few x labels (first, middle, last) to avoid crowding.
  const labelIdx = n <= 6
    ? opts.xLabels.map((_, i) => i)
    : [0, Math.floor((n - 1) / 2), n - 1];
  const labels = labelIdx.map((i) =>
    `<text x="${r2(xAt(i))}" y="${H - 8}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}" ` +
      `font-size="11" fill="var(--text-muted)">${escape(opts.xLabels[i]!)}</text>`,
  );

  const svg =
    `<svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" role="img" ` +
    `aria-label="${escape(opts.title)}" style="max-width:100%">` +
    `<title>${escape(opts.title)}</title>${parts.join("")}${labels.join("")}</svg>`;

  const showLegend = opts.series.length > 1;
  return html`
    <div class="chart-wide">
      ${raw(svg)}
      ${when(showLegend, () => html`
        <ul class="chart-legend chart-legend-inline">
          ${opts.series.map(
            (s) => html`<li><span class="chart-swatch" style="background:${raw(escape(s.color))}"></span>${s.label}</li>`,
          )}
        </ul>
      `)}
    </div>
  `;
}

/**
 * A radial progress ring — a percentage as an arc. Clamped to 0–100 for the
 * sweep; the caption can still say "reached" past the target.
 */
export function progressRing(opts: {
  percent: number;
  title: string;
  center?: string;
  size?: number;
  color?: string;
}): SafeHtml {
  const size = opts.size ?? 88;
  const stroke = size * 0.12;
  const r = (size - stroke) / 2;
  const cx = size / 2, cy = size / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, opts.percent));
  const dash = (pct / 100) * c;
  const color = opts.color ?? "var(--accent)";
  const center = opts.center ?? `${Math.round(opts.percent)}%`;
  const svg =
    `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" ` +
    `aria-label="${escape(opts.title)}" style="flex:0 0 auto">` +
    `<title>${escape(opts.title)}</title>` +
    `<circle cx="${cx}" cy="${cy}" r="${r2(r)}" fill="none" stroke="var(--chart-grid)" stroke-width="${r2(stroke)}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r2(r)}" fill="none" stroke="${escape(color)}" ` +
    `stroke-width="${r2(stroke)}" stroke-linecap="round" ` +
    `stroke-dasharray="${r2(dash)} ${r2(c - dash)}" stroke-dashoffset="0" ` +
    `transform="rotate(-90 ${cx} ${cy})"/>` +
    `<text x="${cx}" y="${cy + size * 0.055}" text-anchor="middle" font-size="${r2(size * 0.24)}" ` +
    `font-weight="700" fill="var(--text)">${escape(center)}</text>` +
    `</svg>`;
  return raw(svg);
}

/**
 * Horizontal bars — a ranked list where the label matters as much as the size
 * (subscriptions by annual cost, spending by category). Bars scale to the
 * largest value; each row shows its own figure.
 */
export function horizontalBars(opts: {
  title: string;
  items: { label: string; value: Paise; color?: string }[];
}): SafeHtml {
  const peak = Math.max(1, ...opts.items.map((i) => i.value));
  return html`
    <div class="chart-hbars" role="img" aria-label="${opts.title}">
      ${opts.items.map(
        (it, i) => html`
          <div class="chart-hbar">
            <span class="chart-hbar-label">${it.label}</span>
            <span class="chart-hbar-track">
              <span class="chart-hbar-fill"
                    style="width:${((it.value / peak) * 100).toFixed(1)}%;background:${raw(escape(it.color ?? seriesColor(i)))}"></span>
            </span>
            <span class="chart-hbar-value">${formatPaise(it.value)}</span>
          </div>
        `,
      )}
    </div>
  `;
}

/**
 * A sparkline — a tiny, axis-free trend line for inline use (next to an account
 * balance, a category name). Scales to its own min/max; a flat series draws a
 * flat line rather than dividing by zero.
 */
export function sparkline(opts: {
  points: number[];
  width?: number;
  height?: number;
  color?: string;
  title?: string;
}): SafeHtml {
  const w = opts.width ?? 96;
  const h = opts.height ?? 26;
  const pad = 2;
  const pts = opts.points;
  if (pts.length < 2) return raw("");
  const hi = Math.max(...pts), lo = Math.min(...pts);
  const span = hi - lo || 1;
  const xAt = (i: number) => pad + (i / (pts.length - 1)) * (w - 2 * pad);
  const yAt = (v: number) => pad + (h - 2 * pad) - ((v - lo) / span) * (h - 2 * pad);
  const d = pts.map((v, i) => `${i === 0 ? "M" : "L"}${r2(xAt(i))} ${r2(yAt(v))}`).join(" ");
  const [ex, ey] = [xAt(pts.length - 1), yAt(pts[pts.length - 1]!)];
  const color = opts.color ?? "var(--accent)";
  return raw(
    `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" ` +
    `aria-label="${escape(opts.title ?? "trend")}" style="vertical-align:middle">` +
    (opts.title ? `<title>${escape(opts.title)}</title>` : "") +
    `<path d="${d}" fill="none" stroke="${escape(color)}" stroke-width="1.5" ` +
    `stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${r2(ex)}" cy="${r2(ey)}" r="2" fill="${escape(color)}"/></svg>`,
  );
}

export interface WaterfallStep {
  label: string;
  /** Signed contribution to the running total. */
  value: Paise;
}

/**
 * A waterfall — a running total built from signed steps, each bar floating from
 * where the last one left off, with an opening and closing bar anchored to the
 * axis. Made for the net-worth change (money saved / market / FX), where the
 * point is exactly *which* movements built the total.
 */
export function waterfall(opts: {
  title: string;
  opening: Paise;
  openingLabel: string;
  steps: WaterfallStep[];
  closingLabel: string;
  /**
   * Draw the opening value as its own anchored bar. Off for a *change*
   * waterfall (opening 0), where a huge opening bar would dwarf the steps —
   * then only the steps and their total are drawn, and the y-axis spans the
   * change, so each component is legible.
   */
  includeOpening?: boolean;
}): SafeHtml {
  const W = 640, H = 260, padL = 8, padR = 8, padT = 16, padB = 44;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const includeOpening = opts.includeOpening ?? true;

  // Build the bars: opening (anchored, optional), each step (floating), closing.
  let running = opts.opening;
  const runs: number[] = [opts.opening];
  for (const s of opts.steps) { running += s.value; runs.push(running); }
  const closing = running;

  const values = [opts.opening, ...runs, closing];
  const hi = Math.max(0, ...values);
  const lo = Math.min(0, ...values);
  const span = hi - lo || 1;
  const yAt = (v: number) => padT + plotH - ((v - lo) / span) * plotH;

  const bars: { label: string; from: number; to: number; kind: "anchor" | "up" | "down" }[] = [];
  if (includeOpening) bars.push({ label: opts.openingLabel, from: 0, to: opts.opening, kind: "anchor" });
  for (let i = 0; i < opts.steps.length; i++) {
    const s = opts.steps[i]!;
    bars.push({ label: s.label, from: runs[i]!, to: runs[i + 1]!, kind: s.value >= 0 ? "up" : "down" });
  }
  bars.push({ label: opts.closingLabel, from: 0, to: closing, kind: "anchor" });

  const n = bars.length;
  const slot = plotW / n;
  const barW = Math.min(64, slot * 0.6);
  const color = (k: string) => k === "anchor" ? "var(--accent)" : k === "up" ? "var(--positive)" : "var(--danger)";

  const parts: string[] = [];
  parts.push(`<line x1="${padL}" y1="${r2(yAt(0))}" x2="${W - padR}" y2="${r2(yAt(0))}" stroke="var(--border)"/>`);
  bars.forEach((b, i) => {
    const cx = padL + slot * (i + 0.5);
    const x = cx - barW / 2;
    const y1 = yAt(b.from), y2 = yAt(b.to);
    const top = Math.min(y1, y2), height = Math.max(1, Math.abs(y2 - y1));
    parts.push(
      `<rect x="${r2(x)}" y="${r2(top)}" width="${r2(barW)}" height="${r2(height)}" rx="2" ` +
      `fill="${color(b.kind)}"><title>${escape(b.label)}: ${escape(formatPaise((b.to - b.from) as Paise))}</title></rect>`,
    );
    // connector line to the next bar's start
    if (i < n - 1) {
      parts.push(`<line x1="${r2(x + barW)}" y1="${r2(y2)}" x2="${r2(padL + slot * (i + 1.5) - barW / 2)}" y2="${r2(y2)}" stroke="var(--border)" stroke-dasharray="2 2"/>`);
    }
    // label (two lines: name, amount)
    const label = b.label.length > 12 ? b.label.slice(0, 11) + "…" : b.label;
    parts.push(`<text x="${r2(cx)}" y="${H - 26}" text-anchor="middle" font-size="10.5" fill="var(--text-muted)">${escape(label)}</text>`);
    parts.push(`<text x="${r2(cx)}" y="${H - 12}" text-anchor="middle" font-size="10.5" fill="var(--text)">${escape(formatCompact(b.to as Paise))}</text>`);
  });

  const svg =
    `<svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" role="img" ` +
    `aria-label="${escape(opts.title)}" style="max-width:100%"><title>${escape(opts.title)}</title>` +
    parts.join("") + `</svg>`;
  return html`<div class="chart-wide">${raw(svg)}</div>`;
}

// A tiny local `when` so this module needs no page import.
function when(cond: unknown, fn: () => SafeHtml): SafeHtml {
  return cond ? fn() : raw("");
}
