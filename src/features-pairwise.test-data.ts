/**
 * PLAN-1 · A pairwise covering array over the FEATURE_* flags.
 *
 * Every combination of 19 flags is 2^19 = 524,288 deployments. A breakage that
 * needs two particular flags in two particular states shows up in any set of
 * rows where every pair of flags appears in all four on/off combinations, and
 * that takes about a dozen rows. Built greedily from a fixed seed, so the rows
 * are the same on every run and a failure names a row that can be re-run.
 *
 * Not a `.test.ts` file: plan-pairwise.test.ts imports it and checks its
 * coverage before using it.
 */

import { FEATURE_NAMES, type Features } from "./features.ts";

/** Mulberry32: small, seeded, and the same everywhere. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const key = (i: number, j: number, a: boolean, b: boolean) => `${i}:${j}:${a ? 1 : 0}${b ? 1 : 0}`;

/** Every (flag, flag, state, state) a row covers. */
export function pairsOf(row: boolean[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < row.length; i++) {
    for (let j = i + 1; j < row.length; j++) out.push(key(i, j, row[i]!, row[j]!));
  }
  return out;
}

export function allPairs(n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (const a of [false, true]) for (const b of [false, true]) out.add(key(i, j, a, b));
    }
  }
  return out;
}

export function pairwiseRows(n = FEATURE_NAMES.length, seed = 20261107): boolean[][] {
  const random = prng(seed);
  const uncovered = allPairs(n);
  const rows: boolean[][] = [];
  while (uncovered.size > 0) {
    let best: boolean[] = [];
    let bestGain = -1;
    for (let c = 0; c < 200; c++) {
      const candidate = Array.from({ length: n }, () => random() < 0.5);
      const gain = pairsOf(candidate).filter((p) => uncovered.has(p)).length;
      if (gain > bestGain) { best = candidate; bestGain = gain; }
    }
    rows.push(best);
    for (const p of pairsOf(best)) uncovered.delete(p);
  }
  return rows;
}

export function rowFeatures(row: boolean[]): Features {
  return Object.fromEntries(FEATURE_NAMES.map((name, i) => [name, row[i]!])) as Features;
}

/** A row named by the flags it turns off, so a failure reads as a configuration. */
export function rowName(row: boolean[]): string {
  const off = FEATURE_NAMES.filter((_, i) => !row[i]);
  return off.length === 0 ? "nothing off" : `off: ${off.join(", ")}`;
}
