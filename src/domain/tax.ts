/**
 * An income tax estimate, under both regimes, for one person.
 *
 * ## This reverses a stated non-goal
 *
 * `02` N15 said the app must never "compute a tax liability or deduction", and
 * L14 said the same in more words. That was a deliberate decision and it is now
 * deliberately reversed — see `docs/archive/09-decisions-log.md` Q31. The
 * reasoning that retired it: a household that has already told this app every
 * rupee it earned and spent is one screen away from the question it actually
 * wants answered in January, and sending it to a spreadsheet to answer that is
 * not restraint, it is an omission.
 *
 * What has not changed is that this is **arithmetic on numbers you supply**,
 * not advice, and not a return. Every screen that shows it says so.
 *
 * ## Why the rates are data
 *
 * Slabs, the rebate ceiling, the standard deduction and the surcharge bands all
 * change with a Finance Act, usually every February. Written as code they would
 * be a yearly hunt through `if` statements; written as a table keyed by
 * financial year, last year's return still computes with last year's rules
 * while this year's uses this year's — which is what somebody comparing two
 * years actually needs.
 *
 * A year this table does not know is refused rather than guessed. Quietly
 * applying the previous year's slabs to a new one produces a confident number
 * that is wrong, which is worse than no number at all.
 *
 * ## What is deliberately not modelled
 *
 * Marginal relief on surcharge and on the 87A cliff, clubbing, set-off and
 * carry-forward of losses, presumptive income, foreign income and
 * relief under a treaty. Each of those changes the answer and none of them is
 * here. The screen lists them, because an estimate that hides what it ignores
 * is the kind that gets trusted too far.
 */

import type { Paise } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";

export type Regime = "old" | "new";

/** A slab is "everything above `from`, up to `to`, at `rate`". */
export interface Slab {
  /** Inclusive lower bound, in paise. */
  from: Paise;
  /** Exclusive upper bound, or null for the top slab. */
  to: Paise | null;
  /** Basis points, so 5% is 500 and there are no floats in the table. */
  rateBp: number;
}

export interface RegimeRules {
  slabs: Slab[];
  /** Salaried standard deduction. */
  standardDeduction: Paise;
  /**
   * Section 87A: below this taxable income, tax is reduced by at most
   * `rebateCap`. Expressed as the two numbers the Act uses rather than as an
   * effective "no tax below X", because the cap is what actually binds.
   */
  rebateCeiling: Paise;
  rebateCap: Paise;
  /** Whether Chapter VI-A deductions (80C, 80D) and HRA apply at all. */
  allowsDeductions: boolean;
  /** Surcharge bands, highest first. */
  surcharge: { above: Paise; rateBp: number }[];
}

const RUPEE = 100;
const L = (lakhs: number): Paise => Math.round(lakhs * 100_000 * RUPEE) as Paise;
const R = (rupees: number): Paise => Math.round(rupees * RUPEE) as Paise;

/**
 * Health and education cess, on tax plus surcharge. 4% since FY 2018-19 and
 * unchanged since, so it is one number rather than a column.
 */
const CESS_BP = 400;

/**
 * Section 288B: tax payable is rounded to the nearest ten rupees. Applied once,
 * to the final figure, rather than at each step — rounding the slab tax and
 * again after cess would compound.
 *
 * Without this the screen reports things like ₹3,92,898.48, which is arithmetic
 * nobody will ever pay: the amount actually payable is ₹3,92,900.
 */
const ROUND_TO = 10 * RUPEE;
function roundPayable(amount: Paise): Paise {
  return (Math.round(amount / ROUND_TO) * ROUND_TO) as Paise;
}

const OLD_SLABS: Slab[] = [
  { from: R(0),      to: L(2.5), rateBp: 0 },
  { from: L(2.5),    to: L(5),   rateBp: 500 },
  { from: L(5),      to: L(10),  rateBp: 2000 },
  { from: L(10),     to: null,   rateBp: 3000 },
];

const OLD_SURCHARGE = [
  { above: L(200), rateBp: 2500 },
  { above: L(100), rateBp: 1500 },
  { above: L(50),  rateBp: 1000 },
];

