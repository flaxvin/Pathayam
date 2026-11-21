/**
 * Weekly 18-11 #5 · Every instance refreshes prices at 00:00 IST, the public
 * demo included.
 *
 * The six-hourly housekeeping tick keeps P4's per-class cadence (funds after
 * 23:00, shares after 18:00, FX after 19:00), but a tick lands wherever the
 * box's last restart put it. This run is pinned to the start of the IST day,
 * by which time the day's NAVs and both exchanges' closing files are out, so
 * every price on the screen in the morning is the previous day's close. On
 * the demo it is the only run visitors' Refresh button stands in for: the
 * button there serves what this fetched and makes no request of its own.
 *
 * It is scheduled the way housekeeping is — an in-process timer, because the
 * deployment is one box (Q8) — and it is still a refresh like any other: it
 * skips the cadence (nothing is "due" at midnight by P4's hours) but never
 * P5's ceilings, so the exchanges' twelve-a-day download limit and each
 * provider's daily cap hold, and with FEATURE_ASSETS off nothing is fetched.
 */

import type { DB } from "../db/db.ts";
import type { Config } from "../config.ts";
import { refreshPrices, type RefreshOutcome, type RefreshOptions } from "./refresh.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** The next 00:00 Asia/Kolkata strictly after `now`. India keeps no daylight saving. */
export function nextIstMidnight(now: Date): Date {
  const istMs = now.getTime() + IST_OFFSET_MS;
  const nextIstDay = (Math.floor(istMs / DAY_MS) + 1) * DAY_MS;
  return new Date(nextIstDay - IST_OFFSET_MS);
}

export interface DailyTimer {
  stop(): void;
}

export interface ScheduleOptions {
  now?: () => Date;
  /** Injected so tests can fire the timer without waiting a day. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Calls `run` at every 00:00 IST from now on. Each wait is worked out afresh
 * from the clock, so a timer that fires a little early or late, or a machine
 * that was suspended past midnight, never runs twice in one night nor drifts.
 */
export function everyIstMidnight(run: () => void, opts: ScheduleOptions = {}): DailyTimer {
  const now = opts.now ?? (() => new Date());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  });
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));

  let handle: unknown = null;
  let stopped = false;
  let target = nextIstMidnight(now());

  const arm = () => {
    handle = setTimer(fire, Math.max(0, target.getTime() - now().getTime()));
  };
  const fire = () => {
    if (stopped) return;
    // Fired early (timers are not exact): wait out the rest, do not run yet.
    if (now().getTime() < target.getTime()) { arm(); return; }
    try {
      run();
    } finally {
      target = nextIstMidnight(now());
      if (!stopped) arm();
    }
  };
  arm();
  return {
    stop() {
      stopped = true;
      if (handle !== null) clearTimer(handle);
    },
  };
}

/**
 * The midnight run itself. Null when the assets module is off: no outbound
 * call at all (F28).
 */
export async function nightlyPriceRefresh(
  db: DB, config: Pick<Config, "features" | "alphaVantageKey" | "bhavcopyPrices">,
  opts: Pick<RefreshOptions, "fetchImpl" | "now" | "sleep" | "random"> = {},
): Promise<RefreshOutcome | null> {
  if (!config.features.assets) return null;
  return refreshPrices(db, { memberId: null, source: "job" }, {
    force: true,
    alphaVantageKey: config.alphaVantageKey,
    bhavcopy: config.bhavcopyPrices,
    ...opts,
  });
}
