/**
 * Weekly 18-11 #5 · Prices refresh every night at 00:00 IST on every
 * instance, the demo included; the Refresh button fetches at most once every
 * five minutes, and on the demo not at all. No network: every fetch is a stub
 * and the clock is moved by hand.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { createAssetAccount, findOrCreateInstrument, recordPurchase, latestPrice } from "../domain/assets.ts";
import { clearAmfiCache } from "./providers.ts";
import { clearBhavcopyCache, priceFromBhavcopy, bhavcopyDownloadsToday, LIMITS } from "./bhavcopy.ts";
import { nextIstMidnight, everyIstMidnight, nightlyPriceRefresh } from "./nightly.ts";
import { DEMO_REFRESH_NOTICE, refreshPrices } from "./refresh.ts";
import { execute } from "../db/db.ts";
import { freshDb, seedMember, startTestApp, testConfig } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function fund(db: DB) {
  const account = createAssetAccount(db, actor, {
    name: "Mutual funds", subtype: "investment", openingDate: "2026-04-01",
  });
  const instrument = findOrCreateInstrument(db, actor, {
    name: "Fund 119063", kind: "mutual-fund", provider: "mfapi", symbol: "119063", isin: "INF179K01XQ0",
  });
  recordPurchase(db, actor, {
    accountId: account.id, instrumentId: instrument.id, tradeDate: "2026-04-05",
    price: 80_000_000, units: 312_500,
  });
  return instrument;
}

function share(db: DB) {
  const account = createAssetAccount(db, actor, {
    name: "Demat", subtype: "investment", openingDate: "2026-04-01",
  });
  const instrument = findOrCreateInstrument(db, actor, {
    name: "Reliance", kind: "equity", provider: "manual", symbol: "RELIANCE", isin: "INE002A01018",
  });
  recordPurchase(db, actor, {
    accountId: account.id, instrumentId: instrument.id, tradeDate: "2026-04-05",
    price: 1_200_000_000, units: 10_000_000,
  });
  return instrument;
}

/** MFAPI answering every scheme with one NAV, counting every request. */
function countingMfapi() {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return {
      ok: true, status: 200,
      json: async () => ({ status: "SUCCESS", data: [{ date: "20-11-2026", nav: "86.40000" }] }),
      text: async () => "",
      headers: new Headers(),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const assetsOn = { features: { assets: true }, alphaVantageKey: null, bhavcopyPrices: true } as never;
const assetsOff = { features: { assets: false }, alphaVantageKey: null, bhavcopyPrices: true } as never;

describe("weekly 18-11 #5 · the nightly refresh is at 00:00 IST, not UTC", () => {
  test("the next IST midnight is 18:30 UTC", () => {
    assert.equal(nextIstMidnight(new Date("2026-11-21T12:00:00Z")).toISOString(), "2026-11-21T18:30:00.000Z");
    assert.equal(nextIstMidnight(new Date("2026-11-21T18:29:59Z")).toISOString(), "2026-11-21T18:30:00.000Z");
    // At midnight itself, the next one is a day on.
    assert.equal(nextIstMidnight(new Date("2026-11-21T18:30:00Z")).toISOString(), "2026-11-22T18:30:00.000Z");
    // UTC midnight is 05:30 IST: the next IST midnight is that evening.
    assert.equal(nextIstMidnight(new Date("2026-11-22T00:00:00Z")).toISOString(), "2026-11-22T18:30:00.000Z");
    // The year turns at IST midnight too.
    assert.equal(nextIstMidnight(new Date("2026-12-31T20:00:00Z")).toISOString(), "2027-01-01T18:30:00.000Z");
  });

  test("the timer fires at 00:00 IST, once a night, and not when woken early", () => {
    let now = new Date("2026-11-21T12:00:00Z"); // 17:30 IST
    const armed: { fn: () => void; ms: number }[] = [];
    const runs: string[] = [];
    const timer = everyIstMidnight(() => runs.push(now.toISOString()), {
      now: () => now,
      setTimer: (fn, ms) => { armed.push({ fn, ms }); return armed.length; },
      clearTimer: () => {},
    });

    assert.equal(armed.at(-1)!.ms, 6.5 * HOUR, "six and a half hours to 00:00 IST, not twelve to 00:00 UTC");

    // A timer that wakes a second early waits out the second and does not run.
    now = new Date("2026-11-21T18:29:59Z");
    armed.at(-1)!.fn();
    assert.deepEqual(runs, []);
    assert.equal(armed.at(-1)!.ms, 1000);

    now = new Date("2026-11-21T18:30:00Z");
    armed.at(-1)!.fn();
    assert.deepEqual(runs, ["2026-11-21T18:30:00.000Z"]);
    assert.equal(armed.at(-1)!.ms, 24 * HOUR, "then the next night");

    // A machine suspended past the next midnight runs once on waking, then
    // goes back to midnights.
    now = new Date("2026-11-23T03:00:00Z");
    armed.at(-1)!.fn();
    assert.equal(runs.length, 2);
    assert.equal(armed.at(-1)!.ms, 15.5 * HOUR);

    const before = armed.length;
    timer.stop();
    armed.at(-1)!.fn();
    assert.equal(runs.length, 2, "nothing after stop");
    assert.equal(armed.length, before);
  });

  test("at midnight it fetches every held price, though nothing is due by the evening cadence", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const instrument = fund(db);
    clearAmfiCache();
    const { impl, calls } = countingMfapi();
    const midnight = new Date("2026-11-21T18:30:00Z"); // 00:00 IST, 22-11-2026
    const outcome = await nightlyPriceRefresh(db, assetsOn, { fetchImpl: impl, now: midnight, sleep: async () => {}, random: () => 0 });
    assert.ok(outcome);
    assert.equal(outcome.updated, 1, outcome.notes.join("; "));
    assert.equal(calls.length, 1);
    assert.equal(latestPrice(db, instrument.id)?.price, 86_400_000);
    db.close();
  });

  test("weekly 25-11 · the midnight run does not stand in for that evening's run after the NAVs are out", async () => {
    // The 00:00 run fetched the day before's NAV; it logged its fetch under
    // the new day, which the six-hourly tick read as "funds already done
    // today" — so the 23:00 cadence never ran again, on any instance.
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    fund(db);
    clearAmfiCache();
    const { impl, calls } = countingMfapi();
    const midnight = new Date("2026-11-21T18:30:00Z"); // 00:00 IST, 22-11-2026
    await nightlyPriceRefresh(db, assetsOn, { fetchImpl: impl, now: midnight, sleep: async () => {}, random: () => 0 });
    assert.equal(calls.length, 1);
    // As the live clock would have logged it.
    execute(db, `UPDATE price_fetches SET requested_at = '2026-11-22T00:00:04.000+05:30'`);

    const evening = new Date("2026-11-22T18:00:00Z"); // 23:30 IST, 22-11-2026
    const tick = await refreshPrices(db, { memberId: null, source: "job" }, {
      fetchImpl: impl, now: evening, sleep: async () => {}, random: () => 0,
    });
    assert.equal(tick.attempted, 1, "the evening's NAV is fetched");
    assert.equal(calls.length, 2);

    // And it still runs only once an evening.
    execute(db, `UPDATE price_fetches SET requested_at = '2026-11-22T23:30:02.000+05:30' WHERE id = (SELECT MAX(id) FROM price_fetches)`);
    const again = await refreshPrices(db, { memberId: null, source: "job" }, {
      fetchImpl: impl, now: new Date("2026-11-22T18:20:00Z"), sleep: async () => {}, random: () => 0,
    });
    assert.equal(again.attempted, 0);
    db.close();
  });

  test("with FEATURE_ASSETS off it fetches nothing", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    fund(db);
    const { impl, calls } = countingMfapi();
    assert.equal(await nightlyPriceRefresh(db, assetsOff, { fetchImpl: impl }), null);
    assert.equal(calls.length, 0);
    db.close();
  });

  test("it keeps to the exchanges' twelve-a-day download ceiling", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    share(db);
    clearBhavcopyCache();
    const midnight = new Date("2026-11-21T18:30:10Z");
    // Twelve earlier failed downloads per exchange that IST day use up the ceiling.
    const down = (async () => new Response("down", { status: 500 })) as typeof fetch;
    for (let i = 0; i < LIMITS.dailyDownloads; i++) {
      await priceFromBhavcopy("INE002A01018", null, { fetchImpl: down, now: midnight });
    }
    assert.equal(bhavcopyDownloadsToday("NSE", midnight), LIMITS.dailyDownloads);

    const calls: string[] = [];
    const counting = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("down", { status: 500 });
    }) as typeof fetch;
    const outcome = await nightlyPriceRefresh(db, assetsOn, { fetchImpl: counting, now: midnight, sleep: async () => {}, random: () => 0 });
    assert.ok(outcome);
    assert.equal(calls.length, 0, "no download past the ceiling");
    assert.equal(outcome.updated, 0);
    clearBhavcopyCache();
    db.close();
  });
});

