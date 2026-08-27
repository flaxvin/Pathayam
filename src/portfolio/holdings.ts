/**
 * R24–R27, R34 · The portfolio engine.
 *
 * Pure functions over units, dated prices and lots. No database, no clock, no
 * network — `05` §8 puts the holdings engine first in the assets build order,
 * tested against the worked examples in `07` §10.
 *
 * ## Units of record
 *
 * `07` §1: "Units, not values, are the unit of record. You own 936.043 units
 * of a fund, not 'about ₹80,000'." Everything here follows from that.
 *
 * | Quantity | Stored as | Why |
 * |---|---|---|
 * | Units | integer **milliunits** (1e-3) | R24.3 — three decimals, which is what an AMC actually allots |
 * | Price | integer **micro-rupees** (1e-6) | A NAV carries up to five decimals (106.94190) |
 * | Money | integer paise | As everywhere else in this app |
 *
 * ## One divergence from `07` §10, on purpose
 *
 * The worked example gives ₹80,874.13 for 936.043 units at NAV 86.40.
 * Reproducing that needs *unrounded* units — 936.043123… — which
 * `verify_portfolio.py` does use.
 *
 * But R24.3 is normative and says derived units are stored to three decimals,
 * and that matches reality: a registrar allots 936.043 units, not
 * 936.043123. Holding 936.043 units at 86.40 is **₹80,874.12**.
 *
 * This engine follows R24.3, so it reports ₹80,874.12 and an unrealised gain
 * of ₹5,874.12 — one paisa below the document's illustration. The rule wins
 * over the illustration, because the rule is what the household's statement
 * will agree with. Recorded as erratum E13.
 */

import type { Paise } from "../core/money.ts";
import type { IsoDate } from "../core/dates.ts";
import { daysBetween } from "../core/dates.ts";

/** Units, in thousandths. 936.043 units → 936043. */
export type Milliunits = number;
/** Price per unit, in millionths of a rupee. NAV 86.40 → 86_400_000. */
export type MicroRupees = number;

export const UNIT_SCALE = 1_000;
export const PRICE_SCALE = 1_000_000;

export function units(value: number): Milliunits {
  // R24.3: three decimals, matching what is actually allotted.
  return Math.round(value * UNIT_SCALE);
}

export function price(value: number): MicroRupees {
  return Math.round(value * PRICE_SCALE);
}

export function formatUnits(u: Milliunits): string {
  return (u / UNIT_SCALE).toFixed(3);
}

export function formatPrice(p: MicroRupees): string {
  const value = p / PRICE_SCALE;
  // NAVs are quoted to four decimals; equities to two. Show what is there.
  return value.toFixed(value * 100 === Math.round(value * 100) ? 2 : 4);
}

/**
 * Market value of a quantity at a price, in paise.
 *
 * milliunits × micro-rupees = 1e-9 rupees, and a paisa is 1e-2 rupees, so the
 * divisor is 1e7. Done in one step so no intermediate is rounded.
 */
export function valueOf(quantity: Milliunits, unitPrice: MicroRupees): Paise {
  return Math.round((quantity * unitPrice) / 10_000_000);
}

// ---------------------------------------------------------------------------
// R25 · Lots
// ---------------------------------------------------------------------------

export interface Lot {
  id: string;
  tradeDate: IsoDate;
  units: Milliunits;
  /** Price per unit actually paid. */
  price: MicroRupees;
  /** R24.5: capitalised into the basis by default. */
  fees: Paise;
  /** What this lot cost, including capitalised fees. */
  cost: Paise;
  /** R33: frozen at trade date for a foreign holding, never revalued (FW8). */
  fxRate: number | null;
}

export interface LotInput {
  id: string;
  tradeDate: IsoDate;
  price: MicroRupees;
  /** Supply units, or amount — the other is derived (R24.3, R24.4). */
  units?: Milliunits;
  amount?: Paise;
  fees?: Paise;
  capitaliseFees?: boolean;
  fxRate?: number | null;
}

/**
 * R24.3 / R24.4 · Build a lot from whichever pair the user gave.
 *
 * Entering an amount is how a SIP works — the units fall out of that day's
 * NAV, and are then fixed at three decimals.
 */