/**
 * Financial year → the rules that applied to it.
 *
 * FY 2025-26 is the Finance Act 2025 position: the new regime's slabs were
 * widened, its standard deduction is ₹75,000, and the 87A rebate reaches
 * ₹12,00,000 of taxable income with a cap of ₹60,000.
 *
 * FY 2026-27 is the same table, and that is a checked fact rather than a
 * carry-forward: the Union Budget 2026 announced no change to the slabs, the
 * rebate or the standard deduction under either regime.
 *
 * `RATES_VERIFIED_ON` is the date somebody last confirmed that against the
 * source. A stale table is the dangerous case — worse than a missing one,
 * because it answers — so the screen shows the date, and `staleRatesWarning`
 * below reports when the app is being asked about a year newer than anything
 * in this table.
 */
export const RATES_VERIFIED_ON = "2026-09-19";

/** Where to check them, which is not a blog. */
export const RATES_SOURCE = "https://incometaxindia.gov.in";

export const RULES: Record<number, Record<Regime, RegimeRules>> = {
  2025: {
    old: {
      slabs: OLD_SLABS,
      standardDeduction: R(50_000),
      rebateCeiling: L(5),
      rebateCap: R(12_500),
      allowsDeductions: true,
      surcharge: [{ above: L(500), rateBp: 3700 }, ...OLD_SURCHARGE],
    },
    new: {
      slabs: [
        { from: R(0),  to: L(4),  rateBp: 0 },
        { from: L(4),  to: L(8),  rateBp: 500 },
        { from: L(8),  to: L(12), rateBp: 1000 },
        { from: L(12), to: L(16), rateBp: 1500 },
        { from: L(16), to: L(20), rateBp: 2000 },
        { from: L(20), to: L(24), rateBp: 2500 },
        { from: L(24), to: null,  rateBp: 3000 },
      ],
      standardDeduction: R(75_000),
      rebateCeiling: L(12),
      rebateCap: R(60_000),
      allowsDeductions: false,
      // The new regime's surcharge stops at 25%; there is no 37% band.
      surcharge: OLD_SURCHARGE,
    },
  },
};
// Budget 2026 left the slabs, the rebate and the standard deduction unchanged
// under both regimes, so this is the same table rather than a copy that has
// drifted.
RULES[2026] = RULES[2025]!;

/**
 * The newest year this app has rates for. Compared against the year being
 * asked about, so an install that has not been updated in two years says so
 * instead of refusing with no explanation.
 */
export const NEWEST_KNOWN_FY = Math.max(...Object.keys(RULES).map(Number));

/**
 * Null when the rates cover the year in question, otherwise the sentence to
 * put in front of the person.
 *
 * Deliberately not a silent fallback to the previous year's rules: a Finance
 * Act changes these, and applying last year's to this year produces a
 * confident wrong answer, which is the one failure mode a tax screen must not
 * have.
 */
export function staleRatesWarning(fy: number): string | null {
  if (fy <= NEWEST_KNOWN_FY) return null;
  return `This app's rates go up to ${NEWEST_KNOWN_FY}-${String((NEWEST_KNOWN_FY + 1) % 100).padStart(2, "0")}, ` +
    `last checked on ${RATES_VERIFIED_ON}. Slabs change with each Finance Act, so update the app before relying on a later year.`;
}

/** Ceilings on the deductions this models, under the old regime. */
export const LIMITS = {
  s80c: L(1.5),
  /** 80D: ₹25,000, or ₹50,000 where a senior citizen is covered. */
  s80dStandard: R(25_000),
  s80dSenior: R(50_000),
};

export function assertKnownYear(fy: number): void {
  if (!RULES[fy]) {
    throw new Refusal(
      `The rates for ${fy}-${String((fy + 1) % 100).padStart(2, "0")} are not in this app. ` +
      "Slabs change with each Finance Act, and applying another year's would give a confident wrong answer.",
    );
  }
}

/** Tax on an amount, slab by slab. No rounding until the end. */
export function taxOnSlabs(taxable: Paise, slabs: Slab[]): Paise {
  let tax = 0;
  for (const slab of slabs) {
    if (taxable <= slab.from) break;
    const upper = slab.to === null ? taxable : Math.min(taxable, slab.to);
    tax += ((upper - slab.from) * slab.rateBp) / 10_000;
  }
  return Math.round(tax) as Paise;
}

