/**
 * A running app, in a test.
 *
 * B68 · `app.ts` holds 163 route handlers and, until this file, not one test
 * invoked any of them. The suite was strong below that line and silent on it,
 * which is precisely where every bug found by hand actually lived: a scroll
 * position thrown away, a group rendered twice under one name, a mapping
 * screen for a file with no columns, an undo that returned 500 on a foreign
 * key. All four were reachable from a URL and none were reachable from a test.
 *
 * The harness boots the real app on an ephemeral port and drives it over real
 * HTTP, rather than faking `IncomingMessage`. That costs a few milliseconds per
 * suite and buys the whole stack — middleware, auth, routing, body parsing,
 * redirects, the error hook — instead of the handler alone.
 *
 * Not a `.test.ts` file: this is the fixture the route tests import.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import { createHttpServer } from "../http/server.ts";
import { HttpError } from "../http/router.ts";
import { Refusal } from "../core/refusal.ts";
import { buildApp, renderErrorPage } from "../app.ts";
import type { Config } from "../config.ts";
import { nowIST } from "../core/dates.ts";
import { createSession, SESSION_COOKIE } from "../auth/sessions.ts";
import { recordRequestFailure } from "../ops/errors.ts";

export interface TestApp {
  db: DB;
  baseUrl: string;
  /** Every unexpected 500 the app raised, so a test can assert there were none. */
  failures: { method: string; path: string; error: string }[];
  get(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, form?: Record<string, string>, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    baseUrl: "http://127.0.0.1",
    dataDir: "/tmp",
    databasePath: ":memory:",
    backupDir: "/tmp/backups-under-test",
    attachmentDir: "/tmp/attachments-under-test",
    environment: "development",
    logLevel: "error",
    google: { clientId: null, clientSecret: null },
    devLogin: false,
    demoMode: false,
    adminDebug: false,
    sessionDays: 30,
    features: { loans: true, assets: true, multiCurrency: false },
    backupWebhookUrl: null,
    heartbeatUrl: null,
    alphaVantageKey: null,
    trustProxy: false,
    localLogin: false,
    ...overrides,
  };
}

/**
 * Boot the app against a database the caller has already populated, and sign
 * in as `memberId` by minting a real session — the same path the browser takes,
 * so the auth middleware is exercised rather than bypassed.
 */
export async function startTestApp(
  db: DB,
  opts: { memberId?: string | null; config?: Partial<Config> } = {},
): Promise<TestApp> {
  const failures: TestApp["failures"] = [];
  const config = testConfig(opts.config);
  const { router, middleware } = buildApp({ db, config });

  const server = createHttpServer({
    router,
    baseUrl: config.baseUrl,
    trustProxy: config.trustProxy,
    middleware,
    onError(err, ctx) {
      /*
       * Exactly main.ts's rule: a Refusal is the domain declining on purpose,
       * and is not a fault. Without this line the harness answered 500 where
       * production answers 422, so a test could only ever prove the wrong
       * thing about every deliberate refusal in the app.
       */
      const deliberate = err instanceof HttpError || err instanceof Refusal;
      if (!deliberate) {
        failures.push({
          method: ctx.method,
          path: ctx.url.pathname,
          error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
        });
        // Mirror production: the failure is recorded, not swallowed (B66).
        try {
          recordRequestFailure(db, {
            method: ctx.method, path: ctx.url.pathname, status: 500, error: err,
          });
        } catch { /* the record is a convenience here, not the assertion */ }
      }
      const status = err instanceof HttpError ? err.status
        : err instanceof Refusal ? err.status
        : 500;
      const message = deliberate ? (err as Error).message : "Something went wrong on the server.";
      if ((ctx.req.headers.accept ?? "").includes("application/json")) {
        return { status, json: { error: message } };
      }
      return { status, body: renderErrorPage(status, message) };
    },
  });

  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  let cookie = "";
  if (opts.memberId !== null) {
    const { token } = createSession(db, opts.memberId ?? "m", { userAgent: "test", ipHint: null, days: 30 });
    cookie = `${SESSION_COOKIE}=${token}`;
  }

  const withCookie = (init: RequestInit = {}): RequestInit => ({
    ...init,
    redirect: "manual",
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(init.headers ?? {}) },
  });

  return {
    db,
    baseUrl,
    failures,
    get: (path, init) => fetch(baseUrl + path, withCookie(init)),
    post: (path, form = {}, init) =>
      fetch(
        baseUrl + path,
        withCookie({
          ...init,
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            /*
             * A browser sends this on every form post, and the app requires it
             * on every write: a cross-site post is rejected on the value, and
             * one with neither Origin nor Referer for having neither. A test
             * client that omitted it would be exercising a path no browser
             * takes — and passing where a browser is refused.
             */
            Origin: baseUrl,
            ...(init?.headers ?? {}),
          },
          body: new URLSearchParams(form).toString(),
        }),
      ),
    close: () =>
      new Promise<void>((ok, fail) => server.close((err) => (err ? fail(err) : ok()))),
  };
}

/** A member row, so a session has something to point at. */
export function seedMember(db: DB, id = "m", name = "Ravi"): string {
  execute(
    db,
    `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    id, `${id}@example.com`, name, nowIST(),
  );
  return id;
}

export function freshDb(): DB {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  return db;
}