export function makeLot(input: LotInput): Lot {
  if (input.price <= 0) throw new RangeError("A lot needs a price above zero.");

  const capitalise = input.capitaliseFees ?? true;
  const fees = input.fees ?? 0;

  let quantity: Milliunits;
  let paid: Paise;

  if (input.units !== undefined) {
    quantity = input.units;
    paid = valueOf(quantity, input.price);
  } else if (input.amount !== undefined) {
    // amount(paise) → units(milli): paise × 1e7 ÷ micro-rupees, rounded once
    // to three decimals, because three decimals is what gets allotted (R24.3).
    quantity = Math.round((input.amount * 10_000_000) / input.price);
    paid = input.amount;
  } else {
    throw new RangeError("A lot needs either units or an amount.");
  }

  return {
    id: input.id,
    tradeDate: input.tradeDate,
    units: quantity,
    price: input.price,
    fees,
    cost: capitalise ? paid + fees : paid,
    fxRate: input.fxRate ?? null,
  };
}

export interface Holding {
  lots: Lot[];
}

export function totalUnits(holding: Holding): Milliunits {
  return holding.lots.reduce((sum, lot) => sum + lot.units, 0);
}

/** R27 · Cost basis of the units still held. */
export function costBasis(holding: Holding): Paise {
  return holding.lots.reduce((sum, lot) => sum + lot.cost, 0);
}

/** R25.3 · Shown for readability, never used to compute a realised gain. */
export function averageCost(holding: Holding): MicroRupees {
  const quantity = totalUnits(holding);
  if (quantity === 0) return 0;
  // paise → micro-rupees per milliunit
  return Math.round((costBasis(holding) * 10_000_000) / quantity);
}

export function marketValue(holding: Holding, unitPrice: MicroRupees, fxRate = 1): Paise {
  return Math.round(valueOf(totalUnits(holding), unitPrice) * fxRate);
}

/** R27 · Market value − cost basis. Never income (R30 FW2). */
export function unrealisedGain(holding: Holding, unitPrice: MicroRupees, fxRate = 1): Paise {
  return marketValue(holding, unitPrice, fxRate) - costBasis(holding);
}

/** R27 · Ignores time, and so misleads for anything bought in instalments. */
export function absoluteReturn(holding: Holding, unitPrice: MicroRupees, fxRate = 1): number {
  const basis = costBasis(holding);
  if (basis === 0) return 0;
  return (unrealisedGain(holding, unitPrice, fxRate) / basis) * 100;
}

// ---------------------------------------------------------------------------
// R25.2 · FIFO
// ---------------------------------------------------------------------------

export interface FifoConsumption {
  lotId: string;
  tradeDate: IsoDate;
  units: Milliunits;
  price: MicroRupees;
  cost: Paise;
  /** R25.5 · Exposed so long-term versus short-term is visible to the user. */
  holdingPeriodDays: number;
}

export interface SalePreview {
  /** S13c: exactly which lots are consumed, before anything is confirmed. */
  consumed: FifoConsumption[];
  proceeds: Paise;
  costOfUnitsSold: Paise;
  realisedGain: Paise;
  unitsRemaining: Milliunits;
  /** The lots left behind, with partial lots split at their original price. */
  remainingLots: Lot[];
  /** J18's sentence, with the household's own numbers. */
  description: string;
}

/**
 * R25.2 · Sell oldest lots first.
 *
 * R25.4: a partial sale splits the affected lot, keeping the residual at its
 * original price and date — which is what preserves the holding period of the
 * units that were not sold.
 */
