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
 *   property, gold or foreign shares, held > 24 months → 12.5%   (s112)
 *   property, gold or foreign shares, held ≤ 24 months → slab rates
 *   a gold or international ETF listed in India: as above, but 12 months
 *   debt, bought after 1 April 2023  →  slab rates always        (s50AA)
 *   a listed bond, held > 12 months  →  12.5%, no indexation     (s112)
 *   an unlisted bond, or one not known to be listed → slab rates (s50AA)
 *   a debt fund bought before then   →  as gold (24 months; ETF 12)
 *
 * Those are the rates for sales from 23 July 2024. Sales in 2024-25 before
 * that date had their own — 15%, 10% and 20% with indexation, and 36 months
 * for gold, fund units and listed units other than equity — so the rules are
 * looked up by the date of sale (`gainsRulesOn`), and a year not in the table
 * is refused rather than given the newest year's.
 *
 * So the holding-period threshold is not one number — it is 12 months for
 * listed equity and 24 for most else — and `reports.ts` splits at twelve
 * months because it is reporting, not taxing. Both count calendar months with
 * the same helper, so a parcel is never long-term on one screen and short on
 * the other.
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
import { queryAll, queryOne } from "../db/db.ts";
import type { Paise } from "../core/money.ts";
import type { IsoDate } from "../core/dates.ts";
import { addDays, fiscalYearOf, fiscalYearRange, heldMoreThanMonths } from "../core/dates.ts";
import type { AssetClass } from "./assets.ts";
import type { SpecialRateGains } from "./tax.ts";
import { valueOf } from "../portfolio/holdings.ts";
import { Refusal } from "../core/refusal.ts";

/**
 * Months held before a gain becomes long-term, by class. "More than" that
 * many months, counted as calendar months — see `heldMoreThanMonths`. This
 * used to be days (> 365, > 730), which called a lot bought 2024-02-28 and
 * sold 2025-02-28 long-term because a leap day made it 366 days; it is exactly
 * twelve months, so short-term.
 */
export const LONG_TERM_MONTHS: Record<"equity" | "other", number> = {
  /** Listed securities, units included — shares, equity funds, ETFs: 12 months. */
  equity: 12,
  /** Property, physical gold, unlisted funds, unlisted and foreign shares: 24 months. */
  other: 24,
};

/** s50AA: specified mutual fund units acquired on or after this date are slab-rated. */
const SPECIFIED_FUND_FROM = "2023-04-01";
/** Finance (No. 2) Act 2024: from AY 2026-27 only funds over 65% in debt are "specified". */
const SPECIFIED_FUND_NARROWED_ON = "2025-04-01";

/**
 * The purchase date of a stored parcel. Parcels carry it (B88); if an older
 * one somehow does not, the sale date less the days held recovers it exactly.
 */
function acquiredOn(parcel: { tradeDate?: IsoDate; holdingPeriodDays: number }, soldOn: IsoDate): IsoDate {
  return parcel.tradeDate ?? addDays(soldOn, -parcel.holdingPeriodDays);
}

export interface GainsTaxRules {
  /** s112A — listed equity held long. */
  equityLongBp: number;
  /** s112A exemption, applied once across the year. */
  equityLongExemption: Paise;
  /** s111A — listed equity held short. */
  equityShortBp: number;
  /** s112 — everything else held long. */
  otherLongBp: number;
  /**
   * s112 at `otherLongBp` is on a cost raised by the cost inflation index.
   * This app does not model the index and will not invent one, so a gain
   * under such rules is reported as not computed rather than taxed.
   */
  otherLongIndexed: boolean;
  /** Months held, "more than", before a gain is long-term (s2(42A)). */
  longTermMonths: {
    /** Listed equity, and equity funds. */
    listedEquity: number;
    /** Other units listed in India: gold, international and debt ETFs, REITs, InvITs. */
    listedUnit: number;
    /** Unlisted fund units and gold — the "other" securities and assets. */
    fundOrGold: number;
    /** Property and unlisted (foreign included) shares. */
    other: number;
  };
}

/** A year's rules, in force for sales on or after `from`. */
export interface GainsRulesPeriod {
  from: IsoDate;
  rules: GainsTaxRules;
}

const RUPEE = 100;

/**
 * Finance (No. 2) Act 2024 changed the rates and holding periods for sales on
 * or after 23 July 2024, part-way through 2024-25. The rules are in force
 * from a sale date, not for a whole year, so that year has two periods.
 */