export interface Deductions {
  /** 80C: PF, ELSS, life premium, principal on a home loan, tuition. */
  s80c: Paise;
  /** 80D: health insurance premiums. */
  s80d: Paise;
  /** Whether a senior citizen is covered, which raises the 80D ceiling. */
  s80dSenior: boolean;
  /** Anything else under Chapter VI-A, entered as one figure. */
  other: Paise;
  hra: HraInput | null;
}

export interface HraInput {
  /** HRA actually received in the year. */
  received: Paise;
  /** Rent actually paid in the year. */
  rentPaid: Paise;
  /** Basic salary plus dearness allowance, for the year. */
  basic: Paise;
  /** Delhi, Mumbai, Kolkata or Chennai. */
  metro: boolean;
}

/**
 * The HRA exemption: the least of three figures, which is the part people get
 * wrong. Paying no rent exempts nothing, however much HRA was received.
 */
export function hraExemption(hra: HraInput): Paise {
  if (hra.rentPaid <= 0 || hra.received <= 0) return 0 as Paise;
  const tenPercentOfBasic = Math.round(hra.basic * 0.1);
  const overTenPercent = Math.max(0, hra.rentPaid - tenPercentOfBasic);
  const cityShare = Math.round(hra.basic * (hra.metro ? 0.5 : 0.4));
  return Math.max(0, Math.min(hra.received, overTenPercent, cityShare)) as Paise;
}

export interface RegimeEstimate {
  regime: Regime;
  gross: Paise;
  standardDeduction: Paise;
  hraExempt: Paise;
  chapterViA: Paise;
  taxable: Paise;
  taxBeforeRebate: Paise;
  rebate: Paise;
  /** Tax on capital gains at their own rates, before any rebate taken from it. */
  specialRateTax: Paise;
  surcharge: Paise;
  cess: Paise;
  total: Paise;
  /** Total as a percentage of gross, to one decimal. */
  effectiveRatePct: number;
  /** Slab income plus special-rate gains: what 87A and the surcharge test. */
  totalIncome: Paise;
  /** Unused basic exemption set against special-rate gains. */
  basicExemptionAgainstGains: Paise;
}

export interface GainsContribution {
  /** Gains taxed at slab rates, which join ordinary income. */
  addToSlabIncome: Paise;
  /** Gains taxed at their own rates, added after the slabs are applied. */
  specialRateTax: Paise;
  /**
   * The special-rate gains themselves, section by section. When present, the
   * estimate computes their tax itself — it has to, because three things the
   * Act does with them depend on the rest of the person's income, which only
   * the estimate knows: the unused basic exemption is set against them, the
   * 87A ceiling and the surcharge band are tested on total income including
   * them, and the surcharge on them is capped at 15%. `specialRateTax` alone
   * is only a fallback for a caller that has nothing more.
   */
  special?: SpecialRateGains;
}

export interface SpecialRateGains {
  /** s111A: listed equity held short. Positive gain, floored at zero. */
  s111a: Paise;
  s111aBp: number;
  /** s112A: listed equity held long, before the annual exemption. */
  s112a: Paise;
  s112aBp: number;
  s112aExemption: Paise;
  /** s112: gold, property and the rest, held long. */
  s112: Paise;
  s112Bp: number;
}

/**
 * The surcharge on tax at special rates — 111A, 112A and 112 — is capped at
 * 15% whatever the band (Finance Act 2022 extended the 111A/112A cap to 112).
 */
const GAINS_SURCHARGE_CAP_BP = 1500;