export function previewSale(
  holding: Holding,
  quantity: Milliunits,
  unitPrice: MicroRupees,
  opts: { charges?: Paise; saleDate?: IsoDate } = {},
): SalePreview {
  const held = totalUnits(holding);
  if (quantity > held) {
    throw new RangeError(
      `Cannot sell ${formatUnits(quantity)} units — only ${formatUnits(held)} are held.`,
    );
  }

  const consumed: FifoConsumption[] = [];
  const remainingLots: Lot[] = [];
  let toSell = quantity;
  let cost = 0;

  for (const lot of holding.lots) {
    if (toSell <= 0) {
      remainingLots.push(lot);
      continue;
    }

    const taken = Math.min(lot.units, toSell);

    // Pro-rata of what the lot actually cost, so capitalised fees travel with
    // the units and — the property that matters — selling everything costs
    // exactly the cost basis. See E13 for why this is a paisa off `07` §4's
    // ₹7,218.75: that figure is 87.5 × 82.50, but ₹25,000 at NAV 82.50 buys
    // 303.030 units (R24.3), not 303.0303…, so the per-unit cost is fractionally
    // higher than the NAV. Both conventions are defensible; this one keeps the
    // invariant below, which a user would notice breaking.
    const takenCost =
      taken === lot.units
        ? lot.cost
        : Math.round((lot.cost * taken) / lot.units);

    consumed.push({
      lotId: lot.id,
      tradeDate: lot.tradeDate,
      units: taken,
      price: lot.price,
      cost: takenCost,
      holdingPeriodDays: opts.saleDate ? daysBetween(lot.tradeDate, opts.saleDate) : 0,
    });

    cost += takenCost;
    toSell -= taken;

    if (taken < lot.units) {
      remainingLots.push({
        ...lot,
        units: lot.units - taken,
        cost: lot.cost - takenCost,
      });
    }
  }

  const proceeds = valueOf(quantity, unitPrice) - (opts.charges ?? 0);

  return {
    consumed,
    proceeds,
    costOfUnitsSold: cost,
    realisedGain: proceeds - cost,
    unitsRemaining: held - quantity,
    remainingLots,
    description: describeSale(consumed, proceeds - cost, opts.saleDate),
  };
}

function describeSale(
  consumed: FifoConsumption[], gain: Paise, saleDate?: IsoDate,
): string {
  const parts = consumed.map(
    (c) =>
      `${formatUnits(c.units)} units from ${c.tradeDate} at ₹${formatPrice(c.price)}`,
  );
  const holding =
    saleDate && consumed.length > 0
      ? consumed.every((c) => c.holdingPeriodDays < 365)
        ? " All lots held under 12 months."
        : consumed.every((c) => c.holdingPeriodDays >= 365)
          ? " All lots held over 12 months."
          : " Some lots held over 12 months and some under."
      : "";

  return (
    `FIFO takes ${parts.join(" and ")}. ` +
    `Realised ${gain >= 0 ? "gain" : "loss"} ₹${Math.abs(gain / 100).toFixed(2)}.${holding}`
  );
}

// ---------------------------------------------------------------------------
// R27 · XIRR
// ---------------------------------------------------------------------------

export interface CashFlow {
  date: IsoDate;
  /** Negative for money going in, positive for money coming back. */
  amount: Paise;
}

/**
 * R27.1 · Money-weighted annualised return, the default headline figure.
 *
 * `07` §4's point: on the SIP example absolute return says 7.83% and XIRR says
 * 14.51%, because absolute return treats March's money as though it had been
 * invested since January. The gap is the whole argument for storing dates.
 *
 * Solved by bisection rather than Newton — slower, but it cannot diverge, and
 * a return figure that silently fails to converge is worse than a slow one.
 */
