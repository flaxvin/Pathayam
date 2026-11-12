/**
 * FWD-2 · pathayam-mx: the receive-only mail server for forwarding addresses.
 *
 *     node dist/mx/main.js
 *     node --experimental-strip-types src/mx/main.ts
 *
 * It runs as its own process (its own Fly app with port 25 and a dedicated
 * IPv4, or an optional compose service), takes mail for MX_DOMAIN and hands
 * each message to the household app its address routes to. Nothing touches
 * disk; the logs carry envelope facts only, never a body or a subject.
 *
 * Environment:
 *   MX_DOMAIN       required  the domain addresses live under (in.pathayam.app)
 *   MX_ROUTES       required  {"<route>": {"url": "https://…", "secret": "…"}}
 *   MX_PORT         25
 *   MX_HOSTNAME     MX_DOMAIN; the name in the banner and EHLO reply
 *   MX_MAX_BYTES    26214400 (25 MiB)
 *   MX_MEMORY_BYTES             100663296 (96 MiB) held as messages, all sessions together
 *   MX_MAX_CONNECTIONS          20 sessions at once
 *   MX_MAX_CONNECTIONS_PER_IP   3 sessions at once from one address
 *   MX_SESSION_SECONDS          600; a session ends this long after it began
 *   MX_PROXY_PROTOCOL           off; "on" when a proxy sends PROXY v1 lines (Fly proxy_proto)
 *   MX_CHECK_RECIPIENTS         on; "off" accepts any well-formed address at RCPT
 *   MX_TLS_CERT / MX_TLS_KEY            PEM text, or
 *   MX_TLS_CERT_FILE / MX_TLS_KEY_FILE  paths to PEM files; both or neither.
 */

import { readFileSync } from "node:fs";
import type net from "node:net";
import { pathToFileURL } from "node:url";
import { createSmtpServer, SLAB_OVERHEAD, type SmtpReply } from "./smtp.ts";
import { checkAddress, CheckCache, parseRoutes, resolveRecipient, relayMessage, type Route } from "./relay.ts";

export type MxConfig = {
  domain: string;
  hostname: string;
  port: number;
  maxBytes: number;
  routes: Map<string, Route>;
  tls?: { cert: string; key: string };
  /** MAIL-8/9 · What one stranger can cost, and whether RCPT asks the app. */
  limits: MxLimits;
};

export type MxLimits = {
  memoryBytes: number;
  maxConnections: number;
  maxPerAddress: number;
  sessionSeconds: number;
  proxyProtocol: boolean;
  checkRecipients: boolean;
};

export const DEFAULT_MEMORY_BYTES = 96 * 1024 * 1024;

function onOff(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "on" || raw === "true" || raw === "1") return true;
  if (raw === "off" || raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be on or off, got "${raw}"`);
}

/** MAIL-8/9 · The caps on what the receiver holds, and the RCPT check. */
function loadLimits(env: NodeJS.ProcessEnv, maxBytes: number): MxLimits {
  const limits: MxLimits = {
    memoryBytes: integer(env, "MX_MEMORY_BYTES", DEFAULT_MEMORY_BYTES, 1024, 64 * 1024 ** 3),
    maxConnections: integer(env, "MX_MAX_CONNECTIONS", 20, 1, 10_000),
    maxPerAddress: integer(env, "MX_MAX_CONNECTIONS_PER_IP", 3, 1, 10_000),
    sessionSeconds: integer(env, "MX_SESSION_SECONDS", 600, 10, 86_400),
    proxyProtocol: onOff(env, "MX_PROXY_PROTOCOL", false),
    checkRecipients: onOff(env, "MX_CHECK_RECIPIENTS", true),
  };
  if (limits.memoryBytes < maxBytes + SLAB_OVERHEAD) {
    throw new Error(`MX_MEMORY_BYTES must be at least MX_MAX_BYTES plus 1 MiB (${maxBytes + SLAB_OVERHEAD}), or the largest message never fits`);
  }
  return limits;
}

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
  const maxBytes = integer(env, "MX_MAX_BYTES", DEFAULT_MAX_BYTES, 1024, 1024 ** 3);
  const config: MxConfig = {
    domain,
    hostname: env.MX_HOSTNAME?.trim() || domain,
    port: integer(env, "MX_PORT", 25, 0, 65535),
    maxBytes,
    routes,
    limits: loadLimits(env, maxBytes),
  };
  if (cert !== undefined && key !== undefined) config.tls = { cert, key };
  return config;
}

export type RunningMx = {
  server: net.Server;
  /** The port actually bound (useful with MX_PORT=0). */
  port: number;
  /** Stops accepting, waits up to SHUTDOWN_GRACE_MS for open sessions, then cuts them off. */
  close(graceMs?: number): Promise<void>;
};

/** Starts the server from an environment. Rejects on bad config or a failed listen. */
export async function startMx(
  env: NodeJS.ProcessEnv = process.env,
  options: { log?: Logger; fetchImpl?: typeof fetch } = {},
): Promise<RunningMx> {
  const log = options.log ?? jsonLog;
  const config = loadMxConfig(env);

  const resolve = (address: string) => resolveRecipient(address, config.domain, config.routes);
  const fetchImpl = options.fetchImpl ?? fetch;
  const checked = new CheckCache();

  let server: net.Server;
  try {
    server = createSmtpServer({
      hostname: config.hostname,
      maxBytes: config.maxBytes,
      ...(config.tls ? { tls: config.tls } : {}),
      log,
      memoryBytes: config.limits.memoryBytes,
      maxConnections: config.limits.maxConnections,
      maxPerAddress: config.limits.maxPerAddress,
      sessionTimeoutMs: config.limits.sessionSeconds * 1000,
      proxyProtocol: config.limits.proxyProtocol,
      checkRecipient(address) {
        const r = resolve(address);
        if ("code" in r) return r;
        if (!config.limits.checkRecipients) return "ok";
        // MAIL-9 · Ask the app whether the address is in use, before any data.
        const known = checked.get(r.recipient);
        if (known !== undefined) return known;
        return checkAddress(r.route, r.recipient, fetchImpl).then((answer) => {
          if (answer.misconfigured) {
            log({ level: "error", msg: "app refused the address check: check the route's url and secret", route: r.route.url, status: answer.misconfigured });
          }
          if (answer.cache) checked.set(r.recipient, answer.verdict);
          return answer.verdict;
        });
      },
      async deliver({ recipients, raw }) {
        // Two RCPTs can name the same mailbox (x+a@, x+b@): hand it over once.
        const byRecipient = new Map<string, Promise<SmtpReply>>();
        return Promise.all(recipients.map((address) => {
          const r = resolve(address);
          if ("code" in r) return r;
          let pending = byRecipient.get(r.recipient);
          if (!pending) {
            pending = relayMessage(r.route, r.recipient, raw, fetchImpl).then((reply) => {
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
    routes: [...config.routes.keys()], tls: Boolean(config.tls), maxBytes: config.maxBytes,
    limits: config.limits,
  });

  return {
    server,
    port,
    close(graceMs = SHUTDOWN_GRACE_MS) {
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
