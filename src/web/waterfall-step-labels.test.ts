/**
 * DEBUG-ASSETS-3 · A waterfall step is labelled with its own amount.
 *
 * Every bar's caption printed the running total it ended at. On the net
 * worth change — ₹50,000 saved, then ₹20,000 lost to the market — the red
 * "Market movement" bar read "₹30K", the same figure as the net change beside
 * it, and nowhere on the chart did the loss appear.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { waterfall } from "./charts.ts";
import type { Paise } from "../core/money.ts";

const p = (n: number): Paise => n as Paise;

/** The amount line under each bar: the second of each pair of captions. */
const captions = (svg: string): string[] =>
  [...svg.matchAll(/<text[^>]*fill="var\(--text\)">([^<]*)<\/text>/g)].map((m) => m[1]!);

test("a falling step reads as the fall, and the closing bar as the total", () => {
  const svg = waterfall({
    title: "Change", opening: p(0), openingLabel: "", includeOpening: false,
    steps: [{ label: "Money saved", value: p(5_000_000) }, { label: "Market movement", value: p(-2_000_000) }],
    closingLabel: "Net change",
  }).value;
  assert.deepEqual(captions(svg), ["₹50K", "-₹20K", "₹30K"]);
});

test("with an opening bar, the opening reads as itself", () => {
  const svg = waterfall({
    title: "Worth", opening: p(10_000_000), openingLabel: "Start",
    steps: [{ label: "Saved", value: p(1_000_000) }],
    closingLabel: "End",
  }).value;
  assert.deepEqual(captions(svg), ["₹1L", "₹10K", "₹1.1L"]);
});
