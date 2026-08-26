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
  /** R38.1: dev-only sign-in as any seeded member, off by default. */
  devLogin: boolean;
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
  /** Set behind a reverse proxy that terminates TLS. */
  trustProxy: boolean;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const environment = env.NODE_ENV === "production" ? "production" : "development";
  const dataDir = resolve(env.DATA_DIR ?? "./data");
  const port = int(env.PORT, 8080);

  const config: Config = {
    port,
    host: env.HOST ?? "0.0.0.0",
    baseUrl: (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    dataDir,
    databasePath: env.DATABASE_PATH ?? join(dataDir, "budget.sqlite"),
    backupDir: env.BACKUP_DIR ?? join(dataDir, "backups"),
    attachmentDir: env.ATTACHMENT_DIR ?? join(dataDir, "attachments"),
    environment,
    logLevel: (env.LOG_LEVEL as Config["logLevel"]) ?? (environment === "production" ? "info" : "debug"),
    google: {
      clientId: env.GOOGLE_CLIENT_ID || null,
      clientSecret: env.GOOGLE_CLIENT_SECRET || null,
    },
    devLogin: bool(env.DEV_LOGIN, false),
    sessionDays: int(env.SESSION_DAYS, 30), // Q22
    features: {
      loans: bool(env.FEATURE_LOANS, true),
      assets: bool(env.FEATURE_ASSETS, true),
      multiCurrency: bool(env.FEATURE_MULTI_CURRENCY, false), // Q18: ₹ only
    },
    backupWebhookUrl: env.BACKUP_WEBHOOK_URL || null,
    heartbeatUrl: env.HEARTBEAT_URL || null,
    trustProxy: bool(env.TRUST_PROXY, false),
  };

  assertDevLoginIsSafe(config);
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

export class UnsafeConfiguration extends Error {
  constructor(indicators: string[]) {
    super(
      "Refusing to start: DEV_LOGIN is enabled but this looks like a production deployment.\n\n" +
        indicators.map((i) => `  · ${i}`).join("\n") +
        "\n\nDEV_LOGIN completely bypasses authentication. Unset it, or clear the\n" +
        "indicators above if this really is a development machine.\n",
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

  if (config.google.clientId || config.google.clientSecret) {
    found.push("real Google OAuth credentials are configured");
  }

  return found;
}

function isLocalHostname(host: string): boolean {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return true;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".test")) return true;
  // RFC1918 ranges, so a homelab machine on a LAN still counts as development.
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
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
