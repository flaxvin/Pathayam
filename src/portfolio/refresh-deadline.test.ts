/**
 * EXTRA-5 · The refresh button answers in bounded time.
 *
 * With every provider unreachable, each held scheme cost up to 30 s of jitter,
 * a 10 s MFAPI timeout, a 2 s backoff and a 30 s AMFI timeout: POST
 * /portfolio/refresh sat for about a minute a scheme. The manual refresh now
 * gives each request a few seconds, the whole run twelve, and reports what it
 * did not reach. No network here: every fetch is a stub.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { createAssetAccount, findOrCreateInstrument, recordPurchase } from "../domain/assets.ts";
import { clearAmfiCache } from "./providers.ts";
import { refreshPrices, MANUAL_REFRESH } from "./refresh.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };
const noSleep = async () => {};

/** `count` held schemes, each with an MFAPI code and an ISIN for the AMFI fallback. */
function holdings(db: DB, count: number) {
  const account = createAssetAccount(db, actor, {
    name: "ZZ Mutual funds", subtype: "investment", openingDate: "2026-04-01",
  });
  for (let i = 0; i < count; i++) {
    const instrument = findOrCreateInstrument(db, actor, {
      name: `ZZ Fund ${i}`, kind: "mutual-fund", provider: "mfapi",
      symbol: String(900000 + i), isin: `INF000Z${String(i).padStart(4, "0")}9`,
    });
    recordPurchase(db, actor, {
      accountId: account.id, instrumentId: instrument.id, tradeDate: "2026-04-05",
      price: 10_000_000, units: 100_000,
    });
  }
}

function setup(count: number) {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m-ravi", "ravi@example.com", "Ravi", nowIST());
  holdings(db, count);
  clearAmfiCache();
  return db;
}

/** A provider that never answers: the request hangs until it is aborted. */
const hang: typeof fetch = (_url, init) => new Promise((_, reject) => {
  init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
});

describe("EXTRA-5 · a bounded manual refresh", () => {
  test("hanging providers are abandoned at the timeout, and the run stops at its deadline", { timeout: 5_000 }, async () => {
    const db = setup(10);
    const started = Date.now();
    const outcome = await refreshPrices(db, actor, {
      force: true, fetchImpl: hang, sleep: noSleep, random: () => 0.5,
      timeoutMs: 40, deadlineMs: 200, jitterMaxMs: 0,
    });
    const took = Date.now() - started;

    assert.ok(took < 1_000, `took ${took} ms`);
    assert.equal(outcome.updated, 0);
    assert.ok(outcome.attempted >= 1);
    assert.ok(outcome.unfinished > 0, "the schemes it did not reach are counted");
    assert.equal(outcome.attempted + outcome.unfinished, 10);
    assert.ok(outcome.notes.some((n) => /Stopped before \d+ prices/.test(n)));
    db.close();
  });

  test("the deadline is honoured on a moved clock: timeouts, the fallback and the jitter all fit inside it", async () => {
    const db = setup(3);
    let now = 0;
    const timeouts: number[] = [];
    const sleeps: number[] = [];
    // Each request hangs until the provider aborts it (after the real 20 ms
    // timeout), and is booked on the test's clock as five seconds gone.
    const slow: typeof fetch = async (_url, init) => {
      const signal = init?.signal as AbortSignal;
      const waited = await new Promise<number>((resolve) => {
        const t0 = Date.now();
        signal.addEventListener("abort", () => resolve(Date.now() - t0));
      });
      timeouts.push(waited);
      now += 5_000;
      throw new Error("aborted");
    };
    const outcome = await refreshPrices(db, actor, {
      force: true, fetchImpl: slow, random: () => 1,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
      clock: () => now, timeoutMs: 20, deadlineMs: 12_000, jitterMaxMs: 250,
    });
    // Fund 0: MFAPI (5 s), backoff, AMFI (5 s) → 12,250 ms gone, past the deadline.
    // Funds 1 and 2 are not tried.
    assert.equal(outcome.attempted, 1);
    assert.equal(outcome.unfinished, 2);
    assert.ok(sleeps.every((ms) => ms <= 2_000), `slept ${sleeps.join(", ")}`);
    assert.equal(timeouts.length, 2, "MFAPI and the AMFI fallback, once each");
    db.close();
  });

  test("the route reports what was fetched, what failed and what it ran out of time for", { timeout: 10_000 }, async () => {
    assert.ok(MANUAL_REFRESH.deadlineMs <= 15_000 && MANUAL_REFRESH.timeoutMs <= 5_000);
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    holdings(db, 1);
    clearAmfiCache();
    const refused: typeof fetch = async () => { throw new Error("unreachable"); };
    const app = await startTestApp(db, { memberId: "m-ravi", fetchImpl: refused });
    try {
      const res = await app.post("/portfolio/refresh", {});
      assert.equal(res.status, 303);
      const notice = decodeURIComponent(res.headers.get("location") ?? "").replace(/\+/g, " ");
      assert.match(notice, /Refreshed 0\. 1 couldn't be fetched — cached prices are still shown/);
    } finally {
      await app.close();
    }
  });
});
