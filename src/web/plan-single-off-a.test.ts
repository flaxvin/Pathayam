/**
 * PLAN-1 · Each module switched off on its own, first half.
 *
 * Somebody setting one FEATURE_* by hand gets exactly this, and a breakage
 * found here names its flag. Split across two files so the walks run in
 * parallel; plan-single-off-b.test.ts takes the rest of the same list, so
 * the two together are every flag.
 */

import { ALL_FEATURES_ON, FEATURE_NAMES, type Features } from "../features.ts";
import { planSuite } from "./plan-crawl.test-data.ts";

const FIRST_HALF = FEATURE_NAMES.slice(0, Math.ceil(FEATURE_NAMES.length / 2));

planSuite("PLAN-1 · one module off (a)", FIRST_HALF.map(
  (name) => [`${name} off`, { ...ALL_FEATURES_ON, [name]: false }] as [string, Features],
));