export function estimateUnder(
  fy: number, regime: Regime, gross: Paise, deductions: Deductions,
  gains: GainsContribution | null = null,
): RegimeEstimate {
  assertKnownYear(fy);
  const rules = RULES[fy]![regime];

  const hraExempt = rules.allowsDeductions && deductions.hra
    ? hraExemption(deductions.hra)
    : 0 as Paise;

  /*
   * Each Chapter VI-A head is capped separately before they are added. Adding
   * first and capping the total would let an ₹80,000 health premium absorb
   * unused 80C room, which the Act does not permit.
   */
  const chapterViA = rules.allowsDeductions
    ? (Math.min(deductions.s80c, LIMITS.s80c)
      + Math.min(deductions.s80d, deductions.s80dSenior ? LIMITS.s80dSenior : LIMITS.s80dStandard)
      + deductions.other) as Paise
    : 0 as Paise;

  /*
   * Slab-rated gains — debt, short-term property — are ordinary income and go
   * in before the deductions, because Chapter VI-A reduces gross total income
   * and that includes them.
   */
  const grossWithGains = (gross + (gains?.addToSlabIncome ?? 0)) as Paise;

  const taxable = Math.max(
    0, grossWithGains - rules.standardDeduction - hraExempt - chapterViA,
  ) as Paise;

  const taxBeforeRebate = taxOnSlabs(taxable, rules.slabs);
  const sp = gains?.special ?? null;

  /*
   * Special-rate gains, with the unused basic exemption set against them.
   *
   * A resident whose other income is below the basic exemption sets the
   * shortfall against 111A, 112A and 112 gains before those are taxed (the
   * provisos to 111A(1), 112(1) and 112A(2)). Without it a retiree with no
   * salary and a ₹4,00,000 long-term equity gain was shown ₹35,750 of tax —
   * ₹2,75,000 over the exemption at 12.5%, plus cess — when the new regime's
   * ₹4,00,000 nil slab leaves nothing to pay. It is applied to the 20% gains
   * first, because the Act fixes no order and this one is the person's best.
   */
  const basicExemption = rules.slabs[0]?.rateBp === 0 ? (rules.slabs[0].to ?? 0) : 0;
  let shortfall = Math.max(0, basicExemption - taxable);
  const setOff = (gain: number): number => {
    const used = Math.min(shortfall, gain);
    shortfall -= used;
    return used;
  };
  let tax111a = 0, tax112 = 0, tax112a = 0, basicExemptionAgainstGains = 0, gainsIncome = 0;
  if (sp) {
    const s111a = Math.max(0, sp.s111a), s112 = Math.max(0, sp.s112), s112a = Math.max(0, sp.s112a);
    gainsIncome = s111a + s112 + s112a;
    const off111a = setOff(s111a);
    const off112 = setOff(s112);
    // The 112A exemption applies to what is left after the shortfall.
    const off112a = setOff(s112a);
    basicExemptionAgainstGains = off111a + off112 + off112a;
    tax111a = Math.round(((s111a - off111a) * sp.s111aBp) / 10_000);
    tax112 = Math.round(((s112 - off112) * sp.s112Bp) / 10_000);
    tax112a = Math.round((Math.max(0, s112a - off112a - sp.s112aExemption) * sp.s112aBp) / 10_000);
  } else {
    // A caller with only a figure: it can only be added as it came.
    tax112a = gains?.specialRateTax ?? 0;
  }

  /*
   * Total income — slab income plus the special-rate gains — is what the 87A
   * ceiling and the surcharge bands are tested against. Testing slab income
   * alone let ₹11,00,000 of salary plus a ₹6,25,000 112A gain (₹17,25,000 in
   * all) take the new regime's rebate as if it were under ₹12,00,000, showing
   * ₹65,000 against ₹1,17,000 actually payable.
   */
  const totalIncome = (taxable + gainsIncome) as Paise;

  /*
   * What 87A may relieve. Never 112A tax, under either regime. Under the new
   * regime, from 2025-26, no special-rate tax at all; under the old, it does
   * relieve 111A and 112 — so a pensioner with ₹1,00,000 of slab income and a
   * ₹3,00,000 short-term equity gain pays ₹18,200.
   */
  const relievable = regime === "old" ? taxBeforeRebate + tax111a + tax112 : taxBeforeRebate;
  const rebate = totalIncome <= rules.rebateCeiling
    ? Math.min(relievable, rules.rebateCap) as Paise
    : 0 as Paise;

  // The rebate comes off slab tax first, then off 111A, then 112.
  let rebateLeft: number = rebate;
  const takeRebate = (tax: number): number => {
    const used = Math.min(rebateLeft, tax);
    rebateLeft -= used;
    return tax - used;
  };
  const afterRebate = takeRebate(taxBeforeRebate);
  const specialAfter = takeRebate(tax111a) + takeRebate(tax112) + tax112a;

  /*
   * Special-rate tax is shown before the rebate, so the rows read slab tax −
   * rebate + special tax. The rebate is never taken from 112A tax (nor, under
   * the new regime, from any of it): folding the two together first is the
   * mistake that makes a calculator tell somebody with a modest salary and a
   * large equity gain that they owe nothing.
   */
  const specialRateTax = (tax111a + tax112 + tax112a) as Paise;
  const taxBeforeSurcharge = (afterRebate + specialAfter) as Paise;

  /*
   * The band is chosen on total income, and the rate on special-rate tax is
   * capped at 15%. Choosing it on slab income alone put ₹45,00,000 of salary
   * plus a ₹20,00,000 111A gain (₹65,00,000) below the 10% band: ₹13,83,200
   * shown against ₹15,21,520 payable.
   */
  const band = rules.surcharge.find((b) => totalIncome > b.above);
  const gainsBandBp = band ? (sp ? Math.min(band.rateBp, GAINS_SURCHARGE_CAP_BP) : band.rateBp) : 0;
  const surcharge = band
    ? Math.round((afterRebate * band.rateBp + specialAfter * gainsBandBp) / 10_000) as Paise
    : 0 as Paise;
  const cess = Math.round(((taxBeforeSurcharge + surcharge) * CESS_BP) / 10_000) as Paise;
  const total = roundPayable((taxBeforeSurcharge + surcharge + cess) as Paise);

  return {
    regime, gross: grossWithGains,
    standardDeduction: rules.standardDeduction,
    hraExempt, chapterViA, taxable,
    taxBeforeRebate, rebate, specialRateTax, surcharge, cess, total,
    totalIncome, basicExemptionAgainstGains: basicExemptionAgainstGains as Paise,
    effectiveRatePct: grossWithGains > 0 ? Math.round((total / grossWithGains) * 1000) / 10 : 0,
  };
}

