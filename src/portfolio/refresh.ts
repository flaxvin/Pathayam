/**
 * `07` P4 · The scheduled price refresh.
 *
 * P4 gives the cadence per class, and the reasons are all about *when the
 * number exists*, not about load:
 *
 *   · **Mutual funds** — once daily after 23:00 IST, because AMFI publishes
 *     NAVs at end of day. Asking at noon gets yesterday's.
 *   · **Equities** — once daily after the relevant market closes.
 *   · **FX** — once daily after 18:30 IST; the ECB publishes around 16:00 CET.
 *   · **Manual assets** — never (R26.6).
 *
 * The rest of the section is about not being a bad citizen: P5's jitter,
 * exponential backoff and a self-enforced daily ceiling; P8's rule that only a
 * symbol goes out, never a holding or a quantity; P9's requirement that all of
 * this can be switched off and the app still works.
 *
 * Nothing here is allowed to fail loudly. A price that could not be fetched
 * leaves the last one in place with its date shown (FW9) — a stale number the
 * user can see is stale beats a blank where a number should be.
 */

import type { DB } from "../db/db.ts";
import { queryAll, queryOne, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { todayIST, nowIST, type IsoDate } from "../core/dates.ts";
import { recordPrice, recordFxRate, listInstruments, listHoldings } from "../domain/assets.ts";
import {
  PROVIDERS, quotaFor, jitterMs, backoffMs, fetchFxRate,
  type Provider, type PriceOutcome, type ProviderName,
} from "./providers.ts";

export type PriceClass = "mutual-fund" | "equity" | "fx" | "manual";

/** P4's table, as code. Hours are IST, because every cadence in it is. */
export const REFRESH_AFTER_HOUR: Record<PriceClass, number | null> = {
  "mutual-fund": 23,
  equity: 16,
  fx: 19,
  manual: null,
};

/** The hour in IST, from an instant. */
export function istHour(now: Date = new Date()): number {
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60_000);
  return ist.getUTCHours();
}

/**
 * P4 · Is this class due?
 *
 * "Once daily after HH:00" means two things at once — it is past the hour, and
 * it has not already run today. Both matter: without the first the number is
 * yesterday's, and without the second a six-hourly housekeeping tick would
 * fetch four times an evening.
 */
export function isDue(
  cls: PriceClass, lastRun: IsoDate | null, now: Date = new Date(),
): boolean {
  const hour = REFRESH_AFTER_HOUR[cls];
  if (hour === null) return false;
  if (istHour(now) < hour) return false;

  const today = todayIST(now);
  return lastRun !== today;
}

export interface RefreshOutcome {
  attempted: number;
  updated: number;
  failed: number;
  skipped: number;
  /** P6 · Shown wherever a manual refresh is offered. */
  quota: ReturnType<typeof quotaFor>[];
  notes: string[];
}

