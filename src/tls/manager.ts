/**
 * TLS-1 · Keeps a certificate current: loads the stored one at start, checks
 * every twelve hours, renews when fewer than thirty days are left, and hands
 * each new certificate to `onCert` so a running server swaps it in for new
 * connections without dropping the ones it has.
 *
 * A failed renewal is logged with how long the current certificate has left,
 * retried with backoff (10 min, 30 min, 1 h, 3 h, 6 h, then every 12 h), and
 * never takes the old certificate away.
 */

import { AcmeClient, type AcmeClientOptions, type IssuedCertificate, type Logger } from "./acme.ts";
import { CloudflareSolver } from "./cloudflare.ts";
import type { DnsSolver } from "./dns.ts";
import { generateEcKeyPem } from "./jose.ts";
import { AcmeStore, inspectCertificate, type CertBundle } from "./store.ts";
import type { AcmeSettings } from "./settings.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const RENEW_BEFORE_MS = 30 * DAY_MS;
export const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
export const BACKOFF_MS = [10, 30, 60, 180, 360].map((m) => m * 60_000);

export type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export type CertManagerOptions = {
  domains: string[];
  directoryUrl: string;
  store: AcmeStore;
  /** Runs the ACME order; the manager decides when. */
  issue(domains: string[]): Promise<IssuedCertificate>;
  /** Given every certificate the manager has: the stored one at start, then each renewal. */
  onCert(bundle: CertBundle): void;
  log?: Logger;
  clock?: Clock;
  renewBeforeMs?: number;
  checkEveryMs?: number;
  backoffMs?: number[];
};

export type CertManager = {
  /** Loads what is stored, then runs the first check. Resolves when that check is done (it never rejects). */
  start(): Promise<void>;
  /** One check now: renew if due. Resolves to whether a new certificate was issued. */
  check(): Promise<boolean>;
  stop(): void;
  current(): CertBundle | null;
};

const sameNames = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

export function createCertManager(opts: CertManagerOptions): CertManager {
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? (() => {});
  const renewBefore = opts.renewBeforeMs ?? RENEW_BEFORE_MS;
  const checkEvery = opts.checkEveryMs ?? CHECK_EVERY_MS;
  const backoff = opts.backoffMs ?? BACKOFF_MS;
  let bundle: CertBundle | null = null;
  let failures = 0;
  let timer: unknown = null;
  let stopped = false;
  let running: Promise<boolean> | null = null;

  const daysLeft = () => (bundle ? Math.floor((bundle.notAfter.getTime() - clock.now()) / DAY_MS) : null);

  function schedule(ms: number): void {
    if (stopped) return;
    if (timer !== null) clock.clearTimeout(timer);
    timer = clock.setTimeout(() => {
      timer = null;
      void check();
    }, ms);
  }

  function use(next: CertBundle): void {
    try {
      opts.onCert(next);
      bundle = next;
    } catch (err) {
      // A certificate the server cannot load is as good as none: keep the old one.
      throw new Error(`the server could not load the certificate: ${(err as Error).message}`);
    }
  }

  async function renew(): Promise<boolean> {
    const due = !bundle || bundle.notAfter.getTime() - clock.now() < renewBefore;
    if (!due) {
      failures = 0;
      schedule(checkEvery);
      return false;
    }
    log({ msg: bundle ? "tls certificate due for renewal" : "tls certificate missing; requesting one", domains: opts.domains, daysLeft: daysLeft() });
    try {
      const issued = await opts.issue(opts.domains);
      const { notAfter } = inspectCertificate(issued.certPem, issued.keyPem);
      const next: CertBundle = { ...issued, domains: opts.domains, directoryUrl: opts.directoryUrl, notAfter };
      use(next);
      try {
        opts.store.saveCertificate(next);
      } catch (err) {
        // Served regardless: failing here and ordering again would only burn
        // Let's Encrypt's weekly limit on duplicate certificates.
        log({
          level: "error", msg: "tls certificate in use but not saved; a restart will request another. Check that ACME_DIR is writable",
          dir: opts.store.dir, error: (err as Error).message,
        });
      }
      failures = 0;
      log({ msg: "tls certificate in use", domains: opts.domains, notAfter: notAfter.toISOString() });
      schedule(checkEvery);
      return true;
    } catch (err) {
      failures++;
      const wait = Math.min(backoff[failures - 1] ?? checkEvery, checkEvery);
      log({
        level: "error",
        msg: bundle ? "tls renewal failed; still serving the current certificate" : "tls certificate request failed; serving without TLS for now",
        domains: opts.domains, error: (err as Error).message, attempt: failures, daysLeft: daysLeft(),
        retryInMinutes: Math.round(wait / 60_000),
      });
      schedule(wait);
      return false;
    }
  }

  function check(): Promise<boolean> {
    if (stopped) return Promise.resolve(false);
    // Never two orders at once: a check that lands mid-renewal joins it.
    running ??= renew().finally(() => { running = null; });
    return running;
  }

  return {
    async start() {
      try {
        const stored = opts.store.loadCertificate(opts.domains);
        if (stored && stored.directoryUrl === opts.directoryUrl && sameNames(stored.domains, opts.domains)
          && stored.notAfter.getTime() > clock.now()) {
          use(stored);
          log({ msg: "tls certificate loaded", domains: opts.domains, notAfter: stored.notAfter.toISOString(), daysLeft: daysLeft() });
        } else if (stored) {
          log({ level: "warn", msg: "stored tls certificate is for other names, another ACME directory, or expired; replacing it", domains: opts.domains });
        }
      } catch (err) {
        log({ level: "warn", msg: "stored tls certificate could not be read; requesting a new one", error: (err as Error).message });
      }
      await check();
    },
    check,
    stop() {
      stopped = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
    current: () => bundle,
  };
}

/** The solver named by the settings. Only Cloudflare today; another provider implements DnsSolver. */
export function solverFor(settings: AcmeSettings, fetchImpl?: typeof fetch): DnsSolver {
  switch (settings.dnsProvider) {
    case "cloudflare":
      return new CloudflareSolver({
        token: settings.cloudflareToken ?? "",
        zoneId: settings.cloudflareZoneId,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
  }
}

/**
 * Everything wired from settings: the store, the account (made once and kept),
 * the solver and the manager. `onCert` receives each certificate.
 */
export function createAcmeManager(
  settings: AcmeSettings,
  onCert: (bundle: CertBundle) => void,
  options: {
    log?: Logger; clock?: Clock; fetchImpl?: typeof fetch; solver?: DnsSolver;
    client?: Partial<AcmeClientOptions>;
  } = {},
): CertManager {
  const store = new AcmeStore(settings.dir);
  const solver = options.solver ?? solverFor(settings, options.fetchImpl);
  return createCertManager({
    domains: settings.domains,
    directoryUrl: settings.directoryUrl,
    store,
    onCert,
    ...(options.log ? { log: options.log } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    async issue(domains) {
      const client = new AcmeClient({
        directoryUrl: settings.directoryUrl,
        accountKeyPem: store.accountKey(settings.directoryUrl, generateEcKeyPem),
        accountUrl: store.accountUrl(settings.directoryUrl),
        email: settings.email,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.log ? { log: options.log } : {}),
        ...options.client,
      });
      const known = client.accountUrl;
      const accountUrl = await client.ensureAccount();
      if (accountUrl !== known) store.saveAccountUrl(settings.directoryUrl, accountUrl);
      return client.obtainCertificate(domains, solver);
    },
  });
}
