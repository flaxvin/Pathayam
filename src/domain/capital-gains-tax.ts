/**
 * Capital gains, at the rates that apply to them.
 *
 * The income tax estimate deliberately left these out and said so on screen,
 * because gains are not taxed at slab rates and pretending otherwise would be
 * wrong in both directions at once. This computes them properly and hands the
 * result back to that estimate.
 *
 * ## Why the asset class decides almost everything
 *
 * Two sales of the same size, held the same length of time, are taxed
 * differently depending on what was sold:
 *
 *   listed equity, held > 12 months  →  12.5% above ₹1.25 lakh   (s112A)
 *   listed equity, held ≤ 12 months  →  20%                      (s111A)
 *   property or gold, held > 24 months → 12.5%                   (s112)
 *   property or gold, held ≤ 24 months → slab rates
 *   debt, bought after 1 April 2023  →  slab rates always        (s50AA)
 *
 * So the holding-period threshold is not one number — it is 12 months for
 * listed equity and 24 for most else — and `reports.ts` uses a flat 365 days
 * because it is reporting, not taxing. That is fine there and not here.
 *
 * ## What it refuses to guess
 *
 * An instrument with no asset class set, a hybrid fund (whose treatment turns
 * on an equity ratio this app does not track), and a sale whose parcels were
 * never recorded, are all **excluded from the computation and reported
 * separately**. The principle is the one `reports.ts` already states: a gain
 * filed in the wrong column is worse than one the household is told to check.
 * Here it is worse still, because the wrong column is a different tax rate.
 */

import type { DB } from "../db/db.ts";
import { queryAll } from "../db/db.ts";
import type { Paise } from "../core/money.ts";
import type { IsoDate } from "../core/dates.ts";
import { fiscalYearOf, fiscalYearRange } from "../core/dates.ts";
import type { AssetClass } from "./assets.ts";
import type { SpecialRateGains } from "./tax.ts";

/** Days held before a gain becomes long-term, by class. */
const LONG_TERM_DAYS: Record<"equity" | "other", number> = {
  /** Listed equity and equity-oriented funds: 12 months. */
  equity: 365,
  /** Property, gold, unlisted: 24 months. */
  other: 730,
};

export interface GainsTaxRules {
  /** s112A — listed equity held long. */
  equityLongBp: number;
  /** s112A exemption, applied once across the year. */
  equityLongExemption: Paise;
  /** s111A — listed equity held short. */
  equityShortBp: number;
  /** s112 — everything else held long. */
  otherLongBp: number;
}

const RUPEE = 100;

/**
 * Keyed by financial year for the same reason the income slabs are: a Finance
 * Act moves them, and last year's return must keep computing with last year's
 * rules. These are the post-23-July-2024 rates, unchanged by Budget 2026.
 */
export const GAINS_RULES: Record<number, GainsTaxRules> = {
  2025: {
    equityLongBp: 1250,
    equityLongExemption: (1_25_000 * RUPEE) as Paise,
    equityShortBp: 2000,
    otherLongBp: 1250,
  },
};
GAINS_RULES[2026] = GAINS_RULES[2025]!;

export interface GainsBuckets {
  /** s112A, before the exemption. */
  equityLong: Paise;
  /** s111A. */
  equityShort: Paise;
  /** s112. */
  otherLong: Paise;
  /** Taxed at slab rates, so this is added to ordinary income. */
  slabRated: Paise;
  /**
   * Gains this cannot place: no asset class, a hybrid fund, or a sale with no
   * parcel detail. Never taxed silently — surfaced for the person to resolve.
   */
  unclassified: Paise;
  /** Why each unclassified amount could not be placed. */
  unclassifiedReasons: { instrument: string; gain: Paise; reason: string }[];
}

const EMPTY: GainsBuckets = {
  equityLong: 0 as Paise, equityShort: 0 as Paise, otherLong: 0 as Paise,
  slabRated: 0 as Paise, unclassified: 0 as Paise, unclassifiedReasons: [],
};

/**
 * Sort one financial year's realised gains into the buckets the Act taxes
 * differently.
 *
 * `visibleHoldingOwners` scopes this the way every other total is scoped: a
 * member's own tax estimate must not be built from another member's holdings,
 * and a household figure would be meaningless anyway since gains are assessed
 * on the person who owns the asset.
 */
