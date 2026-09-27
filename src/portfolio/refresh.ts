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
import { Refusal } from "../core/refusal.ts";
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
  /** EXTRA-5 · Due, but not tried: the run's time was up. Their cached prices stay. */
  unfinished: number;
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
  /** EXTRA-5 · How long one request may take before it is abandoned. */
  timeoutMs?: number;
  /** EXTRA-5 · How long the whole run may take; what is left over is reported, not tried. */
  deadlineMs?: number;
  /** EXTRA-5 · The most P5's jitter may wait before each fetch. */
  jitterMaxMs?: number;
  /** Injected so tests can move time without waiting for it. */
  clock?: () => number;
}

/*
 * EXTRA-5 · The refresh button waits for its answer.
 *
 * With every provider unreachable, each held scheme cost up to 30 seconds of
 * jitter, a 10-second MFAPI timeout, a 2-second backoff and a 30-second AMFI
 * timeout — about a minute a scheme, in a request the household is watching
 * spin. The scheduled run can take its time; the button cannot. It asks each
 * provider for a few seconds at most, stops trying once twelve have gone, and
 * reports what it did not get to. The jitter stays, small: P5's burst is a
 * fleet of scheduled refreshes, not one person pressing a button.
 */
export const MANUAL_REFRESH = { timeoutMs: 4_000, deadlineMs: 12_000, jitterMaxMs: 250 } as const;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The time a run has left, and the timeout a request may use within it. */
interface Budget {
  left(): number;
  timeoutMs(): number | undefined;
}

function budgetFor(opts: RefreshOptions): Budget {
  const clock = opts.clock ?? Date.now;
  const deadline = opts.deadlineMs !== undefined ? clock() + opts.deadlineMs : Infinity;
  const left = () => deadline - clock();
  return {
    left,
    timeoutMs: () => {
      if (opts.timeoutMs === undefined && deadline === Infinity) return undefined;
      return Math.max(1, Math.min(opts.timeoutMs ?? Infinity, left()));
    },
  };
}

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
    attempted: 0, updated: 0, failed: 0, skipped: 0, unfinished: 0, quota: [], notes: [],
  };
  const budget = budgetFor(opts);

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

    // EXTRA-5 · Out of time: not tried, and said so. The cached price stays.
    if (budget.left() <= 0) {
      outcome.unfinished++;
      continue;
    }

    // P5 · Jitter, so a portfolio's worth of refreshes is not a burst.
    await (opts.sleep ?? defaultSleep)(
      Math.min(jitterMs(opts.random, opts.jitterMaxMs), Math.max(0, budget.left())),
    );

    outcome.attempted++;
    usedToday.set(provider.name, used + 1);

    const result = await attempt(db, provider, symbol, opts, budget);
    logFetch(db, instrument.id, provider.name, result);

    if (result.ok) {
      try {
        recordPrice(db, {
          instrumentId: instrument.id,
          price: result.price,
          asOf: result.asOf,
          source: result.source,
        });
        outcome.updated++;
      } catch (err) {
        // WEALTH-39 · recordPrice refuses a price of zero or less, or an absurd
        // one; a feed that sends one is a failed fetch, not the end of the run.
        if (!(err instanceof Refusal)) throw err;
        outcome.failed++;
        outcome.notes.push(`${instrument.name}: the feed sent a price that cannot be right.`);
      }
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
    await refreshFx(db, actor, opts, outcome, budget);
  }

  if (outcome.unfinished > 0) {
    outcome.notes.push(
      `Stopped before ${outcome.unfinished} ${outcome.unfinished === 1 ? "price" : "prices"}: ` +
      `the providers were too slow to answer. Their cached prices are still shown.`,
    );
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
  db: DB, provider: Provider, symbol: string, opts: RefreshOptions, budget: Budget,
): Promise<PriceOutcome> {
  const fetchOpts = () => ({
    fetchImpl: opts.fetchImpl,
    apiKey: provider.name === "alphavantage" ? opts.alphaVantageKey : null,
    timeoutMs: budget.timeoutMs(),
  });

  let result = await provider.fetchPrice(symbol, fetchOpts());

  // EXTRA-5 · The fallback is a second wait; only if the backoff leaves time for it.
  if (!result.ok && result.reason === "unavailable" && provider.name === "mfapi" &&
      budget.left() > backoffMs(1)) {
    const instrument = queryOne<{ isin: string | null }>(
      db, `SELECT isin FROM instruments WHERE symbol = ? AND provider = 'mfapi'`, symbol,
    );
    if (instrument?.isin) {
      // P5 · Back off before the second try, so an outage is not hammered.
      await (opts.sleep ?? defaultSleep)(backoffMs(1));
      const fallback = await PROVIDERS.amfi!.fetchPrice(instrument.isin, fetchOpts());
      if (fallback.ok) result = fallback;
    }
  }

  return result;
}

async function refreshFx(
  db: DB, actor: Actor, opts: RefreshOptions, outcome: RefreshOutcome, budget: Budget,
): Promise<void> {
  const pairs = queryAll<{ currency: string }>(
    db,
    `SELECT DISTINCT currency FROM instruments WHERE currency <> 'INR'
     UNION
     SELECT DISTINCT currency FROM accounts WHERE currency <> 'INR' AND closed_at IS NULL`,
  );
  if (pairs.length === 0) return;

  for (const pair of pairs) {
    if (budget.left() <= 0) {
      outcome.unfinished++;
      continue;
    }
    outcome.attempted++;
    const rate = await fetchFxRate(pair.currency, "INR", { fetchImpl: opts.fetchImpl, timeoutMs: budget.timeoutMs() });
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
