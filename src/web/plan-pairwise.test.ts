/**
 * PLAN-1 · Every pair of modules, in every on/off combination, walked.
 *
 * The covering array is checked before it is used: if it ever stopped covering
 * a pair (a flag added, the generator changed), this fails on that rather than
 * passing with a hole in it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { FEATURE_NAMES } from "../features.ts";
import { pairwiseRows, pairsOf, allPairs, rowFeatures, rowName } from "../features-pairwise.test-data.ts";
import { planSuite } from "./plan-crawl.test-data.ts";

const rows = pairwiseRows();

test("PLAN-1 · the covering array covers every pair of flags in all four states", () => {
  const covered = new Set(rows.flatMap(pairsOf));
  const missing = [...allPairs(FEATURE_NAMES.length)].filter((p) => !covered.has(p));
  assert.deepEqual(missing, []);
  // A covering array the size of the whole space would be correct and useless.
  assert.ok(rows.length <= 16, `${rows.length} rows`);
});

planSuite("PLAN-1 · pairwise", rows.map((row) => [rowName(row), rowFeatures(row)]));