export const GAINS_RATES_CHANGED_ON = "2024-07-23";

/**
 * Sales before 23 July 2024: 15% under 111A, 10% under 112A, and 20% with
 * indexation under 112. The 112A exemption is ₹1.25 lakh for the whole of
 * 2024-25, on either side of the date (CBDT FAQs, checked 23 October 2026).
 */
const BEFORE_23_JULY_2024: GainsTaxRules = {
  equityLongBp: 1000,
  equityLongExemption: (1_25_000 * RUPEE) as Paise,
  equityShortBp: 1500,
  otherLongBp: 2000,
  otherLongIndexed: true,
  longTermMonths: { listedEquity: 12, listedUnit: 36, fundOrGold: 36, other: 24 },
};

/** From 23 July 2024: 20%, 12.5% and 12.5% without indexation. Unchanged by Budget 2026. */
const FROM_23_JULY_2024: GainsTaxRules = {
  equityLongBp: 1250,
  equityLongExemption: (1_25_000 * RUPEE) as Paise,
  equityShortBp: 2000,
  otherLongBp: 1250,
  otherLongIndexed: false,
  longTermMonths: {
    listedEquity: LONG_TERM_MONTHS.equity, listedUnit: LONG_TERM_MONTHS.equity,
    fundOrGold: LONG_TERM_MONTHS.other, other: LONG_TERM_MONTHS.other,
  },
};

/**
 * Keyed by financial year for the same reason the income slabs are: a Finance
 * Act moves them, and last year's return must keep computing with last year's
 * rules. Within a year, by the date of sale — `gainsRulesOn` picks the period.
 * A year that is not here is refused (`assertKnownGainsYear`), never given
 * another year's rates.
 */
export const GAINS_RULES: Record<number, readonly GainsRulesPeriod[]> = {
  2024: [
    { from: "2024-04-01", rules: BEFORE_23_JULY_2024 },
    { from: GAINS_RATES_CHANGED_ON, rules: FROM_23_JULY_2024 },
  ],
  2025: [{ from: "2025-04-01", rules: FROM_23_JULY_2024 }],
};
GAINS_RULES[2026] = [{ from: "2026-04-01", rules: FROM_23_JULY_2024 }];

function fyLabel(fy: number): string {
  return `${fy}-${String((fy + 1) % 100).padStart(2, "0")}`;
}

/** Refuses a year whose gains rates are not in this app, as `assertKnownYear` does for slabs. */
export function assertKnownGainsYear(fy: number): readonly GainsRulesPeriod[] {
  const periods = GAINS_RULES[fy];
  if (!periods || periods.length === 0) {
    const known = Object.keys(GAINS_RULES).map(Number).sort((a, b) => a - b);
    throw new Refusal(
      `The capital gains rates for ${fyLabel(fy)} are not in this app ` +
      `(it has ${fyLabel(known[0]!)} to ${fyLabel(known[known.length - 1]!)}). ` +
      "A Finance Act changes them, and applying another year's would give a confident wrong answer.",
    );
  }
  return periods;
}

/** The rules period a sale on `soldOn` falls in. Refuses a year that is not known. */
export function gainsPeriodOn(soldOn: IsoDate): GainsRulesPeriod {
  const periods = assertKnownGainsYear(fiscalYearOf(soldOn));
  let found = periods[0]!;
  for (const p of periods) if (p.from <= soldOn) found = p;
  return found;
}

/** The rates and holding periods for a sale on `soldOn`. */
export function gainsRulesOn(soldOn: IsoDate): GainsTaxRules {
  return gainsPeriodOn(soldOn).rules;
}

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
  /**
   * The three special-rate buckets again, split by the rules period each sale
   * fell in. Needed only for a year with more than one — 2024-25, split on 23
   * July 2024. Absent, the whole year's buckets are in its one period.
   */
  byPeriod?: PeriodGains[];
}

/** One rules period's special-rate gains. */
export interface PeriodGains {
  from: IsoDate;
  equityLong: Paise;
  equityShort: Paise;
  otherLong: Paise;
}

const EMPTY: GainsBuckets = {
  equityLong: 0 as Paise, equityShort: 0 as Paise, otherLong: 0 as Paise,
  slabRated: 0 as Paise, unclassified: 0 as Paise, unclassifiedReasons: [],
};

