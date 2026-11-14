/**
 * HARVEST-1 · How much long-term equity gain could still be realised this
 * financial year inside the s112A exemption.
 *
 * Long-term gains on listed equity and equity-oriented fund units are exempt
 * up to an annual amount (₹1,25,000 from FY 2024-25; `GAINS_RULES` carries it
 * by year, and this reads it from there rather than keeping a second copy). An
 * exemption left unused on 31 March is gone. This sets, for one member:
 *
 *   - the 112A gain already realised this year, from the same computation the
 *     tax estimate uses (`capitalGainsTaxFor`), so the two never disagree;
 *   - the part of the exemption still unused;
 *   - each holding's lots that are long-term today, valued at the latest
 *     stored price, and a quantity whose sale would realise gain up to the
 *     unused part without crossing it.
 *
 * ## The quantity follows FIFO, because the sale would
 *
 * A sale here consumes lots oldest first (`previewSale`, R25.2; `lotsFor`
 * orders by trade date). The oldest lots are the longest held, so the
 * long-term lots are the front of the queue, and a suggestion is only ever a
 * prefix of the long-term lots — never so many units that the sale would reach
 * a short-term lot. A long-term lot standing at a loss is still consumed in
 * its turn (FIFO allows no skipping it), and its loss nets against the gain in
 * the same 112A head, as the gains engine nets it.
 *
 * Shares and ETFs are suggested in whole units; fund units to three decimals.
 *
 * ## What it will not suggest
 *
 * Only what s112A covers: an instrument classed equity, listed, priced in
 * rupees, and not international. Unlisted shares, hybrid funds (the app does
 * not track the equity ratio), international holdings, anything with no
 * price, and a pre-2018 lot with no 31 January 2018 price, are listed as
 * excluded with the reason, never guessed at. Exit loads, STT and brokerage
 * are not in the figures, and loss set-off between heads is not modelled
 * (docs/limitations.md). It is arithmetic, not advice.
 */

import type { DB } from "../db/db.ts";
import { queryAll } from "../db/db.ts";
import type { Paise } from "../core/money.ts";
import type { IsoDate } from "../core/dates.ts";
import { addDays, daysBetween, fiscalYearOf, fiscalYearRange, heldMoreThanMonths, todayIST } from "../core/dates.ts";
import type { Lot, Milliunits, MicroRupees } from "../portfolio/holdings.ts";
import { UNIT_SCALE, valueOf } from "../portfolio/holdings.ts";
import { latestPrice, lotsFor } from "./assets.ts";
import {
  GRANDFATHERED_BEFORE, capitalGainsTaxFor, gainsRulesOn, grandfatheredValue,
} from "./capital-gains-tax.ts";

export interface HarvestLine {
  holdingId: string;
  instrumentId: string;
  instrument: string;
  accountName: string;
  kind: string;
  price: MicroRupees;
  priceAsOf: IsoDate;
  priceStale: boolean;
  unitsHeld: Milliunits;
  /** Units in lots held more than the 112A period today. */
  longTermUnits: Milliunits;
  /** Cost of those units (grandfathered where the lot predates 1 February 2018). */
  longTermCost: Paise;
  longTermValue: Paise;
  /** Unrealised 112A gain if every long-term unit were sold at `price`. */
  longTermGain: Paise;
  /** Units still short-term; a sale never reaches them before the long-term ones. */
  shortTermUnits: Milliunits;
  /** When the oldest short-term lot turns long-term, if there is one. */
  nextLongTermOn: IsoDate | null;
  /** Units to sell, FIFO, so this holding's gain stays within what is left. */
  suggestUnits: Milliunits;
  suggestGain: Paise;
  suggestProceeds: Paise;
}

export interface HarvestExcluded {
  instrument: string;
  accountName: string;
  reason: string;
}

export interface HarvestHint {
  fy: number;
  today: IsoDate;
  fyEnd: IsoDate;
  /** Calendar days from today to 31 March. Whether those are trading days is not checked. */
  daysLeft: number;
  /** Months held, "more than", before listed equity is long-term. */
  longTermMonths: number;
  exemption: Paise;
  /** s112A gain realised so far this year, losses within the head netted. */
  realised: Paise;
  unused: Paise;
  /** Gains this year the engine could not place; some may be 112A. */
  unplaced: Paise;
  lines: HarvestLine[];
  excluded: HarvestExcluded[];
  /** All suggestions together; never more than `unused`. */
  suggestedGain: Paise;
}

interface Row {
  holding_id: string; instrument_id: string; instrument: string; kind: string;
  asset_class: string | null; region: string | null; currency: string; listed: number | null;
  account_name: string; holder: string | null;
}