describe("weekly 18-11 #5 · the Refresh button", () => {
  function notice(res: Response): string {
    return decodeURIComponent((res.headers.get("location") ?? "").replace(/\+/g, " "));
  }

  test("on the demo it fetches nothing and says prices come from the midnight run", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    fund(db);
    clearAmfiCache();
    const { impl, calls } = countingMfapi();
    const app = await startTestApp(db, { memberId: "m-ravi", fetchImpl: impl, config: testConfig({ demoMode: true }) });
    try {
      for (let i = 0; i < 3; i++) {
        const res = await app.post("/portfolio/refresh", {});
        assert.equal(res.status, 303);
        assert.ok(notice(res).includes(DEMO_REFRESH_NOTICE), notice(res));
      }
      assert.equal(calls.length, 0);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
      db.close();
    }
  });

  test("a household's second press inside five minutes fetches nothing and says when it may be pressed again", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    fund(db);
    clearAmfiCache();
    const { impl, calls } = countingMfapi();
    let now = new Date();
    const app = await startTestApp(db, { memberId: "m-ravi", fetchImpl: impl, clock: () => now });
    try {
      const first = await app.post("/portfolio/refresh", {});
      assert.match(notice(first), /Refreshed 1 prices\./);
      assert.equal(calls.length, 1);

      now = new Date(now.getTime() + 2 * MINUTE + 5_000);
      const second = await app.post("/portfolio/refresh", {});
      assert.equal(second.status, 303);
      assert.match(notice(second), /Prices were refreshed 2 minutes ago, at \d\d:\d\d/);
      assert.match(notice(second), /at most once every five minutes.*can be used again from \d\d:\d\d\./);
      assert.equal(calls.length, 1, "nothing fetched");

      now = new Date(now.getTime() + 3 * MINUTE);
      const third = await app.post("/portfolio/refresh", {});
      assert.match(notice(third), /Refreshed 1 prices\./);
      assert.equal(calls.length, 2);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
      db.close();
    }
  });

  test("the five minutes hold across a restart, from the event log", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    fund(db);
    clearAmfiCache();
    const { impl, calls } = countingMfapi();
    const first = await startTestApp(db, { memberId: "m-ravi", fetchImpl: impl });
    await first.post("/portfolio/refresh", {});
    await first.close();
    assert.equal(calls.length, 1);

    const second = await startTestApp(db, { memberId: "m-ravi", fetchImpl: impl });
    try {
      const res = await second.post("/portfolio/refresh", {});
      assert.match(notice(res), /Prices were refreshed less than a minute ago/);
      assert.equal(calls.length, 1);
    } finally {
      await second.close();
      db.close();
    }
  });
});