export function xirr(flows: CashFlow[], opts: { maxRate?: number } = {}): number | null {
  if (flows.length < 2) return null;

  const hasOutflow = flows.some((f) => f.amount < 0);
  const hasInflow = flows.some((f) => f.amount > 0);
  if (!hasOutflow || !hasInflow) return null;

  const sorted = [...flows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const start = sorted[0]!.date;

  const npv = (rate: number): number =>
    sorted.reduce((sum, flow) => {
      const years = daysBetween(start, flow.date) / 365;
      return sum + flow.amount / (1 + rate) ** years;
    }, 0);

  let low = -0.9999;
  let high = opts.maxRate ?? 100;

  if (npv(low) * npv(high) > 0) return null;

  for (let i = 0; i < 300; i++) {
    const mid = (low + high) / 2;
    if (npv(low) * npv(mid) <= 0) high = mid;
    else low = mid;
  }

  return ((low + high) / 2) * 100;
}

/** Build the flows for a holding: every purchase out, current value back in. */
export function holdingCashFlows(
  holding: Holding, unitPrice: MicroRupees, asOf: IsoDate, fxRate = 1,
): CashFlow[] {
  return [
    ...holding.lots.map((lot) => ({ date: lot.tradeDate, amount: -lot.cost })),
    { date: asOf, amount: marketValue(holding, unitPrice, fxRate) },
  ];
}

/** R27.2 · Absolute return must not stand alone where the two differ by 2pp. */
export function mustShowXirr(absolute: number, moneyWeighted: number | null): boolean {
  if (moneyWeighted === null) return false;
  return Math.abs(absolute - moneyWeighted) >= 2;
}

// ---------------------------------------------------------------------------
// R34 · Asset gain versus FX gain
// ---------------------------------------------------------------------------

export interface GainDecomposition {
  costInBase: Paise;
  valueInBase: Paise;
  totalGain: Paise;
  /** (P₁ − P₀) × units × FX₀ — the price move, at the original rate. */
  assetGain: Paise;
  /** (FX₁ − FX₀) × units × P₁ — the rate move, at the new price. */
  fxGain: Paise;
  /** R34.3: a non-zero residual is a defect, not a rounding tolerance. */
  residual: Paise;
  gainInForeignCurrency: Paise;
  fxSharePercent: number;
  /** R34.1 · Required above 20%, because a single figure would be useless. */
  sentence: string | null;
}

/**
 * R34 · Split a foreign holding's gain into the part that was the investment
 * and the part that was the exchange rate.
 *
 * `07` §1: "Foreign holdings have two returns, and only one of them is yours."
 * On the worked example 47% of the gain came from the rupee weakening.
 */
export function decomposeGain(input: {
  quantity: Milliunits;
  /** Purchase price per unit, in the holding's own currency. */
  priceAtPurchase: MicroRupees;
  priceNow: MicroRupees;
  fxAtPurchase: number;
  fxNow: number;
}): GainDecomposition {
  const { quantity, priceAtPurchase, priceNow, fxAtPurchase, fxNow } = input;

  const costForeign = valueOf(quantity, priceAtPurchase);
  const valueForeign = valueOf(quantity, priceNow);

  const costInBase = Math.round(costForeign * fxAtPurchase);
  const valueInBase = Math.round(valueForeign * fxNow);
  const totalGain = valueInBase - costInBase;

  const assetGain = Math.round((valueForeign - costForeign) * fxAtPurchase);
  // The residual from rounding each part separately is carried by the FX side,
  // so the two always sum to the total exactly (R34.3).
  const fxGain = totalGain - assetGain;

  const fxShare = totalGain === 0 ? 0 : (fxGain / totalGain) * 100;

  return {
    costInBase,
    valueInBase,
    totalGain,
    assetGain,
    fxGain,
    residual: totalGain - assetGain - fxGain,
    gainInForeignCurrency: valueForeign - costForeign,
    fxSharePercent: fxShare,
    sentence:
      Math.abs(fxShare) > 20
        ? `${Math.round(Math.abs(fxShare))}% of your gain came from the ` +
          `${fxShare > 0 ? "rupee weakening" : "rupee strengthening"}, not the investment.`
        : null,
  };
}

// ---------------------------------------------------------------------------
// R28 · Corporate actions
// ---------------------------------------------------------------------------

/**
 * R28 · A split or bonus multiplies units and divides per-unit cost. Total
 * cost basis is unchanged — nothing was bought and nothing was gained.
 */
export function applySplit(holding: Holding, ratio: number): Holding {
  if (ratio <= 0) throw new RangeError("A split ratio must be above zero.");
  return {
    lots: holding.lots.map((lot) => ({
      ...lot,
      units: Math.round(lot.units * ratio),
      price: Math.round(lot.price / ratio),
      // cost deliberately untouched — this is the invariant of a split.
    })),
  };
}

/** R28 · A return of capital reduces the basis rather than creating a gain. */
export function applyReturnOfCapital(holding: Holding, amount: Paise): Holding {
  const basis = costBasis(holding);
  if (basis === 0) return holding;

  // The reduction is split pro-rata, with the remainder carried onto the last
  // lot so the reductions sum to exactly `amount` — rounding each share
  // independently would leave the basis a paisa out.
  let distributed = 0;
  const lots = holding.lots.map((lot, index) => {
    const share =
      index === holding.lots.length - 1
        ? amount - distributed
        : Math.round((amount * lot.cost) / basis);
    distributed += share;
    return { ...lot, cost: lot.cost - share };
  });

  return { lots };
}

/** R28 · A merger carries original cost and dates forward at a ratio. */
export function applyMerger(holding: Holding, ratio: number): Holding {
  return {
    lots: holding.lots.map((lot) => ({
      ...lot,
      units: Math.round(lot.units * ratio),
      price: Math.round(lot.price / ratio),
    })),
  };
}
