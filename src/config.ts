/**
 * Configuration, and the one safety gate that runs before anything else.
 *
 * R38.3 requires the application to **refuse to start** — not warn — if the
 * development login bypass is enabled anywhere that looks like production. A
 * warning in a log is a bypass nobody reads.
 */

import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  port: number;
  host: string;
  /** Public origin, used for OAuth redirects and cookie scoping. */
  baseUrl: string;
  dataDir: string;
  databasePath: string;
  backupDir: string;
  attachmentDir: string;
  environment: "development" | "production";
  logLevel: "debug" | "info" | "warn" | "error";
  google: { clientId: string | null; clientSecret: string | null };
  /** F1.7 · Any OpenID Connect provider, so Google is not the only one. */
  oidc: { issuer: string | null; clientId: string | null; clientSecret: string | null; label: string };
  /** R38.1: dev-only sign-in as any seeded member, off by default. */
  devLogin: boolean;
  /**
   * R38.6a · "View as another member", off unless explicitly enabled.
   *
   * It was built for a household where one person sets things up for another,
   * and it is a poor fit for one where the two keep their money separate: a
   * personal budget that a partner can step into is not a separate budget. So
   * it is now an operator tool — for support on a hosted instance, and for
   * reproducing a bug locally — rather than a household feature.
   */
  adminDebug: boolean;
  /**
   * A public demonstration instance: anyone who can reach it may enter and click
   * around. Off by default, and every guard below is a no-op when it is off, so
   * a private household deployment behaves exactly as it did before this
   * existed.
   *
   * This is *not* the development bypass. That one exists to skip Google on a
   * laptop and refuses to run anywhere production-shaped; this one is meant to
   * run on a public hostname, and its protection is that the data is invented.
   */
  demoMode: boolean;
  sessionDays: number;
  /** F28: modules disableable per deployment. */
  features: { loans: boolean; assets: boolean; multiCurrency: boolean };
  /** R40.4: where a failed backup or restore verification reports to. */
  backupWebhookUrl: string | null;
  /**
   * R40.8: an external monitor pinged on a *successful* verified restore. It
   * alerts on the absence of a ping, which is the only way the deployment
   * being down can raise an alarm — no process here survives to send one.
   */
  heartbeatUrl: string | null;
  /**
   * `07` §6.4 · Alpha Vantage, for direct equities.
   *
   * Q16 makes this optional: the portfolio is mostly mutual funds, MFAPI needs
   * no key, and P9 requires the app to work with every provider disabled. An
   * absent key is a normal configuration, not a misconfiguration.
   */
  alphaVantageKey: string | null;
  /** Set behind a reverse proxy that terminates TLS. */
  trustProxy: boolean;
  /** F1.6 · Offer password sign-in, so Google is not the only door. */
  localLogin: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * The database is `pathayam.sqlite`, but an install that predates the rename
 * has a `budget.sqlite` sitting next to it. Preferring the old file when it is
 * the one that exists means the rename is not a silent data-loss event: the
 * app would otherwise open a brand-new empty database and report no accounts,
 * no history and no error, which is the worst possible way to be wrong.
 */