export function gainsBucketsForYear(db: DB, fy: number, memberId: string): GainsBuckets {
  const { from, to } = fiscalYearRange(fy);
  const sales = queryAll<{
    date: IsoDate; realised_gain: number | null; detail_json: string | null;
    instrument: string; asset_class: string | null; holder: string | null; visibility: string | null;
  }>(
    db,
    `SELECT e.date, e.realised_gain, e.detail_json,
            i.name AS instrument, i.asset_class,
            a.holder_member_id AS holder, a.visibility
       FROM holding_events e
       JOIN holdings h ON h.id = e.holding_id
       JOIN instruments i ON i.id = h.instrument_id
       LEFT JOIN accounts a ON a.id = h.account_id
      WHERE e.kind = 'sale' AND e.date BETWEEN ? AND ?
      ORDER BY e.date`,
    from, to,
  );

  const out: GainsBuckets = { ...EMPTY, unclassifiedReasons: [] };

  for (const sale of sales) {
    // Another member's private holding is not part of this person's estimate.
    if (sale.visibility && sale.visibility !== "household" && sale.holder !== memberId) continue;

    let parcels: { cost: number; proceeds: number; holdingPeriodDays: number }[] = [];
    try {
      parcels = sale.detail_json ? (JSON.parse(sale.detail_json).parcels ?? []) : [];
    } catch {
      parcels = [];
    }

    const cls = (sale.asset_class ?? null) as AssetClass | null;

    if (parcels.length === 0) {
      const gain = (sale.realised_gain ?? 0) as Paise;
      if (gain !== 0) {
        out.unclassified = (out.unclassified + gain) as Paise;
        out.unclassifiedReasons.push({
          instrument: sale.instrument, gain,
          reason: "the lots behind this sale were not recorded, so its holding period is unknown",
        });
      }
      continue;
    }

    for (const parcel of parcels) {
      const gain = (parcel.proceeds - parcel.cost) as Paise;
      if (gain === 0) continue;

      if (cls === null || cls === "hybrid" || cls === "other") {
        out.unclassified = (out.unclassified + gain) as Paise;
        out.unclassifiedReasons.push({
          instrument: sale.instrument, gain,
          reason: cls === "hybrid"
            ? "a hybrid fund is taxed on its equity ratio, which this app does not track"
            : "this instrument has no asset class set",
        });
        continue;
      }

      if (cls === "equity") {
        if (parcel.holdingPeriodDays > LONG_TERM_DAYS.equity) {
          out.equityLong = (out.equityLong + gain) as Paise;
        } else {
          out.equityShort = (out.equityShort + gain) as Paise;
        }
        continue;
      }

      if (cls === "debt" || cls === "cash") {
        // s50AA: units bought on or after 1 April 2023 are always slab-rated,
        // and this app holds no acquisition-date rule fine enough to separate
        // the older ones — so the conservative placement is slab.
        out.slabRated = (out.slabRated + gain) as Paise;
        continue;
      }

      // gold, real-estate: 24 months, then 12.5%.
      if (parcel.holdingPeriodDays > LONG_TERM_DAYS.other) {
        out.otherLong = (out.otherLong + gain) as Paise;
      } else {
        out.slabRated = (out.slabRated + gain) as Paise;
      }
    }
  }

  return out;
}

export interface GainsTax {
  fy: number;
  buckets: GainsBuckets;
  /** Exemption actually used, which is capped by the gain itself. */
  exemptionUsed: Paise;
  equityLongTax: Paise;
  equityShortTax: Paise;
  otherLongTax: Paise;
  /** Tax at special rates. Slab-rated gains are not here — they join income. */
  specialRateTax: Paise;
  /** What must be added to ordinary income before the slabs are applied. */
  addToSlabIncome: Paise;
  /**
   * The gains and rates behind `specialRateTax`, for the income tax estimate.
   * The figures above are tax on the gains standing alone; the estimate
   * recomputes them against the person's other income, because the unused
   * basic exemption, the 87A ceiling and the surcharge band all depend on it.
   */
  special: SpecialRateGains;
}

export function taxOnGains(fy: number, buckets: GainsBuckets): GainsTax {
  const rules = GAINS_RULES[fy] ?? GAINS_RULES[Math.max(...Object.keys(GAINS_RULES).map(Number))]!;

  /*
   * A loss in one bucket does not reduce another here. Set-off between heads
   * has its own rules — short-term loss against either gain, long-term loss
   * only against long-term — and getting that wrong understates tax. Negative
   * buckets are floored at zero and the screen says losses are not carried.
   */
  const equityLongGain = Math.max(0, buckets.equityLong) as Paise;
  const exemptionUsed = Math.min(equityLongGain, rules.equityLongExemption) as Paise;
  const equityLongTaxable = (equityLongGain - exemptionUsed) as Paise;

  const equityLongTax = Math.round((equityLongTaxable * rules.equityLongBp) / 10_000) as Paise;
  const equityShortTax = Math.round((Math.max(0, buckets.equityShort) * rules.equityShortBp) / 10_000) as Paise;
  const otherLongTax = Math.round((Math.max(0, buckets.otherLong) * rules.otherLongBp) / 10_000) as Paise;

  return {
    fy, buckets, exemptionUsed,
    equityLongTax, equityShortTax, otherLongTax,
    specialRateTax: (equityLongTax + equityShortTax + otherLongTax) as Paise,
    addToSlabIncome: Math.max(0, buckets.slabRated) as Paise,
    special: {
      s111a: Math.max(0, buckets.equityShort) as Paise, s111aBp: rules.equityShortBp,
      s112a: equityLongGain, s112aBp: rules.equityLongBp, s112aExemption: rules.equityLongExemption,
      s112: Math.max(0, buckets.otherLong) as Paise, s112Bp: rules.otherLongBp,
    },
  };
}

/** Convenience: everything for one member and year in one call. */
export function capitalGainsTaxFor(db: DB, fy: number, memberId: string): GainsTax {
  return taxOnGains(fy, gainsBucketsForYear(db, fy, memberId));
}
