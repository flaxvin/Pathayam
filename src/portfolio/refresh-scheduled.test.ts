/**
 * `07` P4 · The scheduled refresh fetches every held fund, not the first.
 *
 * Whether a class was due was asked again for each instrument, from the fetch
 * log — and the first fund's successful fetch was in that log by the time the
 * second was asked about. "Already ran today", so every fund after the first
 * was skipped, every night: a household with five funds saw one NAV move and
 * four stay where they were, unannounced.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST } from "../core/dates.ts";
import { createAssetAccount, findOrCreateInstrument, recordPurchase, latestPrice } from "../domain/assets.ts";
import { refreshPrices } from "./refresh.ts";

const actor: Actor = { memberId: "m-ravi", source: "job" };

describe("07 P4 · the scheduled refresh", () => {
  test("fetches every held fund that is due, not just the first", async () => {
    const db = openDatabase({ path: ":memory:", verbose: false });
    ensureHousehold(db);
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
      "m-ravi", "ravi@example.com", "Ravi", nowIST());
    const account = createAssetAccount(db, actor, {
      name: "Mutual funds", subtype: "investment", openingDate: "2026-04-01",
    });
    const funds = [["119063", "INF179K01XQ0"], ["135762", "INF846K01WO1"]].map(([symbol, isin]) => {
      const instrument = findOrCreateInstrument(db, actor, {
        name: `Fund ${symbol}`, kind: "mutual-fund", provider: "mfapi", symbol, isin,
      });
      recordPurchase(db, actor, {
        accountId: account.id, instrumentId: instrument.id, tradeDate: "2026-04-05",
        price: 80_000_000, units: 312_500,
      });
      return instrument;
    });

    const impl = (async () => ({
      ok: true, status: 200,
      json: async () => ({ status: "SUCCESS", data: [{ date: "27-08-2026", nav: "86.40000" }] }),
      text: async () => "",
    }) as Response) as unknown as typeof fetch;

    // 23:30 IST today, by the same clock the fetch log is stamped with.
    const now = new Date(`${todayIST()}T18:00:00Z`);
    const outcome = await refreshPrices(db, actor, {
      fetchImpl: impl, now, sleep: async () => {}, random: () => 0,
    });

    assert.equal(outcome.updated, 2, outcome.notes.join("; "));
    for (const fund of funds) assert.equal(latestPrice(db, fund.id)?.price, 86_400_000);
    db.close();
  });
});