/** A sale of `taken` units of `lot` at `px` today: proceeds, cost and gain, or null if the cost cannot be known. */
function partOf(
  db: DB, instrumentId: string, lot: Lot, taken: Milliunits, px: MicroRupees, today: IsoDate,
): { proceeds: Paise; cost: Paise; gain: Paise } | null {
  const proceeds = valueOf(taken, px) as Paise;
  // Pro-rata, as previewSale costs a partial lot.
  let cost = (taken === lot.units ? lot.cost : Math.round((lot.cost * taken) / lot.units)) as Paise;
  if (lot.tradeDate < GRANDFATHERED_BEFORE) {
    // WEALTH-14 · s55(2)(ac), exactly as the gains engine applies it.
    const fmv = grandfatheredValue(db, instrumentId, today, taken);
    if (fmv === null) return null;
    cost = Math.max(cost, Math.min(fmv, proceeds)) as Paise;
  }
  return { proceeds, cost, gain: (proceeds - cost) as Paise };
}

/** The first day a lot bought on `tradeDate` is held more than `months` months. */
function longTermFrom(tradeDate: IsoDate, months: number): IsoDate {
  let d = addDays(tradeDate, months * 28);
  while (!heldMoreThanMonths(tradeDate, d, months)) d = addDays(d, 1);
  return d;
}

/**
 * The best FIFO prefix of `lots` (all long-term): the most gain not above
 * `cap`, and of equal gains the fewest units. Gain is linear within a lot, so
 * the candidates are each lot's end and the point inside a lot where the
 * running gain reaches the cap.
 */
function bestPrefix(
  db: DB, instrumentId: string, lots: Lot[], px: MicroRupees, today: IsoDate, cap: number, step: number,
): { units: Milliunits; gain: Paise; proceeds: Paise } {
  let best = { units: 0, gain: 0, proceeds: 0 };
  const consider = (u: number, g: number, p: number) => {
    if (g > 0 && g <= cap && (g > best.gain || (g === best.gain && u < best.units))) best = { units: u, gain: g, proceeds: p };
  };
  let units = 0, gain = 0, proceeds = 0;
  for (const lot of lots) {
    const full = partOf(db, instrumentId, lot, lot.units, px, today)!;
    if (full.gain > 0 && gain < cap && gain + full.gain > cap) {
      // Largest whole step of this lot that keeps the running gain within the cap.
      let t = Math.floor(((cap - gain) / full.gain) * lot.units / step) * step;
      const at = (n: number) => partOf(db, instrumentId, lot, n, px, today)!;
      while (t > 0 && gain + at(t).gain > cap) t -= step;
      while (t + step < lot.units && gain + at(t + step).gain <= cap) t += step;
      if (t > 0) { const p = at(t); consider(units + t, gain + p.gain, proceeds + p.proceeds); }
    }
    units += lot.units; gain += full.gain; proceeds += full.proceeds;
    consider(units, gain, proceeds);
  }
  return best as { units: Milliunits; gain: Paise; proceeds: Paise };
}

/**
 * HARVEST-1 · The hint for `memberId` for the financial year containing
 * `today`. Throws the gains engine's Refusal for a year whose rules are not in
 * the app.
 */
