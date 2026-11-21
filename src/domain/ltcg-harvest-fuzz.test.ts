/**
 * HARVEST-1 · Property check: selling exactly what the hint suggests, through
 * the real sale path, realises the gain the hint said, and never takes the
 * member's s112A gains past the exemption.
 *
 * FUZZ_SEEDS raises the seed count.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale, recordPrice,
  listHoldings, classifyInstrument,
} from "./assets.ts";
import { units, price } from "../portfolio/holdings.ts";
import { capitalGainsTaxFor } from "./capital-gains-tax.ts";
import { ltcgHarvestHint } from "./ltcg-harvest.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";

const TODAY = "2026-11-14";
const ravi: Actor = { memberId: "m", source: "ui" };

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 40);

test(`HARVEST-1 fuzz: the suggested sale realises the suggested gain, within the exemption (${SEEDS} seeds)`, () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = rng(seed * 7919);
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    const bank = createAccount(db, ravi, {
      name: "Savings", kind: "budget", subtype: "savings",
      openingDate: "2015-01-01", openingBalance: rupees(1_000_000_000),
    }).id;
    const demat = createAssetAccount(db, ravi, {
      name: "Demat", subtype: "investment", holderMemberId: "m", visibility: "household",
    }).id;

    const instruments: string[] = [];
    const nInstr = 1 + Math.floor(r() * 3);
    for (let i = 0; i < nInstr; i++) {
      const kind = pick(["equity", "etf", "mutual-fund"] as const);
      const id = findOrCreateInstrument(db, ravi, {
        name: `Co ${seed}-${i}`, kind, symbol: `CO${seed}X${i}`, provider: "manual",
      }).id;
      if (kind === "mutual-fund") classifyInstrument(db, ravi, id, { assetClass: "equity" });
      instruments.push(id);
      const lots = 1 + Math.floor(r() * 4);
      const dates = Array.from({ length: lots }, () =>
        pick(["2023-03-15", "2024-02-29", "2025-01-31", "2025-11-13", "2025-11-14", "2025-11-15", "2026-05-01"]))
        .sort();
      for (const d of dates) {
        const qty = kind === "mutual-fund" ? Math.round(r() * 5_000_000) / 1000 + 0.001 : 1 + Math.floor(r() * 3_000);
        recordPurchase(db, ravi, {
          accountId: demat, instrumentId: id, tradeDate: d,
          price: price(Math.round((20 + r() * 400) * 100) / 100), units: units(qty), fromAccountId: bank,
        });
      }
      recordPrice(db, { instrumentId: id, price: price(Math.round((20 + r() * 600) * 10_000) / 10_000), asOf: "2026-11-13", source: "manual" });
    }
    // Some gain already realised this year, sometimes.
    if (r() < 0.5) {
      const id = findOrCreateInstrument(db, ravi, { name: `Sold ${seed}`, kind: "equity", symbol: `SOLD${seed}`, provider: "manual" }).id;
      recordPurchase(db, ravi, { accountId: demat, instrumentId: id, tradeDate: "2024-01-02", price: price(100), units: units(1_000), fromAccountId: bank });
      const h = listHoldings(db, demat).find((x) => x.instrument_id === id)!;
      recordSale(db, ravi, {
        holdingId: h.id, date: "2026-06-01", units: units(1_000),
        price: price(100 + Math.round(r() * 200 - 60)), toAccountId: bank,
      });
    }

    const before = capitalGainsTaxFor(db, 2026, "m");
    const hint = ltcgHarvestHint(db, "m", TODAY);
    assert.ok(hint.suggestedGain <= hint.unused, `seed ${seed}: suggested over unused`);
    for (const line of hint.lines) {
      if (line.suggestUnits <= 0) continue;
      assert.ok(line.suggestUnits <= line.longTermUnits, `seed ${seed}: suggests short-term units`);
      const at = Number(line.price);
      recordSale(db, ravi, {
        holdingId: line.holdingId, date: TODAY, units: line.suggestUnits,
        price: at as never, toAccountId: bank,
      });
    }
    const after = capitalGainsTaxFor(db, 2026, "m");
    const realisedBefore = before.buckets.equityLong;
    const realisedAfter = after.buckets.equityLong;
    // Rounding of each partial lot's cost may differ by a paisa per sale.
    const sales = hint.lines.filter((l) => l.suggestUnits > 0).length * 2;
    assert.ok(
      Math.abs((realisedAfter - realisedBefore) - hint.suggestedGain) <= sales,
      `seed ${seed}: realised moved ${realisedAfter - realisedBefore}, hint said ${hint.suggestedGain}`,
    );
    assert.ok(after.equityLongTax <= before.equityLongTax + sales, `seed ${seed}: harvest created tax ${before.equityLongTax} -> ${after.equityLongTax}`);
  }
});
