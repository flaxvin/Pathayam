/**
 * The HTTP server.
 *
 * Enforces two things centrally so no individual route can forget them:
 *
 * - **R35.4** a Content-Security-Policy forbidding every third-party origin.
 *   The app talks only to its own server.
 * - **R38.16** the member allow-list, checked server-side on *every* request
 *   rather than only at login.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { SafeHtml } from "./html.ts";
import {
  Router,
  readBody,
  HttpError,
  NotFound,
  type RequestContext,
  type Response,
  type Handler,
} from "./router.ts";

export interface ServerOptions {
  router: Router;
  baseUrl: string;
  trustProxy: boolean;
  /** Runs before routing; may return a Response to short-circuit. */
  middleware?: Handler[];
  onError?: (err: unknown, ctx: RequestContext) => Response | void;
  logger?: (line: Record<string, unknown>) => void;
}

/**
 * R35.4. `connect-src 'self'` is what actually stops a third-party call;
 * `default-src 'self'` covers the rest. Inline styles are permitted because a
 * few progress bars carry a computed width, but inline *script* is not.
 */
export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");
}

function securityHeaders(secure: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": contentSecurityPolicy(),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    // R37.7 is about the event log, but the same instinct applies outward:
    // nothing about this household is offered to anyone else.
    "Permissions-Policy": "geolocation=(), camera=(), microphone=(), interest-cohort=()",
  };
  if (secure) {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}

export function createHttpServer(options: ServerOptions): Server {
  const { router, baseUrl, trustProxy, middleware = [], onError, logger } = options;
  const secure = baseUrl.startsWith("https://");

  return createServer((req, res) => {
    void handle(req, res).catch((err) => {
      // Nothing below should reach here; if it does, fail closed rather than
      // leaving the socket open.
      logger?.({ level: "error", msg: "unhandled", error: String(err) });
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Something went wrong.");
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? "/", baseUrl);

    const ctx: RequestContext = {
      req,
      res,
      method: req.method ?? "GET",
      url,
      params: {},
      query: url.searchParams,
      body: {},
      locals: {},
    };

    for (const [key, value] of Object.entries(securityHeaders(secure))) {
      res.setHeader(key, value);
    }

    try {
      if (ctx.method === "POST" || ctx.method === "PUT" || ctx.method === "DELETE") {
        ctx.body = await readBody(req);
      }

      let response: Response | void = undefined;

      for (const fn of middleware) {
        response = await fn(ctx);
        if (response) break;
      }

      if (!response) {
        const match = router.match(ctx.method, url.pathname);
        if (!match) {
          if (router.hasPath(url.pathname)) {
            throw new HttpError(405, "That action is not allowed here.");
          }
          throw new NotFound();
        }
        ctx.params = match.params;
        response = (await match.handler(ctx)) ?? { status: 204 };
      }

      send(ctx, response);
    } catch (err) {
      const handled = onError?.(err, ctx);
      if (handled) {
        send(ctx, handled);
      } else if (err instanceof HttpError) {
        send(ctx, { status: err.status, body: err.message });
      } else {
        // S7: structured logs, and never a financial value in a log line.
        logger?.({
          level: "error",
          msg: "request failed",
          method: ctx.method,
          path: url.pathname,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        send(ctx, { status: 500, body: "Something went wrong on the server." });
      }
    } finally {
      logger?.({
        level: "debug",
        msg: "request",
        method: ctx.method,
        path: url.pathname,
        status: res.statusCode,
        ms: Date.now() - started,
      });
    }
  }
}

export function send(ctx: RequestContext, response: Response): void {
  const { res } = ctx;
  if (res.writableEnded) return;

  if (response.redirect) {
    // Fetch cannot follow a cross-document redirect usefully, so the client
    // script asks for JSON and navigates itself (see client.ts).
    if (wantsJson(ctx)) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ redirect: response.redirect }));
      return;
    }
    res.writeHead(response.status ?? 303, { Location: response.redirect });
    res.end();
    return;
  }

  if (response.json !== undefined) {
    res.writeHead(response.status ?? 200, {
      "Content-Type": "application/json; charset=utf-8",
      ...response.headers,
    });
    res.end(JSON.stringify(response.json));
    return;
  }

  const body = response.body ?? "";
  const text = body instanceof SafeHtml ? body.value : body;
  const isHtml =
    typeof text === "string" && (text.startsWith("<!doctype") || text.startsWith("<"));

  res.writeHead(response.status ?? 200, {
    "Content-Type": isHtml ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
    ...response.headers,
  });
  res.end(text);
}

export function wantsJson(ctx: RequestContext): boolean {
  return (ctx.req.headers.accept ?? "").includes("application/json");
}

export function clientIp(ctx: RequestContext, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = ctx.req.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (first) return first.split(",")[0]!.trim();
  }
  return ctx.req.socket.remoteAddress ?? "unknown";
}
