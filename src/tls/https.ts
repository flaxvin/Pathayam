/**
 * TLS-1 · The app's own HTTPS listener, for a self-hosted box that faces the
 * internet without a tunnel or proxy in front. Off unless TLS_ACME_DOMAIN is
 * set; on Fly the edge terminates TLS and this never runs.
 *
 * The HTTPS server starts once the first certificate is in hand, and each
 * renewal goes in with setSecureContext: new connections get the new
 * certificate, open ones keep theirs. Until then the plain HTTP port serves
 * the app as before; after, it answers /healthz and redirects everything else.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import type { Logger } from "./acme.ts";
import type { CertBundle } from "./store.ts";

type Listener = (req: IncomingMessage, res: ServerResponse) => void;

export type HttpsFrontend = {
  /** Give it to the certificate manager as `onCert`. */
  onCert(bundle: CertBundle): void;
  /** True once HTTPS is listening. */
  live(): boolean;
  server(): https.Server | null;
  /** Resolves once the HTTPS server is listening (after the first certificate). */
  listening: Promise<number>;
  close(): Promise<void>;
};

export function createHttpsFrontend(opts: {
  port: number; host: string; listener: Listener; log?: Logger;
}): HttpsFrontend {
  const log = opts.log ?? (() => {});
  let server: https.Server | null = null;
  let isLive = false;
  let resolveListening!: (port: number) => void;
  const listening = new Promise<number>((r) => { resolveListening = r; });

  return {
    onCert(bundle) {
      if (server) {
        server.setSecureContext({ cert: bundle.certPem, key: bundle.keyPem });
        log({ msg: "https certificate replaced", notAfter: bundle.notAfter.toISOString() });
        return;
      }
      // Throws on a bad pair, which the manager reports and survives.
      const s = https.createServer({ cert: bundle.certPem, key: bundle.keyPem }, opts.listener);
      server = s;
      s.on("error", (err) => log({ level: "error", msg: "https server error", error: err.message }));
      s.listen(opts.port, opts.host, () => {
        isLive = true;
        const address = s.address();
        const port = typeof address === "object" && address ? address.port : opts.port;
        log({ msg: "https listening", port, notAfter: bundle.notAfter.toISOString() });
        resolveListening(port);
      });
    },
    live: () => isLive,
    server: () => server,
    listening,
    close() {
      return new Promise<void>((done) => {
        if (!server) return done();
        server.close(() => done());
        server.closeIdleConnections();
      });
    },
  };
}

/**
 * The plain-HTTP side once HTTPS is live: /healthz answers as before (the
 * container health check asks it over HTTP), everything else is a 308 to the
 * same path on BASE_URL. BASE_URL, not the Host header, so the redirect can
 * never be pointed somewhere else.
 *
 * REV-1 · The mail receiver's two calls stay too. Under compose it reaches the
 * app at http://pathayam:8080 and never follows a redirect, so a 308 turned
 * every forwarded message into a 451. Both are signed with INBOUND_SECRET and
 * never come from a browser.
 */
const PLAIN_PATHS = new Set(["/healthz", "/inbound/email", "/inbound/check"]);

export function redirectingListener(listener: Listener, isLive: () => boolean, baseUrl: string): Listener {
  const origin = new URL(baseUrl).origin;
  return (req, res) => {
    const path = req.url ?? "/";
    const q = path.indexOf("?");
    if (!isLive() || PLAIN_PATHS.has(q < 0 ? path : path.slice(0, q))) return listener(req, res);
    const target = `${origin}${path.startsWith("/") ? path : `/${path}`}`;
    res.writeHead(308, { Location: target, "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end(`Moved to ${target}\n`);
  };
}
