/**
 * PLAN-1 · Every real deployment shape, walked end to end.
 *
 * The four presets a hosted or self-hosted instance actually runs as, plus the
 * two extremes: every module on, and every module off (the budget alone). Each
 * walks every page against three years of a household that used every module,
 * so a module switched off still has its data underneath — the downgrade case.
 * See plan-crawl.test-data.ts for what counts as broken.
 */

import { PLAN_PRESETS, PLANS, ALL_FEATURES_ON, ALL_FEATURES_OFF, type Features } from "../features.ts";
import { planSuite } from "./plan-crawl.test-data.ts";

planSuite("PLAN-1 · presets and extremes", [
  ...PLANS.map((plan) => [`PLAN=${plan}`, PLAN_PRESETS[plan].features] as [string, Features]),
  ["every module on", ALL_FEATURES_ON],
  ["every module off", ALL_FEATURES_OFF],
]);
