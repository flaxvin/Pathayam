/**
 * FWD-2 · pathayam-mx: the receive-only mail server for forwarding addresses.
 *
 *     node dist/mx/main.js
 *     node --experimental-strip-types src/mx/main.ts
 *
 * It runs as its own process (its own Fly app with port 25 and a dedicated
 * IPv4, or an optional compose service), takes mail for MX_DOMAIN and hands
 * each message to the household app its address routes to. Nothing but its
 * own TLS certificate (MX_TLS_ACME_DOMAIN) touches disk; the logs carry
 * envelope facts only, never a body or a subject.
 *
 * Environment:
 *   MX_DOMAIN       required  the domain addresses live under (in.pathayam.app)
 *   MX_ROUTES       required  {"<route>": {"url": "https://…", "secret": "…"}}
 *   MX_PORT         25
 *   MX_HOSTNAME     MX_DOMAIN; the name in the banner and EHLO reply
 *   MX_MAX_BYTES    26214400 (25 MiB)
 *   MX_TLS_CERT / MX_TLS_KEY            PEM text, or
 *   MX_TLS_CERT_FILE / MX_TLS_KEY_FILE  paths to PEM files; both or neither.
 *   MX_TLS_ACME_DOMAIN  TLS-1: get and renew a Let's Encrypt certificate for
 *                       this name by DNS-01 (src/tls; needs CLOUDFLARE_API_TOKEN,
 *                       see src/tls/settings.ts). An explicit MX_TLS_CERT wins.
 */

import { readFileSync } from "node:fs";
import type net from "node:net";
import { pathToFileURL } from "node:url";
import { createSmtpServer, type SmtpReply, type SmtpServer } from "./smtp.ts";
import { parseRoutes, resolveRecipient, relayMessage, type Route } from "./relay.ts";
import { loadAcmeSettings, type AcmeSettings } from "../tls/settings.ts";
import { createAcmeManager, type CertManager, type Clock } from "../tls/manager.ts";
import type { DnsSolver } from "../tls/dns.ts";
import type { AcmeClientOptions } from "../tls/acme.ts";

export type MxConfig = {
  domain: string;
  hostname: string;
  port: number;
  maxBytes: number;
  routes: Map<string, Route>;
  tls?: { cert: string; key: string };
  /** TLS-1 · Set when the certificate comes from Let's Encrypt rather than MX_TLS_CERT. */
  acme?: AcmeSettings;
  /** MX_TLS_ACME_DOMAIN was set alongside an explicit certificate, which won. */
  acmeIgnored?: boolean;
};

export const DEFAULT_MAX_BYTES = 26_214_400;
/** How long a shutdown waits for sessions in progress before cutting them off. */
export const SHUTDOWN_GRACE_MS = 10_000;

export type Logger = (entry: Record<string, unknown>) => void;

const jsonLog: Logger = (entry) => {
  process.stdout.write(`${JSON.stringify({ level: "info", ...entry })}\n`);
};

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
  }
  return Number(raw);
}

/** One half of the TLS pair: inline PEM wins over a file path. */
function pem(env: NodeJS.ProcessEnv, inline: string, file: string): string | undefined {
  const text = env[inline]?.trim();
  if (text) return text;
  const path = env[file]?.trim();
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`${file}: cannot read ${path}: ${(err as Error).message}`);
  }
}

/** Reads and checks the environment. Throws an Error naming the bad variable. */
export function loadMxConfig(env: NodeJS.ProcessEnv): MxConfig {
  const domain = env.MX_DOMAIN?.trim().toLowerCase().replace(/\.$/, "");
  if (!domain) throw new Error("MX_DOMAIN is required (the domain forwarding addresses live under)");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(domain)) {
    throw new Error(`MX_DOMAIN is not a valid domain name: "${domain}"`);
  }
  const routes = parseRoutes(env.MX_ROUTES);
  const cert = pem(env, "MX_TLS_CERT", "MX_TLS_CERT_FILE");
  const key = pem(env, "MX_TLS_KEY", "MX_TLS_KEY_FILE");
  if ((cert === undefined) !== (key === undefined)) {
    throw new Error("TLS needs both a certificate and a key (MX_TLS_CERT[_FILE] and MX_TLS_KEY[_FILE]), or neither");
  }
  const config: MxConfig = {
    domain,
    hostname: env.MX_HOSTNAME?.trim() || domain,
    port: integer(env, "MX_PORT", 25, 0, 65535),
    maxBytes: integer(env, "MX_MAX_BYTES", DEFAULT_MAX_BYTES, 1024, 1024 ** 3),
    routes,
  };
  if (cert !== undefined && key !== undefined) config.tls = { cert, key };
  let acme: AcmeSettings | null;
  try {
    acme = loadAcmeSettings(env, "MX_TLS_ACME_DOMAIN");
  } catch (err) {
    throw new Error(`Let's Encrypt for the receiver: ${(err as Error).message}`);
  }
  if (acme && config.tls) config.acmeIgnored = true;
  else if (acme) config.acme = acme;
  return config;
}

