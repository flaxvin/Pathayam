/**
 * TLS-1 · The ACME settings, read from the environment the same way for the
 * mail receiver (MX_TLS_ACME_DOMAIN) and the app (TLS_ACME_DOMAIN). Off unless
 * the domain variable is set; set, anything missing or unreadable is an error
 * naming the variable, so a typo never quietly leaves mail in clear text.
 *
 *   ACME_DIRECTORY         production (default), staging, or a directory URL
 *   ACME_EMAIL             optional; Let's Encrypt writes about problems there
 *   ACME_DIR               $DATA_DIR/acme; account key and certificate, 0600
 *   ACME_DNS_PROVIDER      cloudflare (the only one so far)
 *   CLOUDFLARE_API_TOKEN   required; a token with Zone → DNS → Edit
 *   CLOUDFLARE_ZONE_ID     optional; otherwise the zone is looked up by name
 */

import { join, resolve } from "node:path";
import { LETS_ENCRYPT_PRODUCTION, LETS_ENCRYPT_STAGING } from "./acme.ts";

export const DNS_PROVIDERS = ["cloudflare"] as const;
export type DnsProvider = (typeof DNS_PROVIDERS)[number];

export type AcmeSettings = {
  domains: string[];
  directoryUrl: string;
  email: string | null;
  dir: string;
  dnsProvider: DnsProvider;
  cloudflareToken: string | null;
  cloudflareZoneId: string | null;
};

const NAME = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Null when `domainVar` is unset. Throws an Error naming the variable at fault. */
export function loadAcmeSettings(env: NodeJS.ProcessEnv, domainVar: string): AcmeSettings | null {
  const rawDomains = (env[domainVar] ?? "").trim();
  if (rawDomains === "") return null;
  const domains = [...new Set(rawDomains.split(/[\s,]+/).filter(Boolean).map((d) => d.toLowerCase().replace(/\.$/, "")))];
  for (const d of domains) {
    if (!NAME.test(d)) throw new Error(`${domainVar}: "${d}" is not a domain name (e.g. in.example.com)`);
  }

  const dirSetting = (env.ACME_DIRECTORY ?? "").trim();
  let directoryUrl: string;
  if (dirSetting === "" || dirSetting.toLowerCase() === "production") directoryUrl = LETS_ENCRYPT_PRODUCTION;
  else if (dirSetting.toLowerCase() === "staging") directoryUrl = LETS_ENCRYPT_STAGING;
  else {
    let url: URL;
    try {
      url = new URL(dirSetting);
    } catch {
      throw new Error(`ACME_DIRECTORY is "${dirSetting}"; use production, staging, or an https:// directory URL`);
    }
    // Plain http only to this machine: a private test CA such as Pebble.
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      throw new Error("ACME_DIRECTORY must be an https:// URL");
    }
    directoryUrl = url.href;
  }

  const email = (env.ACME_EMAIL ?? "").trim() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`ACME_EMAIL is "${email}"; use an email address or leave it empty`);

  const provider = (env.ACME_DNS_PROVIDER ?? "cloudflare").trim().toLowerCase() || "cloudflare";
  if (!(DNS_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`ACME_DNS_PROVIDER is "${provider}"; use one of ${DNS_PROVIDERS.join(", ")}`);
  }
  const cloudflareToken = (env.CLOUDFLARE_API_TOKEN ?? "").trim() || null;
  if (provider === "cloudflare" && !cloudflareToken) {
    throw new Error(`${domainVar} is set, so CLOUDFLARE_API_TOKEN is required (a Cloudflare token with Zone → DNS → Edit)`);
  }

  return {
    domains,
    directoryUrl,
    email,
    dir: resolve(env.ACME_DIR?.trim() || join(env.DATA_DIR?.trim() || "./data", "acme")),
    dnsProvider: provider as DnsProvider,
    cloudflareToken,
    cloudflareZoneId: (env.CLOUDFLARE_ZONE_ID ?? "").trim() || null,
  };
}