export function ltcgHarvestHint(db: DB, memberId: string, today: IsoDate = todayIST()): HarvestHint {
  const fy = fiscalYearOf(today);
  const rules = gainsRulesOn(today);
  const months = rules.longTermMonths.listedEquity;
  const fyEnd = fiscalYearRange(fy).to;

  const gains = capitalGainsTaxFor(db, fy, memberId);
  const exemption = rules.equityLongExemption;
  const realised = (gains.special?.s112a ?? Math.max(0, gains.buckets.equityLong)) as Paise;
  const unused = Math.max(0, exemption - gains.exemptionUsed) as Paise;

  const soleMember = (queryAll<{ n: number }>(
    db, `SELECT COUNT(*) AS n FROM members WHERE removed_at IS NULL`,
  )[0]?.n ?? 0) <= 1;

  /*
   * WEALTH-7 · The member's own holdings: accounts they are named holder of.
   * An account with no holder is theirs only in a one-member household;
   * otherwise it is named as excluded — but only if it is one this member may
   * see at all (a private account with no holder is nobody's to list).
   */
  const rows = queryAll<Row>(
    db,
    `SELECT h.id AS holding_id, h.instrument_id, i.name AS instrument, i.kind, i.asset_class, i.region,
            i.currency, i.listed, a.name AS account_name, a.holder_member_id AS holder
       FROM holdings h
       JOIN instruments i ON i.id = h.instrument_id
       JOIN accounts a ON a.id = h.account_id
      WHERE h.closed_at IS NULL AND a.closed_at IS NULL
        AND (a.holder_member_id = ? OR (a.holder_member_id IS NULL AND a.visibility = 'household'))
        AND EXISTS (SELECT 1 FROM lots l WHERE l.holding_id = h.id AND l.closed_at IS NULL)
      ORDER BY i.name, a.name`,
    memberId,
  );

  const lines: (HarvestLine & { lots: Lot[]; step: number })[] = [];
  const excluded: HarvestExcluded[] = [];
  const exclude = (r: Row, reason: string) =>
    excluded.push({ instrument: r.instrument, accountName: r.account_name, reason });

  for (const r of rows) {
    const cls = r.asset_class;
    // Holdings outside listed equity altogether (debt, gold…) are not 112A and not listed here.
    if (cls !== null && cls !== "equity" && cls !== "hybrid") continue;
    if (r.holder === null && !soleMember) {
      if (cls === "equity") exclude(r, "the account names no holder, so whose exemption it would use cannot be told");
      continue;
    }
    if (cls === null) { exclude(r, "no asset class is set, so whether s112A applies is unknown"); continue; }
    if (cls === "hybrid") { exclude(r, "a hybrid fund's treatment turns on its equity ratio, which this app does not track"); continue; }
    if (r.region === "international" || (r.region === null && r.currency !== "INR")) {
      exclude(r, "international holdings are not s112A: no ₹1.25 lakh exemption"); continue;
    }
    if (r.kind === "equity" && r.listed === 0) { exclude(r, "unlisted shares are not s112A"); continue; }
    if (r.kind !== "equity" && r.kind !== "etf" && r.kind !== "mutual-fund") {
      exclude(r, "not a share, ETF or fund unit"); continue;
    }

    const quote = latestPrice(db, r.instrument_id, today);
    if (!quote) { exclude(r, "no price is recorded, so its gain cannot be worked out"); continue; }

    const lots = lotsFor(db, r.holding_id);
    const longLots: Lot[] = [];
    for (const lot of lots) {
      // FIFO: the long-term lots are the front of the queue; stop at the first that is not.
      if (!heldMoreThanMonths(lot.tradeDate, today, months)) break;
      longLots.push(lot);
    }
    const parts = longLots.map((l) => partOf(db, r.instrument_id, l, l.units, quote.price, today));
    if (parts.some((p) => p === null)) {
      exclude(r, "bought before 1 February 2018 with no price recorded for 31 January 2018, so its cost under s112A is unknown");
      continue;
    }
    const shortLots = lots.slice(longLots.length);
    const sum = (k: "proceeds" | "cost" | "gain") => parts.reduce((s, p) => s + p![k], 0) as Paise;
    lines.push({
      holdingId: r.holding_id, instrumentId: r.instrument_id, instrument: r.instrument,
      accountName: r.account_name, kind: r.kind,
      price: quote.price, priceAsOf: quote.asOf, priceStale: quote.stale,
      unitsHeld: lots.reduce((s, l) => s + l.units, 0),
      longTermUnits: longLots.reduce((s, l) => s + l.units, 0),
      longTermCost: sum("cost"), longTermValue: sum("proceeds"), longTermGain: sum("gain"),
      shortTermUnits: shortLots.reduce((s, l) => s + l.units, 0),
      nextLongTermOn: shortLots[0] ? longTermFrom(shortLots[0].tradeDate, months) : null,
      suggestUnits: 0, suggestGain: 0 as Paise, suggestProceeds: 0 as Paise,
      lots: longLots,
      // A share or ETF unit is sold whole; a fund unit to three decimals.
      step: r.kind === "mutual-fund" ? 1 : UNIT_SCALE,
    });
  }

  /*
   * One exemption across all the member's holdings, so the suggestions share
   * it: the holding with the most long-term gain first (fewest sales), each
   * taking what it can of what is left. Together they never exceed `unused`.
   */
  let left: number = unused;
  for (const line of [...lines].sort((a, b) => b.longTermGain - a.longTermGain)) {
    if (left <= 0) break;
    const best = bestPrefix(db, line.instrumentId, line.lots, line.price, today, left, line.step);
    line.suggestUnits = best.units;
    line.suggestGain = best.gain;
    line.suggestProceeds = best.proceeds;
    left -= best.gain;
  }

  return {
    fy, today, fyEnd, daysLeft: daysBetween(today, fyEnd), longTermMonths: months,
    exemption, realised, unused,
    unplaced: gains.buckets.unclassified,
    lines: lines.map(({ lots: _l, step: _s, ...line }) => line),
    excluded,
    suggestedGain: (unused - left) as Paise,
  };
}
