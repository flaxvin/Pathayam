/** PLAN-1 · Each module switched off on its own, second half. See plan-single-off-a.test.ts. */

import { ALL_FEATURES_ON, FEATURE_NAMES, type Features } from "../features.ts";
import { planSuite } from "./plan-crawl.test-data.ts";

const SECOND_HALF = FEATURE_NAMES.slice(Math.ceil(FEATURE_NAMES.length / 2));

planSuite("PLAN-1 · one module off (b)", SECOND_HALF.map(
  (name) => [`${name} off`, { ...ALL_FEATURES_ON, [name]: false }] as [string, Features],
));