function defaultDatabasePath(dataDir: string): string {
  const renamed = join(dataDir, "pathayam.sqlite");
  const legacy = join(dataDir, "budget.sqlite");
  return !existsSync(renamed) && existsSync(legacy) ? legacy : renamed;
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/*
 * SECURITY-OPS-27 · LOG_LEVEL was cast, not read. "INFO" became a level with no
 * threshold, the comparison against undefined never filtered, and every debug
 * line was logged in production. Case is forgiven; anything else stops the
 * process with the list of what it takes, rather than guessing what was meant.
 */
function logLevel(value: string | undefined, environment: Config["environment"]): Config["logLevel"] {
  if (value === undefined || value.trim() === "") return environment === "production" ? "info" : "debug";
  const level = value.trim().toLowerCase();
  if ((LOG_LEVELS as readonly string[]).includes(level)) return level as Config["logLevel"];
  throw new InvalidConfiguration(`LOG_LEVEL is '${value}'; use one of ${LOG_LEVELS.join(", ")}.`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const environment = env.NODE_ENV === "production" ? "production" : "development";
  const dataDir = resolve(env.DATA_DIR ?? "./data");
  const port = int(env.PORT, 8080);

  const config: Config = {
    port,
    host: env.HOST ?? "0.0.0.0",
    baseUrl: (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    dataDir,
    databasePath: env.DATABASE_PATH ?? defaultDatabasePath(dataDir),
    backupDir: env.BACKUP_DIR ?? join(dataDir, "backups"),
    attachmentDir: env.ATTACHMENT_DIR ?? join(dataDir, "attachments"),
    environment,
    logLevel: logLevel(env.LOG_LEVEL, environment),
    google: {
      clientId: env.GOOGLE_CLIENT_ID || null,
      clientSecret: env.GOOGLE_CLIENT_SECRET || null,
    },
    oidc: {
      issuer: env.OIDC_ISSUER || null,
      clientId: env.OIDC_CLIENT_ID || null,
      clientSecret: env.OIDC_CLIENT_SECRET || null,
      // What the button says. "Continue with Authelia" beats "Continue with
      // OpenID Connect" for the one person who will ever read it.
      label: env.OIDC_LABEL || "single sign-on",
    },
    devLogin: bool(env.DEV_LOGIN, false),
    demoMode: bool(env.DEMO_MODE, false),
    adminDebug: bool(env.ADMIN_DEBUG, false),
    sessionDays: int(env.SESSION_DAYS, 30), // Q22
    alphaVantageKey: env.ALPHA_VANTAGE_KEY || null,
    features: {
      loans: bool(env.FEATURE_LOANS, true),
      assets: bool(env.FEATURE_ASSETS, true),
      multiCurrency: bool(env.FEATURE_MULTI_CURRENCY, false), // Q18: ₹ only
    },
    backupWebhookUrl: env.BACKUP_WEBHOOK_URL || null,
    heartbeatUrl: env.HEARTBEAT_URL || null,
    trustProxy: bool(env.TRUST_PROXY, false),
    localLogin: bool(env.LOCAL_LOGIN, false),
  };

  assertDevLoginIsSafe(config);
  assertDemoModeIsSafe(config);
  return config;
}

/**
 * R38.5: the bypass must be *absent* from a production artefact, not merely
 * disabled in it. The Docker build deletes the module; this reports whether it
 * survived, which the health page displays (F23.13) and which in production
 * must always read "not present".
 */
export function devLoginModulePresent(): boolean {
  return (
    existsSync(join(HERE, "auth", "dev-login.ts")) ||
    existsSync(join(HERE, "auth", "dev-login.js"))
  );
}

/** A setting whose value this app cannot read, reported rather than guessed at. */
export class InvalidConfiguration extends Error {
  constructor(problem: string) {
    super(`Refusing to start: ${problem}\n`);
    this.name = "InvalidConfiguration";
  }
}

export class UnsafeConfiguration extends Error {
  /*
   * The advice has to name the right setting. Both bypasses raise this, and a
   * demo-mode refusal that told the operator to unset DEV_LOGIN would send them
   * looking for something that is not set.
   */
  constructor(indicators: string[], setting: "DEV_LOGIN" | "DEMO_MODE" = "DEV_LOGIN") {
    super(
      `Refusing to start: ${setting} is enabled, and this deployment is not safe for it.\n\n` +
        indicators.map((i) => `  · ${i}`).join("\n") +
        `\n\n${setting} bypasses authentication. Unset it, or resolve the\n` +
        "indicators above if this really is the machine you meant.\n",
    );
    this.name = "UnsafeConfiguration";
  }
}

/**
 * R38.3's production indicators. Any one of them, with DEV_LOGIN set, stops
 * the process.
 */
export function productionIndicators(config: Config): string[] {
  const found: string[] = [];

  if (config.environment === "production") {
    found.push("NODE_ENV is 'production'");
  }

  let host = "";
  try {
    host = new URL(config.baseUrl).hostname;
  } catch {
    found.push(`BASE_URL is not a valid URL: ${config.baseUrl}`);
  }
  if (host && !isLocalHostname(host)) {
    found.push(`BASE_URL points at a public hostname: ${host}`);
  }

  // SECURITY-OPS-27 · Google was the only door checked. OIDC is the other real
  // SSO door, and LOCAL_LOGIN means members have passwords they expect to
  // matter: a homelab on 192.168.x behind Authelia with DEV_LOGIN left on let
  // anyone on the LAN pick any member.
  found.push(...realSignInDoors(config));

  return found;
}

function isLocalHostname(host: string): boolean {
  // URL.hostname keeps the brackets on an IPv6 literal, so "::1" never matched
  // and the loopback was refused as "a public hostname: [::1]".
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".test")) return true;
  // RFC1918 ranges, so a homelab machine on a LAN still counts as development.
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/**
 * Two sign-in bypasses at once is a configuration mistake rather than a
 * capability, so it is refused rather than resolved in some precedence order.
 */
export function assertDemoModeIsSafe(config: Config): void {
  if (!config.demoMode) return;
  if (config.devLogin) {
    throw new UnsafeConfiguration([
      "DEMO_MODE and DEV_LOGIN are both set; enable exactly one",
    ], "DEMO_MODE");
  }
  /*
   * SECURITY-OPS-26 · A demo cannot use NODE_ENV or a public hostname as signs
   * of production — it is production-shaped by definition. What it can use is
   * a real way in. The demo's front door signs every visitor in, so a deployment
   * that has also configured Google, OIDC or passwords is a household that
   * switched DEMO_MODE on by mistake, and starting would hand its ledger to
   * anyone who reached /demo/enter. The public demo configures none of them.
   */
  const doors = realSignInDoors(config);
  if (doors.length > 0) throw new UnsafeConfiguration(doors, "DEMO_MODE");
}

/**
 * The ways a real member signs in. Either bypass alongside any of them means the
 * deployment has people who expect only they can get in.
 */
function realSignInDoors(config: Config): string[] {
  const found: string[] = [];
  if (config.google.clientId || config.google.clientSecret) {
    found.push("real Google OAuth credentials are configured");
  }
  if (config.oidc.issuer || config.oidc.clientId || config.oidc.clientSecret) {
    found.push("OpenID Connect credentials are configured (OIDC_*)");
  }
  if (config.localLogin) {
    found.push("password sign-in is enabled (LOCAL_LOGIN)");
  }
  return found;
}

/**
 * The guard that matters: demo mode opens the front door to anyone, so it must
 * never come up against a database somebody actually uses. A connected mailbox,
 * a saved statement identity, a password or a linked Google account means real use, and neither can be explained
 * away as demo data, so the app refuses to start rather than exposing them.
 */
export function assertDemoModeSafeAgainstData(
  config: Config,
  signs: { gmailConnections: number; statementIdentities: number; passwords: number; googleLinks: number },
): void {
  if (!config.demoMode) return;
  const found: string[] = [];
  if (signs.gmailConnections > 0) found.push("a connected mailbox");
  if (signs.statementIdentities > 0) found.push("a saved statement identity");
  // SECURITY-OPS-26 · A member who has a password or a linked Google account
  // signed in some real way; the demo's seed members never do, and the demo
  // refuses to set a password.
  if (signs.passwords > 0) found.push("a member's password");
  if (signs.googleLinks > 0) found.push("a member linked to a Google account");
  if (found.length > 0) {
    throw new UnsafeConfiguration([
      `this database holds ${found.join(" and ")} — it is in real use`,
    ], "DEMO_MODE");
  }
}

export function assertDevLoginIsSafe(config: Config): void {
  if (!config.devLogin) return;
  const indicators = productionIndicators(config);
  if (indicators.length > 0) throw new UnsafeConfiguration(indicators);
}

/**
 * The fourth indicator from R38.3 — "a database containing more than the seed
 * dataset" — can only be checked once the database is open, so it runs at
 * startup rather than at config load.
 */
export function assertDevLoginSafeAgainstData(config: Config, transactionCount: number): void {
  if (!config.devLogin) return;
  const SEED_CEILING = 200;
  if (transactionCount > SEED_CEILING) {
    throw new UnsafeConfiguration([
      `the database holds ${transactionCount} transactions, well beyond a seed dataset`,
    ]);
  }
}
