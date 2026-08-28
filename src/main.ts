/**
 * Entry point.
 *
 * The order matters: configuration is validated (which may refuse to start,
 * R38.3), then the database is opened and migrated, then the second half of
 * the dev-login gate runs against the data, and only then does the server
 * listen.
 */

import { loadConfig, assertDevLoginSafeAgainstData, UnsafeConfiguration, devLoginModulePresent } from "./config.ts";
import { openDatabase, ensureHousehold, queryOne } from "./db/db.ts";
import { createHttpServer } from "./http/server.ts";
import { buildApp, renderErrorPage } from "./app.ts";
import { HttpError } from "./http/router.ts";
import { pruneIdempotencyKeys } from "./core/idempotency.ts";
import { pruneExpiredSessions, pruneAuthAttempts } from "./auth/sessions.ts";
import { purgeDeleted } from "./domain/transactions.ts";
import { runBackupJob } from "./ops/backup.ts";
import { refreshPrices } from "./portfolio/refresh.ts";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof UnsafeConfiguration) {
      console.error(`\n${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // S7: structured output, one level control, and no financial values in a
  // log line — which is why nothing below ever logs a request body.
  const threshold = LEVELS[config.logLevel];
  const log = (line: Record<string, unknown>) => {
    const level = (line.level as keyof typeof LEVELS) ?? "info";
    if (LEVELS[level] < threshold) return;
    console.log(JSON.stringify({ at: new Date().toISOString(), ...line }));
  };

  const db = openDatabase({ path: config.databasePath });
  ensureHousehold(db);

  try {
    const count = queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM transactions`)?.n ?? 0;
    assertDevLoginSafeAgainstData(config, count);
  } catch (err) {
    if (err instanceof UnsafeConfiguration) {
      console.error(`\n${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const { router, middleware } = buildApp({ db, config });

  const server = createHttpServer({
    router,
    baseUrl: config.baseUrl,
    trustProxy: config.trustProxy,
    middleware,
    logger: log,
    onError(err, ctx) {
      const accept = ctx.req.headers.accept ?? "";
      const status = err instanceof HttpError ? err.status : 500;
      const message =
        err instanceof HttpError
          ? err.message
          : "Something went wrong on the server. Nothing you typed has been lost.";

      if (accept.includes("application/json")) {
        return { status, json: { error: message } };
      }
      return { status, body: renderErrorPage(status, message) };
    },
  });

  // Housekeeping. Deliberately in-process rather than a cron container: the
  // deployment is one box (Q8), and a job that needs a second container is a
  // job that silently stops running.
  // B51: run the housekeeping body on a leading tick shortly after listen, not
  // only every six hours. `setInterval` fires first after a full period, so a
  // box that restarts more often than every six hours would *never* reach the
  // restore verification — and R40.2 makes "can we actually recover" a
  // ship-blocking guarantee, not a best-effort one.
  const housekeepingTick = () => {
      try {
        const keys = pruneIdempotencyKeys(db);
        const sessions = pruneExpiredSessions(db);
        const attempts = pruneAuthAttempts(db);
        const purged = purgeDeleted(db);
        log({ level: "debug", msg: "housekeeping", keys, sessions, attempts, purged });
      } catch (err) {
        log({ level: "error", msg: "housekeeping failed", error: String(err) });
      }

      // R40.2: the scheduled job is a restore *verification*, not merely a
      // backup — being able to recover is the thing being checked. A failure
      // alerts through the webhook rather than only a log line (R40.4).
      void runBackupJob(db, {
        backupDir: config.backupDir,
        webhookUrl: config.backupWebhookUrl,
        heartbeatUrl: config.heartbeatUrl,
      })
        .then((result) => {
          log({
            level: result.ok ? "info" : "error",
            msg: "restore verification",
            ok: result.ok,
            summary: result.summary,
          });
        })
        .catch((err) => {
          log({ level: "error", msg: "backup job threw", error: String(err) });
        });

      // `07` P4 · Prices, on their own per-class cadence. The tick is every six
      // hours but `refreshPrices` decides whether anything is actually due —
      // a NAV published at 23:00 IST does not exist at noon, and asking for it
      // four times an evening is how a free provider stops being free.
      //
      // F28: skipped entirely when the assets module is off, so a household
      // that does not track investments makes no outbound calls at all.
      if (config.features.assets) {
        void refreshPrices(db, { memberId: null, source: "job" }, {
          alphaVantageKey: config.alphaVantageKey,
        })
          .then((result) => {
            if (result.attempted === 0) return;
            log({
              level: result.failed > 0 ? "warn" : "info",
              msg: "price refresh",
              updated: result.updated,
              failed: result.failed,
              skipped: result.skipped,
            });
          })
          .catch((err) => {
            // P9 / FW9: a failed refresh is never fatal. The last price stays,
            // with its date shown.
            log({ level: "error", msg: "price refresh threw", error: String(err) });
          });
      }
  };
  const housekeeping = setInterval(housekeepingTick, 6 * 60 * 60 * 1000);
  housekeeping.unref();
  // The leading run, a minute after listen — long enough not to compete with
  // startup, soon enough that a frequently-restarting box still verifies.
  const housekeepingLead = setTimeout(housekeepingTick, 60 * 1000);
  housekeepingLead.unref();

  server.listen(config.port, config.host, () => {
    log({
      level: "info",
      msg: "listening",
      url: config.baseUrl,
      environment: config.environment,
      // F23.13: in production this must always read false.
      devLoginPresent: devLoginModulePresent(),
      devLoginEnabled: config.devLogin,
    });
    if (config.devLogin) {
      console.log("\n  ⚠  DEV_LOGIN is on — authentication is bypassed on this machine.\n");
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log({ level: "info", msg: "shutting down", signal });
      server.close(() => {
        db.close();
        process.exit(0);
      });
    });
  }
}

main();