export interface TaxEstimate {
  fy: number;
  old: RegimeEstimate;
  new: RegimeEstimate;
  /** The cheaper one, or null where they are identical to the rupee. */
  better: Regime | null;
  /** How much the cheaper one saves. */
  saves: Paise;
}

export function estimateTax(
  fy: number, gross: Paise, deductions: Deductions,
  gains: GainsContribution | null = null,
): TaxEstimate {
  const oldR = estimateUnder(fy, "old", gross, deductions, gains);
  const newR = estimateUnder(fy, "new", gross, deductions, gains);
  const diff = Math.abs(oldR.total - newR.total) as Paise;
  return {
    fy, old: oldR, new: newR,
    better: oldR.total === newR.total ? null : (oldR.total < newR.total ? "old" : "new"),
    saves: diff,
  };
}

// ---------------------------------------------------------------------------
// Advance tax
// ---------------------------------------------------------------------------

/**
 * The four instalments under section 211, as cumulative percentages of the
 * year's liability. Missing one costs interest under 234B and 234C, which is
 * the whole reason to show the dates.
 */
export const ADVANCE_TAX_INSTALMENTS = [
  { due: "06-15", cumulativePct: 15, label: "15 June" },
  { due: "09-15", cumulativePct: 45, label: "15 September" },
  { due: "12-15", cumulativePct: 75, label: "15 December" },
  { due: "03-15", cumulativePct: 100, label: "15 March" },
] as const;

export interface AdvanceInstalment {
  label: string;
  date: string;
  cumulativePct: number;
  cumulativeAmount: Paise;
  /** Payable at this instalment, net of the earlier ones. */
  instalmentAmount: Paise;
}

/**
 * Advance tax is not due at all where the year's liability is under ₹10,000,
 * so a household below that gets an empty list rather than four rows of zero.
 */
export const ADVANCE_TAX_THRESHOLD = R(10_000);

export function advanceTaxSchedule(fy: number, liability: Paise): AdvanceInstalment[] {
  if (liability < ADVANCE_TAX_THRESHOLD) return [];
  let paidSoFar = 0;
  return ADVANCE_TAX_INSTALMENTS.map((i) => {
    const cumulative = Math.round((liability * i.cumulativePct) / 100);
    const instalment = cumulative - paidSoFar;
    paidSoFar = cumulative;
    // The March instalment falls in the calendar year after the FY starts.
    const year = i.due.startsWith("03") ? fy + 1 : fy;
    return {
      label: i.label,
      date: `${year}-${i.due}`,
      cumulativePct: i.cumulativePct,
      cumulativeAmount: cumulative as Paise,
      instalmentAmount: instalment as Paise,
    };
  });
}

