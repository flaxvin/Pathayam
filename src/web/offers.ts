/**
 * PLAN-1 · Whether a page may link somewhere, under this deployment's modules.
 *
 * A renderer that names another module's page asks this first, so a module
 * that is switched off is never a dead link or a form that answers 404. The
 * features are optional on every renderer that takes them: omitted is a
 * self-hosted install, where everything is on — which is what every test
 * written before plans existed was asserting.
 */

import { pathAvailable, PLAN_PRESETS, type Features } from "../features.ts";

export function offers(features: Features | undefined, href: string): boolean {
  return pathAvailable(href, features ?? PLAN_PRESETS.selfhost.features);
}
