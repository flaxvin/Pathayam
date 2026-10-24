/**
 * The release this build is. Reported by /healthz and the Health screen.
 *
 * A constant rather than a read of package.json at start-up: the runtime image
 * need not carry package.json, and version.test.ts keeps the two in step.
 */
export const VERSION = "1.0.0";