/**
 * WEALTH-14 · Listed equity bought before 1 February 2018 is grandfathered
 * (s112A with s55(2)(ac)): its cost is the higher of what was paid and the
 * lower of its fair market value on 31 January 2018 and the sale proceeds. It
 * was taxed on the whole gain since purchase — 1,000 shares bought at ₹100,
 * worth ₹250 on that day and sold at ₹300, were ₹2,00,000 of 112A gain instead
 * of ₹50,000, inside the exemption.
 */
const GRANDFATHERED_BEFORE = "2018-02-01";
const GRANDFATHERING_DATE = "2018-01-31";

/**
 * The 31 January 2018 value of `parcelUnits` as they stood when sold, or null
 * when no price is recorded for that day — the app never guesses one.
 *
 * The price history is divided by every later split or bonus ratio (R28.2), so
 * it is in today's units. A sale's parcel is in the units of its sale date: a
 * split before the sale already multiplied them, one after did not; a bonus
 * never changes the original lot's units at all. So the stored price is
 * multiplied back by each split after the sale and by each bonus since.
 */
function grandfatheredValue(db: DB, instrumentId: string, soldOn: IsoDate, parcelUnits: number): Paise | null {
  const row = queryOne<{ price: number }>(
    db, `SELECT price FROM prices WHERE instrument_id = ? AND as_of = ?`, instrumentId, GRANDFATHERING_DATE,
  );
  if (!row) return null;
  const events = queryAll<{ date: IsoDate; kind: string; ratio: number }>(
    db,
    `SELECT DISTINCT e.date, e.kind, e.ratio
       FROM holding_events e JOIN holdings h ON h.id = e.holding_id
      WHERE h.instrument_id = ? AND e.kind IN ('split','bonus') AND e.date > ?`,
    instrumentId, GRANDFATHERING_DATE,
  );
  let factor = 1;
  for (const e of events) {
    if (e.kind === "bonus" || e.date > soldOn) factor *= e.ratio;
  }
  return valueOf(parcelUnits, Math.round(row.price * factor)) as Paise;
}

/**
 * Sort one financial year's realised gains into the buckets the Act taxes
 * differently.
 *
 * `memberId` scopes this to that member's own holdings — the accounts they
 * are named holder of. A member's tax estimate must not be built from another
 * member's holdings, and a household figure would be meaningless anyway since
 * gains are assessed on the person who owns the asset.
 */