export type RunningMx = {
  server: net.Server;
  /** The port actually bound (useful with MX_PORT=0). */
  port: number;
  /** TLS-1 · The certificate keeper, when MX_TLS_ACME_DOMAIN is in charge. */
  acme: CertManager | null;
  /** Settles once the first certificate check is done (at once without ACME). */
  acmeReady: Promise<void>;
  /** Stops accepting, waits up to SHUTDOWN_GRACE_MS for open sessions, then cuts them off. */
  close(graceMs?: number): Promise<void>;
};

/** Starts the server from an environment. Rejects on bad config or a failed listen. */
export async function startMx(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    log?: Logger; fetchImpl?: typeof fetch;
    /** Tests: what the ACME manager talks to, and its clock. */
    acme?: { fetchImpl?: typeof fetch; solver?: DnsSolver; clock?: Clock; client?: Partial<AcmeClientOptions> };
  } = {},
): Promise<RunningMx> {
  const log = options.log ?? jsonLog;
  const config = loadMxConfig(env);

  const resolve = (address: string) => resolveRecipient(address, config.domain, config.routes);

  let server: SmtpServer;
  try {
    server = createSmtpServer({
      hostname: config.hostname,
      maxBytes: config.maxBytes,
      ...(config.tls ? { tls: config.tls } : {}),
      log,
      checkRecipient(address) {
        const r = resolve(address);
        return "code" in r ? r : "ok";
      },
      async deliver({ recipients, raw }) {
        // Two RCPTs can name the same mailbox (x+a@, x+b@): hand it over once.
        const byRecipient = new Map<string, Promise<SmtpReply>>();
        return Promise.all(recipients.map((address) => {
          const r = resolve(address);
          if ("code" in r) return r;
          let pending = byRecipient.get(r.recipient);
          if (!pending) {
            pending = relayMessage(r.route, r.recipient, raw, options.fetchImpl ?? fetch).then((reply) => {
              if (reply.code === 554) {
                log({ level: "error", msg: "app refused hand-off: check the route's url and secret", route: r.route.url, reply: reply.message });
              }
              return reply;
            });
            byRecipient.set(r.recipient, pending);
          }
          return pending;
        }));
      },
    });
  } catch (err) {
    throw new Error(`MX TLS certificate/key could not be loaded: ${(err as Error).message}`);
  }

  const sockets = new Set<net.Socket>();
  server.on("connection", (s: net.Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(config.port, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  server.on("error", (err) => log({ level: "error", msg: "mx server error", error: err.message }));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  log({
    msg: "pathayam-mx listening", port, domain: config.domain, hostname: config.hostname,
    routes: [...config.routes.keys()], maxBytes: config.maxBytes,
    tls: config.tls ? "certificate" : config.acme ? "lets-encrypt" : false,
  });
  if (config.acmeIgnored) {
    log({ level: "warn", msg: "MX_TLS_ACME_DOMAIN ignored: MX_TLS_CERT/MX_TLS_KEY are set and win" });
  } else if (!config.tls && !config.acme) {
    log({ level: "warn", msg: "no TLS certificate: STARTTLS is not offered and mail arrives unencrypted (set MX_TLS_ACME_DOMAIN)" });
  }

  // TLS-1 · The receiver answers at once; STARTTLS appears as soon as the
  // first certificate is in hand, and each renewal swaps in for new sessions.
  let acme: CertManager | null = null;
  let acmeReady = Promise.resolve();
  if (config.acme) {
    const a = options.acme ?? {};
    acme = createAcmeManager(config.acme, (bundle) => {
      server.setTlsCertificate({ cert: bundle.certPem, key: bundle.keyPem });
    }, {
      log,
      ...(a.fetchImpl ? { fetchImpl: a.fetchImpl } : {}),
      ...(a.solver ? { solver: a.solver } : {}),
      ...(a.clock ? { clock: a.clock } : {}),
      ...(a.client ? { client: a.client } : {}),
    });
    acmeReady = acme.start();
  }

  return {
    server,
    port,
    acme,
    acmeReady,
    close(graceMs = SHUTDOWN_GRACE_MS) {
      acme?.stop();
      return new Promise<void>((done) => {
        const finish = () => {
          clearInterval(poll);
          clearTimeout(deadline);
          done();
        };
        server.close();
        const poll = setInterval(() => { if (sockets.size === 0) finish(); }, 100);
        const deadline = setTimeout(() => {
          for (const s of sockets) s.destroy();
          finish();
        }, graceMs);
        if (sockets.size === 0) finish();
      });
    },
  };
}

async function main(): Promise<void> {
  let mx: RunningMx;
  try {
    mx = await startMx(process.env);
  } catch (err) {
    jsonLog({ level: "error", msg: `pathayam-mx cannot start: ${(err as Error).message}` });
    process.exit(1);
  }
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    jsonLog({ msg: "pathayam-mx shutting down", signal });
    void mx.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