export interface RefreshOptions {
  fetchImpl?: typeof fetch;
  alphaVantageKey?: string | null;
  now?: Date;
  /** Ignore the cadence. What the manual refresh button passes (P6). */
  force?: boolean;
  /** Deterministic in tests. */
  random?: () => number;
  /** Injected so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Refresh what is due.
 *
 * Only instruments that are actually held: a scheme sold two years ago does
 * not need today's NAV, and fetching it spends a quota that a held instrument
 * might need.
 */
export async function refreshPrices(
  db: DB, actor: Actor, opts: RefreshOptions = {},
): Promise<RefreshOutcome> {
  const now = opts.now ?? new Date();
  const today = todayIST(now);
  const outcome: RefreshOutcome = {
    attempted: 0, updated: 0, failed: 0, skipped: 0, quota: [], notes: [],
  };

  const heldInstrumentIds = new Set(listHoldings(db).map((h) => h.instrument_id));
  const instruments = listInstruments(db).filter((i) => heldInstrumentIds.has(i.id));

  // P5 · The ceiling is per provider per day, counted from our own log rather
  // than inferred from being throttled.
  const usedToday = new Map<ProviderName, number>();
  for (const row of queryAll<{ provider: string; n: number }>(
    db,
    `SELECT provider, COUNT(*) AS n FROM price_fetches
      WHERE substr(requested_at, 1, 10) = ? GROUP BY provider`,
    today,
  )) {
    usedToday.set(row.provider as ProviderName, row.n);
  }

  for (const instrument of instruments) {
    // R26.6 · An instrument pinned to manual is never fetched, and neither is
    // one whose refresh is set to never.
    if (instrument.manual_only || instrument.refresh === "never") {
      outcome.skipped++;
      continue;
    }

    const cls: PriceClass = instrument.kind === "equity" || instrument.kind === "etf"
      ? "equity"
      : "mutual-fund";

    if (!opts.force && !isDue(cls, lastRunFor(db, cls), now)) {
      outcome.skipped++;
      continue;
    }

    const provider = providerFor(instrument.provider);
    if (!provider) {
      outcome.skipped++;
      continue;
    }

    const used = usedToday.get(provider.name) ?? 0;
    const quota = quotaFor(provider, used);
    if (quota.exhausted) {
      outcome.skipped++;
      outcome.notes.push(
        `${provider.name} has used its ${quota.ceiling} calls for today. ` +
        `Prices already fetched are unaffected.`,
      );
      continue;
    }

    // P8 · Only a symbol goes out. Never a holding, a quantity, or anything
    // identifying the household.
    const symbol = provider.name === "amfi" ? instrument.isin : instrument.symbol;
    if (!symbol) {
      outcome.skipped++;
      continue;
    }

    // P5 · Jitter, so a portfolio's worth of refreshes is not a burst.
    await (opts.sleep ?? defaultSleep)(jitterMs(opts.random));

    outcome.attempted++;
    usedToday.set(provider.name, used + 1);

    const result = await attempt(db, provider, symbol, opts);
    logFetch(db, instrument.id, provider.name, result);

    if (result.ok) {
      recordPrice(db, {
        instrumentId: instrument.id,
        price: result.price,
        asOf: result.asOf,
        source: result.source,
      });
      outcome.updated++;
    } else {
      outcome.failed++;
      // FW9 · The old price stays, with its date shown. A stale number the
      // user can see is stale beats a blank where a number should be.
      outcome.notes.push(`${instrument.name}: ${result.message}`);
    }
  }

  // FX, if anything needs it. Q18 means this household has no foreign account,
  // but USD card charges still need a rate (R33.1).
  if (opts.force || isDue("fx", lastRunFor(db, "fx"), now)) {
    await refreshFx(db, actor, opts, outcome);
  }

  for (const provider of Object.values(PROVIDERS)) {
    outcome.quota.push(quotaFor(provider, usedToday.get(provider.name) ?? 0));
  }

  return outcome;
}

/**
 * `10` §3.3 · MFAPI first, AMFI on failure.
 *
 * MFAPI is a wrapper over AMFI and can vanish without notice. Falling through
 * on *unavailable* but not on *not-found* is deliberate: a scheme MFAPI has
 * never heard of will not be in AMFI's file either, and retrying would only
 * spend a second call to learn the same thing.
 */
async function attempt(
  db: DB, provider: Provider, symbol: string, opts: RefreshOptions,
): Promise<PriceOutcome> {
  const fetchOpts = {
    fetchImpl: opts.fetchImpl,
    apiKey: provider.name === "alphavantage" ? opts.alphaVantageKey : null,
  };

  let result = await provider.fetchPrice(symbol, fetchOpts);

  if (!result.ok && result.reason === "unavailable" && provider.name === "mfapi") {
    const instrument = queryOne<{ isin: string | null }>(
      db, `SELECT isin FROM instruments WHERE symbol = ? AND provider = 'mfapi'`, symbol,
    );
    if (instrument?.isin) {
      // P5 · Back off before the second try, so an outage is not hammered.
      await (opts.sleep ?? defaultSleep)(backoffMs(1));
      const fallback = await PROVIDERS.amfi!.fetchPrice(instrument.isin, fetchOpts);
      if (fallback.ok) result = fallback;
    }
  }

  return result;
}

async function refreshFx(
  db: DB, actor: Actor, opts: RefreshOptions, outcome: RefreshOutcome,
): Promise<void> {
  const pairs = queryAll<{ currency: string }>(
    db,
    `SELECT DISTINCT currency FROM instruments WHERE currency <> 'INR'
     UNION
     SELECT DISTINCT currency FROM accounts WHERE currency <> 'INR' AND closed_at IS NULL`,
  );
  if (pairs.length === 0) return;

  for (const pair of pairs) {
    outcome.attempted++;
    const rate = await fetchFxRate(pair.currency, "INR", { fetchImpl: opts.fetchImpl });
    logFetch(db, null, "frankfurter", rate);

    if (rate.ok) {
      recordFxRate(db, {
        base: pair.currency, quote: "INR",
        // The provider interface speaks micro-rupees; fx_rates stores a plain
        // multiplier.
        rate: rate.price / 1_000_000,
        asOf: rate.asOf, source: "frankfurter",
      });
      outcome.updated++;
    } else {
      outcome.failed++;
      outcome.notes.push(`${pair.currency}→INR: ${rate.message}`);
    }
  }
  void actor;
}

function providerFor(name: string): Provider | null {
  return PROVIDERS[name] ?? null;
}

/** The last date this class was fetched at all. */
function lastRunFor(db: DB, cls: PriceClass): IsoDate | null {
  const row = queryOne<{ day: string }>(
    db,
    `SELECT MAX(substr(requested_at, 1, 10)) AS day FROM price_fetches
      WHERE class = ? AND status = 'ok'`,
    cls,
  );
  return (row?.day as IsoDate) ?? null;
}

/**
 * P3 · "Every fetch MUST record: instrument, provider, request time, response
 * status, and the price returned. This log is what makes a bad number
 * explainable three months later."
 */
function logFetch(
  db: DB, instrumentId: string | null, provider: ProviderName, result: PriceOutcome,
): void {
  const cls: PriceClass = provider === "frankfurter" ? "fx"
    : provider === "alphavantage" ? "equity" : "mutual-fund";

  execute(
    db,
    `INSERT INTO price_fetches (instrument_id, provider, class, requested_at, status, price, as_of, detail)
     VALUES (?,?,?,?,?,?,?,?)`,
    instrumentId, provider, cls, nowIST(),
    result.ok ? "ok" : result.reason,
    result.ok ? result.price : null,
    result.ok ? result.asOf : null,
    result.ok ? null : result.message,
  );
}