export function gainsBucketsForYear(db: DB, fy: number, memberId: string): GainsBuckets {
  const periods = assertKnownGainsYear(fy);
  const { from, to } = fiscalYearRange(fy);
  const sales = queryAll<{
    date: IsoDate; realised_gain: number | null; detail_json: string | null;
    instrument_id: string; instrument: string; asset_class: string | null; region: string | null; currency: string;
    kind: string; listed: number | null; holder: string | null;
  }>(
    db,
    `SELECT e.date, e.realised_gain, e.detail_json,
            h.instrument_id, i.name AS instrument, i.asset_class, i.region, i.currency, i.kind, i.listed,
            a.holder_member_id AS holder
       FROM holding_events e
       JOIN holdings h ON h.id = e.holding_id
       JOIN instruments i ON i.id = h.instrument_id
       LEFT JOIN accounts a ON a.id = h.account_id
      WHERE e.kind = 'sale' AND e.date BETWEEN ? AND ?
      ORDER BY e.date`,
    from, to,
  );

  const out: GainsBuckets = {
    ...EMPTY, unclassifiedReasons: [],
    byPeriod: periods.map((p) => ({
      from: p.from, equityLong: 0 as Paise, equityShort: 0 as Paise, otherLong: 0 as Paise,
    })),
  };

  /*
   * WEALTH-7 · Whose gain it is follows the account's holder, not who can see
   * it. This used to skip only *private* accounts, so a sale in Priya's
   * household-visible demat was in Priya's estimate and in Ravi's too — the
   * household's gain taxed twice across the two, and Ravi's figure built from
   * an asset he does not own. Visibility is about who may look; income tax is
   * assessed on the owner.
   *
   * An account with no holder named is the one case that cannot be decided.
   * With a single member it is theirs; otherwise it is reported as a gain
   * that could not be placed, like every other thing this refuses to guess —
   * naming the holder on the account resolves it.
   */
  const soleMember = (queryAll<{ n: number }>(
    db, `SELECT COUNT(*) AS n FROM members WHERE removed_at IS NULL`,
  )[0]?.n ?? 0) <= 1;

  for (const sale of sales) {
    if (sale.holder !== null && sale.holder !== memberId) continue;
    if (sale.holder === null && !soleMember) {
      const gain = (sale.realised_gain ?? 0) as Paise;
      if (gain !== 0) {
        out.unclassified = (out.unclassified + gain) as Paise;
        out.unclassifiedReasons.push({
          instrument: sale.instrument, gain,
          reason: "the account it was held in names no holder, so whose gain it is cannot be told — name the holder on the account",
        });
      }
      continue;
    }

    let parcels: {
      tradeDate?: IsoDate; units?: number; cost: number; proceeds: number; holdingPeriodDays: number;
    }[] = [];
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

    /*
     * TAX-FY25-1 · The rules are the sale date's, not the year's. A sale in
     * 2024-25 before 23 July 2024 had its own rates and holding periods, and
     * taking the newest year's for it taxed a ₹1,00,000 short-term equity
     * gain at 20% instead of 15%.
     */
    const period = gainsPeriodOn(sale.date);
    const rules = period.rules;
    const slot = out.byPeriod!.find((p) => p.from === period.from)!;
    const place = (head: "equityLong" | "equityShort" | "otherLong", gain: Paise): void => {
      out[head] = (out[head] + gain) as Paise;
      slot[head] = (slot[head] + gain) as Paise;
    };

    for (const parcel of parcels) {
      let gain = (parcel.proceeds - parcel.cost) as Paise;
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

      /*
       * WEALTH-13 · 111A and 112A are for equity listed in India, sold with
       * STT paid. A US share is neither: it is long-term only after 24
       * months, then s112 at 12.5% with no ₹1.25 lakh exemption, and
       * slab-rated before that — the gold and property path below. It was
       * filed as 112A because its class is "equity", though the instrument
       * itself says it is international. An instrument with no region is
       * judged by its currency, the way `classifyInstrument` seeds one.
       */
      const foreign = sale.region === "international"
        || (sale.region === null && sale.currency !== "INR");

      if (cls === "equity" && !foreign) {
        const acquired = acquiredOn(parcel, sale.date);
        if (heldMoreThanMonths(acquired, sale.date, rules.longTermMonths.listedEquity)) {
          if (acquired < GRANDFATHERED_BEFORE) {
            const fmv = parcel.units === undefined
              ? null
              : grandfatheredValue(db, sale.instrument_id, sale.date, parcel.units);
            if (fmv === null) {
              out.unclassified = (out.unclassified + gain) as Paise;
              out.unclassifiedReasons.push({
                instrument: sale.instrument, gain,
                reason: "bought before 1 February 2018, so its cost is the higher of what was paid and the " +
                  "price on 31 January 2018 — record that price on the holding and it will be placed",
              });
              continue;
            }
            // s55(2)(ac): the higher of the cost and the lower of FMV and proceeds.
            const cost = Math.max(parcel.cost, Math.min(fmv, parcel.proceeds));
            gain = (parcel.proceeds - cost) as Paise;
          }
          place("equityLong", gain);
        } else {
          place("equityShort", gain);
        }
        continue;
      }

      /*
       * DEBUG-TAX-3 · An ETF priced in rupees is a unit listed in India, and
       * since 23 July 2024 every listed security, units included, is long-term
       * after 12 months (s2(42A)). Gold and international ETFs were filed with
       * physical gold at 24 months — a gold ETF held 18 months and sold in
       * 2025-26 was slab-rated instead of 12.5% under s112.
       *
       * TAX-FY25-1 · Before 23 July 2024 a listed unit, any fund unit and gold
       * needed more than 36 months; property and unlisted shares 24.
       */
      const acquired = acquiredOn(parcel, sale.date);
      const listedUnit = sale.kind === "etf" && sale.currency === "INR";
      const fundUnit = sale.kind === "mutual-fund" || listedUnit;
      const anyUnit = sale.kind === "mutual-fund" || sale.kind === "etf";
      const longAfter = listedUnit
        ? rules.longTermMonths.listedUnit
        : (anyUnit || cls === "gold" || cls === "debt")
          ? rules.longTermMonths.fundOrGold
          : rules.longTermMonths.other;

      /*
       * TAX-FY25-1 · Held long and sold before 23 July 2024, s112 was 20% on
       * a cost indexed by the cost inflation index. This app does not model
       * the index and will not invent one, so the gain is reported as not
       * computed, like everything else this refuses to guess.
       */
      const otherLong = (g: Paise): void => {
        if (!rules.otherLongIndexed) {
          place("otherLong", g);
          return;
        }
        out.unclassified = (out.unclassified + g) as Paise;
        out.unclassifiedReasons.push({
          instrument: sale.instrument, gain: g,
          reason: `sold before 23 July 2024 and held long, so s112 taxes it at ${rules.otherLongBp / 100}% ` +
            "with indexation — not computed here, because this app does not model the cost inflation index",
        });
      };

      /*
       * BONDS-1 · A bond listed on an exchange is a listed security: long-term
       * after 12 months (s2(42A)), then s112 at 12.5% with no indexation, and
       * slab-rated before that. Since 23 July 2024 s50AA catches unlisted bonds
       * and debentures whatever the holding period, so an unlisted one is
       * slab-rated always — and so is one whose listing nobody has recorded,
       * because guessing "listed" would understate the tax.
       */
      if (sale.kind === "bond" && (cls === "debt" || cls === "cash")) {
        if (sale.listed === 1 && heldMoreThanMonths(acquired, sale.date, LONG_TERM_MONTHS.equity)) {
          out.otherLong = (out.otherLong + gain) as Paise;
        } else {
          out.slabRated = (out.slabRated + gain) as Paise;
        }
        continue;
      }

      if (cls === "debt" || cls === "cash") {
        /*
         * s50AA: specified mutual fund units bought on or after 1 April 2023
         * are always slab-rated (a bond is decided above).
         *
         * DEBUG-TAX-3 · Fund units bought before 1 April 2023 are outside
         * s50AA: long-term after 24 months (12 for a listed ETF), then s112.
         * Every debt sale used to be slab-rated, which taxed a 2021 debt fund
         * sold in 2025-26 at up to 30% instead of 12.5%. Parcels carry their
         * trade date, so the split is known.
         */
        if (cls === "debt" && fundUnit && acquired < SPECIFIED_FUND_FROM
            && heldMoreThanMonths(acquired, sale.date, longAfter)) {
          otherLong(gain);
        } else {
          out.slabRated = (out.slabRated + gain) as Paise;
        }
        continue;
      }

      /*
       * Before AY 2026-27 a "specified mutual fund" was any fund with no more
       * than 35% in Indian equity — gold and international ETFs and funds
       * included — so units of one bought from 1 April 2023 and sold before
       * 1 April 2025 were slab-rated however long they were held. Finance
       * (No. 2) Act 2024 narrowed it to funds over 65% in debt.
       */
      if (fundUnit && acquired >= SPECIFIED_FUND_FROM && sale.date < SPECIFIED_FUND_NARROWED_ON) {
        out.slabRated = (out.slabRated + gain) as Paise;
        continue;
      }

      // gold, real-estate, foreign equity: 24 months (12 for a listed unit), then 12.5%.
      if (heldMoreThanMonths(acquired, sale.date, longAfter)) {
        otherLong(gain);
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
  special?: SpecialRateGains;
  /**
   * Each rules period's gains with the rules that taxed them — one period in
   * most years, two in 2024-25 — so a screen can name the rates it used.
   */
  byPeriod: (PeriodGains & { rules: GainsTaxRules })[];
}

type Head = "equityLong" | "equityShort" | "otherLong";
interface Tranche { gain: number; bp: number }

/**
 * One head's gains across the year's periods, with a loss in one period set
 * against a gain in another — the same head, so the same set-off rules — and
 * the year's total floored at zero. The loss goes against the highest rate
 * first: the Act fixes no order, and this is the one that is the person's best.
 */
function netted(tranches: Tranche[]): Tranche[] {
  const loss = tranches.reduce((sum, t) => sum + Math.min(0, t.gain), 0);
  const out = tranches.map((t) => ({ gain: Math.max(0, t.gain), bp: t.bp }));
  takeHighestRateFirst(out, -loss);
  return out;
}

/** Takes up to `amount` off the tranches, highest rate first; returns what it took. */
function takeHighestRateFirst(tranches: Tranche[], amount: number): number {
  let left = amount;
  for (const t of [...tranches].sort((a, b) => b.bp - a.bp)) {
    const used = Math.min(left, t.gain);
    t.gain -= used;
    left -= used;
  }
  return amount - left;
}

const taxOn = (tranches: Tranche[]): Paise =>
  Math.round(tranches.reduce((sum, t) => sum + t.gain * t.bp, 0) / 10_000) as Paise;

const total = (tranches: Tranche[]): Paise => tranches.reduce((sum, t) => sum + t.gain, 0) as Paise;

export function taxOnGains(fy: number, buckets: GainsBuckets): GainsTax {
  const periods = assertKnownGainsYear(fy);

  /*
   * TAX-FY25-1 · Which period each gain fell in. A year with one period needs
   * no split; a year with two cannot be taxed without one, and is refused
   * rather than given either side's rates for the whole of it.
   */
  const given = buckets.byPeriod;
  if (!given && periods.length > 1) {
    throw new Refusal(
      `${fyLabel(fy)} has different rates on either side of ${periods[1]!.from}, ` +
      "so its gains have to be split by the date of each sale.",
    );
  }
  for (const g of given ?? []) {
    if (!periods.some((p) => p.from === g.from)) {
      throw new Refusal(`No capital gains rates of ${fyLabel(fy)} begin on ${g.from}.`);
    }
  }
  const byPeriod = periods.map((p) => {
    const g = given
      ? given.find((x) => x.from === p.from)
      : { equityLong: buckets.equityLong, equityShort: buckets.equityShort, otherLong: buckets.otherLong };
    return {
      from: p.from, rules: p.rules,
      equityLong: (g?.equityLong ?? 0) as Paise,
      equityShort: (g?.equityShort ?? 0) as Paise,
      otherLong: (g?.otherLong ?? 0) as Paise,
    };
  });
  for (const p of byPeriod) {
    if (p.rules.otherLongIndexed && p.otherLong !== 0) {
      throw new Refusal(
        `s112 gains on sales from ${p.from} are taxed at ${p.rules.otherLongBp / 100}% with indexation, ` +
        "which this app does not compute.",
      );
    }
  }

  const tranches = (head: Head, bp: "equityLongBp" | "equityShortBp" | "otherLongBp"): Tranche[] =>
    netted(byPeriod.map((p) => ({ gain: p[head], bp: p.rules[bp] })));

  /*
   * A loss in one bucket does not reduce another here. Set-off between heads
   * has its own rules — short-term loss against either gain, long-term loss
   * only against long-term — and getting that wrong understates tax. Negative
   * buckets are floored at zero and the screen says losses are not carried.
   */
  const equityLong = tranches("equityLong", "equityLongBp");
  const equityShort = tranches("equityShort", "equityShortBp");
  const otherLong = tranches("otherLong", "otherLongBp");

  const equityLongGain = total(equityLong);
  // The exemption is one amount for the whole year, on either side of a split.
  const exemption = periods[periods.length - 1]!.rules.equityLongExemption;
  const exemptionUsed = takeHighestRateFirst(equityLong, exemption) as Paise;

  const equityLongTax = taxOn(equityLong);
  const equityShortTax = taxOn(equityShort);
  const otherLongTax = taxOn(otherLong);

  /*
   * The estimate takes one rate per section. A year with two periods cannot
   * be put that way, so it gets none — and the estimate does not cover 2024-25
   * in any case, since its slabs are not in this app.
   */
  const only = periods.length === 1 ? periods[0]!.rules : null;

  return {
    fy, buckets, exemptionUsed,
    equityLongTax, equityShortTax, otherLongTax,
    specialRateTax: (equityLongTax + equityShortTax + otherLongTax) as Paise,
    addToSlabIncome: Math.max(0, buckets.slabRated) as Paise,
    ...(only ? {
      special: {
        s111a: total(equityShort), s111aBp: only.equityShortBp,
        s112a: equityLongGain, s112aBp: only.equityLongBp, s112aExemption: only.equityLongExemption,
        s112: total(otherLong), s112Bp: only.otherLongBp,
      },
    } : {}),
    byPeriod,
  };
}

/** Convenience: everything for one member and year in one call. */
export function capitalGainsTaxFor(db: DB, fy: number, memberId: string): GainsTax {
  return taxOnGains(fy, gainsBucketsForYear(db, fy, memberId));
}