// ---------------------------------------------------------------------------
// Storage, and what the ledger can contribute
// ---------------------------------------------------------------------------

import type { DB } from "../db/db.ts";
import { execute, queryOne } from "../db/db.ts";
import { nowIST, fiscalYearRange } from "../core/dates.ts";

export interface Declaration extends Deductions {
  gross: Paise;
}

const EMPTY: Declaration = {
  gross: 0 as Paise, s80c: 0 as Paise, s80d: 0 as Paise,
  s80dSenior: false, other: 0 as Paise, hra: null,
};

export function getDeclaration(db: DB, memberId: string, fy: number): Declaration {
  const row = queryOne<{
    gross: number; s80c: number; s80d: number; s80d_senior: number; other: number;
    hra_received: number; hra_rent_paid: number; hra_basic: number; hra_metro: number;
  }>(
    db,
    `SELECT gross, s80c, s80d, s80d_senior, other,
            hra_received, hra_rent_paid, hra_basic, hra_metro
       FROM tax_declarations WHERE member_id = ? AND fy = ?`,
    memberId, fy,
  );
  if (!row) return EMPTY;
  return {
    gross: row.gross as Paise,
    s80c: row.s80c as Paise,
    s80d: row.s80d as Paise,
    s80dSenior: row.s80d_senior === 1,
    other: row.other as Paise,
    hra: (row.hra_received || row.hra_rent_paid || row.hra_basic)
      ? {
          received: row.hra_received as Paise,
          rentPaid: row.hra_rent_paid as Paise,
          basic: row.hra_basic as Paise,
          metro: row.hra_metro === 1,
        }
      : null,
  };
}

export function saveDeclaration(db: DB, memberId: string, fy: number, d: Declaration): void {
  assertKnownYear(fy);
  for (const [label, value] of [
    ["Gross income", d.gross], ["Section 80C", d.s80c], ["Section 80D", d.s80d],
    ["Other deductions", d.other],
  ] as const) {
    if (value < 0) throw new Refusal(`${label} cannot be negative.`);
  }
  execute(
    db,
    `INSERT INTO tax_declarations
       (member_id, fy, gross, s80c, s80d, s80d_senior, other,
        hra_received, hra_rent_paid, hra_basic, hra_metro, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(member_id, fy) DO UPDATE SET
         gross = excluded.gross, s80c = excluded.s80c, s80d = excluded.s80d,
         s80d_senior = excluded.s80d_senior, other = excluded.other,
         hra_received = excluded.hra_received, hra_rent_paid = excluded.hra_rent_paid,
         hra_basic = excluded.hra_basic, hra_metro = excluded.hra_metro,
         updated_at = excluded.updated_at`,
    memberId, fy, d.gross, d.s80c, d.s80d, d.s80dSenior ? 1 : 0, d.other,
    d.hra?.received ?? 0, d.hra?.rentPaid ?? 0, d.hra?.basic ?? 0, d.hra?.metro ? 1 : 0,
    nowIST(),
  );
}

/**
 * Money that arrived in this financial year, as a starting point only.
 *
 * This is emphatically not taxable income and the screen says so: it counts
 * what landed in accounts the viewer can see, which misses a salary paid into
 * an account this app does not hold, and includes receipts — a refund, a
 * transfer in from outside, a gift — that are not income at all. It is offered
 * because typing a year's salary from memory is worse than correcting a number
 * that is nearly right.
 */
export function incomeInFinancialYear(db: DB, fy: number, visibleAccountIds: string[]): Paise {
  if (visibleAccountIds.length === 0) return 0 as Paise;
  const { from, to } = fiscalYearRange(fy);
  const placeholders = visibleAccountIds.map(() => "?").join(",");
  const row = queryOne<{ total: number }>(
    db,
    `SELECT COALESCE(SUM(t.amount), 0) AS total
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.deleted_at IS NULL
        AND t.amount > 0
        AND t.transfer_pair_id IS NULL
        AND a.kind = 'budget'
        AND t.account_id IN (${placeholders})
        AND t.date BETWEEN ? AND ?`,
    ...visibleAccountIds, from, to,
  );
  return (row?.total ?? 0) as Paise;
}
