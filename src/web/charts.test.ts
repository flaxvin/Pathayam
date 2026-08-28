/**
 * S15 · The SVG charts render valid markup for the awkward inputs — an empty
 * series, a single 100% slice (where donut arcs degenerate at 360°), a series
 * that crosses zero, one that never approaches it. The maths is the risk here,
 * not the wiring, so the assertions are about the coordinates and structure.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { donutChart, groupedBarChart, lineChart, progressRing, horizontalBars, seriesColor } from "./charts.ts";
import type { Paise } from "../core/money.ts";

const p = (n: number): Paise => n as Paise;

describe("S15 · charts", () => {
  test("a donut with several slices draws one path each and a legend", () => {
    const svg = donutChart({
      title: "Allocation",
      slices: [
        { label: "Equity", value: p(600000) },
        { label: "Debt", value: p(300000) },
        { label: "Gold", value: p(100000) },
      ],
    }).value;
    assert.equal((svg.match(/<path /g) ?? []).length, 3, "one path per slice");
    assert.match(svg, /Equity/);
    assert.match(svg, /33%|10%|60%/); // legend percentages of the total
    assert.doesNotMatch(svg, /NaN|undefined/);
  });

  test("a single slice becomes a full ring, not a broken arc", () => {
    const svg = donutChart({ title: "All one", slices: [{ label: "Only", value: p(500000) }] }).value;
    // A 360° sector path degenerates; the single-slice case uses a circle.
    assert.match(svg, /<circle/);
    assert.doesNotMatch(svg, /NaN/);
  });

  test("an empty donut renders a neutral ring and no NaN", () => {
    const svg = donutChart({ title: "Nothing", slices: [] }).value;
    assert.match(svg, /<circle/);
    assert.doesNotMatch(svg, /NaN|undefined/);
    // Zero-value slices are dropped entirely.
    const withZeros = donutChart({
      title: "Zeros", slices: [{ label: "A", value: p(0) }, { label: "B", value: p(0) }],
    }).value;
    assert.doesNotMatch(withZeros, /NaN/);
  });

  test("grouped bars scale to the peak and label each series", () => {
    const svg = groupedBarChart({
      title: "In vs out",
      groups: [
        { label: "Jan", values: [p(100000), p(50000)] },
        { label: "Feb", values: [p(0), p(200000)] },
      ],
      series: [{ label: "In", color: "var(--positive)" }, { label: "Out", color: "var(--danger)" }],
    }).value;
    assert.match(svg, /<rect/);
    assert.doesNotMatch(svg, /NaN|height="-/); // no negative bar heights
    assert.match(svg, /In/);
    assert.match(svg, /Out/);
  });

  test("a zero-baseline line shows a dashed axis when the data crosses zero", () => {
    const svg = lineChart({
      title: "Net",
      xLabels: ["Jan", "Feb", "Mar"],
      series: [{ label: "Net", color: "var(--accent)", points: [-5000, 2000, 8000], fill: true }],
    }).value;
    assert.match(svg, /stroke-dasharray/, "a zero baseline is drawn when values dip below zero");
    assert.doesNotMatch(svg, /NaN/);
  });

  test("an auto-baseline line spans the data, not zero, and fills on-screen", () => {
    // Two large, close values: on a zero baseline they'd both pin to the top.
    const svg = lineChart({
      title: "Net worth",
      xLabels: ["Aug", "Sep"],
      zeroBaseline: false,
      series: [{ label: "NW", color: "var(--accent)", points: [7082000, 7137403], fill: true }],
    }).value;
    // The stroke line is the two-point path `M8 y1 L632 y2` (the area path,
    // by contrast, starts `M8 <base> L8 …`). Its two y's must differ clearly —
    // on a zero baseline these near-equal large values would both pin to the top.
    const line = /M8 ([\d.]+) L632 ([\d.]+)"/.exec(svg);
    assert.ok(line, "a two-point line path is present");
    const y1 = Number(line![1]), y2 = Number(line![2]);
    assert.ok(Math.abs(y1 - y2) > 80, `points should be well separated, got ${y1} and ${y2}`);
    assert.doesNotMatch(svg, /NaN/);
  });

  test("a progress ring sweeps the arc and clamps out-of-range percentages", () => {
    const half = progressRing({ percent: 50, title: "Halfway" }).value;
    assert.match(half, /stroke-dasharray/);
    assert.doesNotMatch(half, /NaN/);
    // Over 100% must not produce a dash longer than the circumference (a
    // negative gap) — the sweep is clamped even when the caption isn't.
    const over = progressRing({ percent: 130, title: "Past target" }).value;
    const dash = /stroke-dasharray="([\d.]+) (-?[\d.]+)"/.exec(over);
    assert.ok(dash, "a dasharray is present");
    assert.ok(Number(dash![2]) >= 0, "the gap is never negative");
  });

  test("horizontal bars scale to the largest and never exceed 100%", () => {
    const svg = horizontalBars({
      title: "Subscriptions",
      items: [
        { label: "Netflix", value: p(7788) },
        { label: "Spotify", value: p(1189) },
      ],
    }).value;
    const widths = [...svg.matchAll(/width:([\d.]+)%/g)].map((m) => Number(m[1]));
    assert.ok(widths.length >= 2);
    assert.ok(Math.max(...widths) <= 100.01, "no bar overflows its track");
    assert.equal(Math.max(...widths), 100, "the largest fills the track");
  });

  test("seriesColor cycles through the palette", () => {
    assert.equal(seriesColor(0), "var(--chart-1)");
    assert.equal(seriesColor(8), "var(--chart-1)"); // wraps
    assert.notEqual(seriesColor(0), seriesColor(1));
  });
});
