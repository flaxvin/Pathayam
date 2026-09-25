/**
 * R16–R22 · The amortisation engine.
 *
 * Pure functions, no database, built first — `05` §8 and `09` §8 both put the
 * amortisation engine ahead of everything else in the loans module, tested
 * against the worked examples in `06` §12.
 *
 * ## The one place this app does not use integer paise
 *
 * Everywhere else, money is a whole number of paise and floating point never
 * touches a rupee figure (`core/money.ts`). Here it does, deliberately.
 *
 * `06` §12 requires the engine to carry **unrounded** values and to round only
 * for display, because rounding each of 240 instalments would accumulate error
 * into the lifetime-interest figure — and R22 notes those numbers get quoted.
 * `docs/verify_amortisation.py`, which pins every figure in `06`, works the
 * same way; matching it is how these functions are checked.
 *
 * So: internally, **fractional paise as a float**. At every boundary — what is
 * stored, displayed or compared — `toPaise` rounds once. The unit never
 * changes, only the precision.
 *
 * A consequence worth knowing: a real lender rounds the EMI to whole rupees
 * and absorbs the difference in the final instalment. This engine amortises at
 * the unrounded EMI, which is what produces `06`'s figures. The difference over
 * a 240-month loan is a few rupees on the last instalment, and the *actual*
 * ledger (R18) is authoritative for what was really paid regardless.
 */

import type { Paise } from "../core/money.ts";
import { type IsoDate, addMonths, monthOf } from "../core/dates.ts";

/** Fractional paise. Internal to this module only. */
type Exact = number;

/** R17.4's guard — a schedule that never closes means negative amortisation. */
const MAX_MONTHS = 1200;

export function toPaise(value: Exact): Paise {
  return Math.round(value);
}

export type InterestModel =
  | "reducing"      // M1 — monthly rest, the default
  | "flat"          // M2 — interest on the original principal throughout
  | "moratorium-serviced"     // M3 — interest paid monthly, principal untouched
  | "moratorium-capitalised"; // M4 — interest accrues into principal

export type PrepayMode = "tenure" | "emi";

export class NegativeAmortisation extends Error {
  constructor(instalment: Paise, monthlyInterest: Paise) {
    super(
      `An instalment of ${(instalment / 100).toFixed(2)} does not cover the ` +
        `${(monthlyInterest / 100).toFixed(2)} of interest that accrues each month, ` +
        `so the balance would grow rather than shrink and the loan would never close.`,
    );
    this.name = "NegativeAmortisation";
  }
}

// ---------------------------------------------------------------------------
// R16 M1 · Reducing balance
// ---------------------------------------------------------------------------

function monthlyRate(annualRatePct: number): number {
  return annualRatePct / 1200;
}

/** EMI = P·r·(1+r)^n / ((1+r)^n − 1). Returns unrounded fractional paise. */
function exactEmi(principal: Exact, annualRatePct: number, months: number): Exact {
  if (months <= 0) throw new RangeError("A loan needs at least one instalment.");
  const r = monthlyRate(annualRatePct);
  if (r === 0) return principal / months;
  const factor = (1 + r) ** months;
  return (principal * r * factor) / (factor - 1);
}

/** The instalment as it would be quoted — rounded once, for display. */
export function emiFor(principal: Paise, annualRatePct: number, months: number): Paise {
  return toPaise(exactEmi(principal, annualRatePct, months));
}

export interface Instalment {
  number: number;
  /** Only set when the schedule is anchored to a first-instalment date. */
  dueDate: IsoDate | null;
  opening: Paise;
  payment: Paise;
  interest: Paise;
  principal: Paise;
  closing: Paise;
  cumulativeInterest: Paise;
  /** R18.3: a projected split is visually distinct from a confirmed one. */
  estimated: boolean;
}

export interface ScheduleInput {
  principal: Paise;
  annualRatePct: number;
  months: number;
  /** Overrides the computed EMI — used when the lender's differs. */
  emi?: Paise;
  /** R19 · recurring extra payment, applied from the first instalment. */
  extraMonthly?: Paise;
  /** R19 · lump sums, keyed by instalment number. */
  prepayments?: Map<number, Paise>;
  /** R19.1/R19.3 · tenure reduction is the default. */
  prepayMode?: PrepayMode;
  /** Anchors due dates, so the schedule can feed the cashflow calendar. */
  firstInstalmentDate?: IsoDate;
}

export interface Schedule {
  instalments: Instalment[];
  totalInterest: Paise;
  months: number;
  /** The instalment in force at closure — lower than the first under `emi` mode. */
  finalEmi: Paise;
  totalRepaid: Paise;
  closesOn: IsoDate | null;
}

/**
 * R17 · Amortise to closure.
 *
 * `tenure` mode keeps the instalment and closes early; `emi` mode keeps the
 * original closure month and lowers the instalment (R19.1).
 */
export function buildSchedule(input: ScheduleInput): Schedule {
  const {
    principal, annualRatePct, months,
    extraMonthly = 0, prepayments = new Map(), prepayMode = "tenure",
    firstInstalmentDate,
  } = input;

  if (principal <= 0) throw new RangeError("A loan needs a principal above zero.");

  const r = monthlyRate(annualRatePct);
  let balance: Exact = principal;
  let payment: Exact = input.emi !== undefined ? input.emi : exactEmi(principal, annualRatePct, months);

  // R17.4 / RBI: refuse a configuration that cannot amortise, and say why.
  if (r > 0 && payment + extraMonthly <= principal * r) {
    throw new NegativeAmortisation(toPaise(payment + extraMonthly), toPaise(principal * r));
  }

  const instalments: Instalment[] = [];
  let totalInterest: Exact = 0;
  let cumulative: Exact = 0;
  let month = 0;

  // Half a paise: below this the balance is closed, not merely small.
  while (balance > 0.5) {
    month++;
    if (month > MAX_MONTHS) {
      throw new NegativeAmortisation(toPaise(payment + extraMonthly), toPaise(balance * r));
    }

    const opening = balance;
    const interest = balance * r;
    const cumulativeBefore = cumulative;
    totalInterest += interest;
    cumulative += interest;

    const due = Math.min(payment + extraMonthly, balance + interest);
    balance = balance + interest - due;
    const afterInstalment = balance;

    const prepayment = prepayments.get(month);
    if (prepayment !== undefined) {
      const applied = Math.min(prepayment, balance);
      balance -= applied;
      // R19.1: reducing the EMI keeps the original closure month.
      if (prepayMode === "emi" && balance > 0) {
        const remaining = months - month;
        if (remaining > 0) payment = exactEmi(balance, annualRatePct, remaining);
      }
    }

    /*
     * Each row is rounded from the exact figures, but not column by column.
     * Rounding opening, principal and closing separately left rows that did
     * not add up — on ₹1,00,000 at 12% over 300 months, opening − principal
     * missed closing by a paisa on row after row, and the payments summed to
     * ₹1.24 less than the total repaid. So the principal is opening − closing
     * (before any prepayment, which is not part of the instalment), and the
     * interest is the step in the rounded running total, so the rows add up to
     * exactly the unrounded lifetime interest `06` §12 pins. The instalment is
     * their sum, which can sit a paisa either side of the quoted EMI.
     */
    const openingP = toPaise(opening);
    const principalP = openingP - toPaise(Math.max(afterInstalment, 0));
    const interestP = toPaise(cumulative) - toPaise(cumulativeBefore);
    instalments.push({
      number: month,
      dueDate: firstInstalmentDate ? shiftMonths(firstInstalmentDate, month - 1) : null,
      opening: openingP,
      payment: principalP + interestP,
      interest: interestP,
      principal: principalP,
      closing: toPaise(Math.max(balance, 0)),
      cumulativeInterest: toPaise(cumulative),
      estimated: true,
    });
  }

  return {
    instalments,
    totalInterest: toPaise(totalInterest),
    months: month,
    finalEmi: toPaise(payment),
    totalRepaid: toPaise(principal + totalInterest),
    closesOn: instalments.at(-1)?.dueDate ?? null,
  };
}

function shiftMonths(date: IsoDate, delta: number): IsoDate {
  const month = addMonths(monthOf(date), delta);
  const day = date.slice(8, 10);
  // Clamp to the month's length, the same policy schedules use (F7.3).
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
  return `${month}-${String(Math.min(Number(day), lastDay)).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// R16 M2 · Flat rate, and the rate it really is
// ---------------------------------------------------------------------------

export interface FlatRateLoan {
  principal: Paise;
  totalInterest: Paise;
  emi: Paise;
  months: number;
  /** R16: displayed beside any flat-rate loan, because the gap is not small. */
  equivalentReducingRatePct: number;
}

export function flatRateLoan(
  principal: Paise, annualFlatPct: number, months: number,
): FlatRateLoan {
  const years = months / 12;
  const totalInterest = principal * (annualFlatPct / 100) * years;
  const emi = (principal + totalInterest) / months;

  return {
    principal,
    totalInterest: toPaise(totalInterest),
    emi: toPaise(emi),
    months,
    equivalentReducingRatePct: equivalentReducingRate(principal, emi, months),
  };
}

/**
 * R16 M2 · The schedule a flat-rate loan actually runs to.
 *
 * Interest is charged on the ORIGINAL principal for the whole term, so every
 * instalment carries the same interest (P₀ × rate ÷ 12) and the same principal
 * (what is owed ÷ instalments left). Projected as a reducing-balance loan at
 * the flat rate — which is what happened before — ₹1,00,000 at 12% flat over
 * 12 months showed an EMI of ₹8,884.88 and ₹6,618.55 of interest; the lender
 * collects ₹9,333.33 a month and ₹12,000 of interest.
 *
 * `principal` is what is owed now and `months` the instalments left, so a
 * loan part-way through projects its remaining instalments; on schedule those
 * are exactly the original ones.
 */
export function flatSchedule(input: {
  principal: Paise;
  originalPrincipal: Paise;
  annualFlatPct: number;
  months: number;
  firstInstalmentDate?: IsoDate;
}): Schedule {
  const { principal, originalPrincipal, annualFlatPct, months, firstInstalmentDate } = input;
  if (principal <= 0) throw new RangeError("A loan needs a principal above zero.");
  if (months <= 0) throw new RangeError("A loan needs at least one instalment.");

  const interest: Exact = (originalPrincipal * annualFlatPct) / 1200;
  const principalPart: Exact = principal / months;
  const instalments: Instalment[] = [];
  let balance: Exact = principal;
  let cumulative: Exact = 0;
  for (let n = 1; n <= months; n++) {
    const opening = balance;
    balance = n === months ? 0 : balance - principalPart;
    cumulative += interest;
    // Each row is rounded from exact values, and the principal is taken as
    // opening − closing so every row reconciles to the paisa.
    const openingP = toPaise(opening), closingP = toPaise(balance);
    const interestP = toPaise(cumulative) - toPaise(cumulative - interest);
    instalments.push({
      number: n,
      dueDate: firstInstalmentDate ? shiftMonths(firstInstalmentDate, n - 1) : null,
      opening: openingP,
      payment: openingP - closingP + interestP,
      interest: interestP,
      principal: openingP - closingP,
      closing: closingP,
      cumulativeInterest: toPaise(cumulative),
      estimated: true,
    });
  }
  const totalInterest = toPaise(interest * months);
  return {
    instalments,
    totalInterest,
    months,
    finalEmi: toPaise(principalPart + interest),
    totalRepaid: principal + totalInterest,
    closesOn: instalments.at(-1)?.dueDate ?? null,
  };
}

/** R16 M2 · The fixed monthly interest on a flat-rate loan. */
export function flatMonthlyInterest(originalPrincipal: Paise, annualFlatPct: number): Paise {
  return toPaise((originalPrincipal * annualFlatPct) / 1200);
}

/**
 * The reducing-balance rate that produces this instalment — what a flat-rate
 * quote actually costs.
 *
 * Solved by bisection rather than a closed form, because the EMI formula
 * cannot be inverted for `r`. Converges to well under a basis point.
 */
export function equivalentReducingRate(
  principal: Exact, emi: Exact, months: number,
): number {
  if (emi * months <= principal) return 0;

  let low = 0;
  let high = 100;
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    if (exactEmi(principal, mid, months) < emi) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

// ---------------------------------------------------------------------------
// R16 M3, M4 · Moratorium
// ---------------------------------------------------------------------------

export interface MoratoriumOutcome {
  /** M3: paid each month during the moratorium. Zero under M4. */
  monthlyInterest: Paise;
  /** M3: total serviced across the moratorium. Zero under M4. */
  totalServiced: Paise;
  /** M4: interest rolled into principal. Zero under M3. */
  capitalisedInterest: Paise;
  /** What repayment actually starts against. */
  balanceAtRepaymentStart: Paise;
  emiAfter: Paise;
}

/**
 * R16 M3/M4 · What a moratorium costs.
 *
 * M4 must be warned about *and quantified* at loan creation — the education
 * example in `06` is ₹10,508 a month more, for ten years, for not paying
 * ₹13,125 a month during the moratorium.
 */
export function moratorium(
  input: {
    principal: Paise;
    annualRatePct: number;
    moratoriumMonths: number;
    repaymentMonths: number;
    capitalise: boolean;
  },
): MoratoriumOutcome {
  const { principal, annualRatePct, moratoriumMonths, repaymentMonths, capitalise } = input;
  const r = monthlyRate(annualRatePct);
  const monthlyInterest = principal * r;

  if (!capitalise) {
    return {
      monthlyInterest: toPaise(monthlyInterest),
      totalServiced: toPaise(monthlyInterest * moratoriumMonths),
      capitalisedInterest: 0,
      balanceAtRepaymentStart: principal,
      emiAfter: toPaise(exactEmi(principal, annualRatePct, repaymentMonths)),
    };
  }

  // Unpaid interest compounds — which is the whole point of the warning.
  const grown = principal * (1 + r) ** moratoriumMonths;
  return {
    monthlyInterest: 0,
    totalServiced: 0,
    capitalisedInterest: toPaise(grown - principal),
    balanceAtRepaymentStart: toPaise(grown),
    emiAfter: toPaise(exactEmi(grown, annualRatePct, repaymentMonths)),
  };
}

/** R15 · Pre-EMI: interest on what has been drawn, nothing more. */
export function preEmi(disbursed: Paise, annualRatePct: number): Paise {
  return toPaise(disbursed * monthlyRate(annualRatePct));
}

// ---------------------------------------------------------------------------
// R19 · Prepayment
// ---------------------------------------------------------------------------

export interface PrepaymentOption {
  mode: PrepayMode;
  emiAfter: Paise;
  months: number;
  lifetimeInterest: Paise;
  interestSaved: Paise;
  emisSaved: number;
}

export interface PrepaymentComparison {
  baseline: { months: number; emi: Paise; lifetimeInterest: Paise };
  reduceTenure: PrepaymentOption;
  reduceEmi: PrepaymentOption;
  /** How much better the default is. The reason this module exists. */
  tenureAdvantage: Paise;
  /** R19.3: the reason, in one line, with the household's own numbers. */
  recommendation: string;
  /** R19.5: included in the net saving. */
  prepaymentCharge: Paise;
}

/**
 * R19.2 · Both outcomes, side by side, before anything is committed.
 *
 * R19.7 uses the same function for the what-if calculator, which is the
 * feature people will open the app for.
 */
export function comparePrepayment(input: {
  principal: Paise;
  annualRatePct: number;
  months: number;
  prepayment: Paise;
  atMonth: number;
  prepaymentCharge?: Paise;
}): PrepaymentComparison {
  const { principal, annualRatePct, months, prepayment, atMonth } = input;
  const prepaymentCharge = input.prepaymentCharge ?? 0;

  const base = buildSchedule({ principal, annualRatePct, months });
  const prepayments = new Map([[atMonth, prepayment]]);

  const tenure = buildSchedule({
    principal, annualRatePct, months, prepayments, prepayMode: "tenure",
  });
  const emi = buildSchedule({
    principal, annualRatePct, months, prepayments, prepayMode: "emi",
  });

  const tenureSaved = base.totalInterest - tenure.totalInterest - prepaymentCharge;
  const emiSaved = base.totalInterest - emi.totalInterest - prepaymentCharge;
  const advantage = tenureSaved - emiSaved;

  return {
    baseline: { months: base.months, emi: base.instalments[0]?.payment ?? 0, lifetimeInterest: base.totalInterest },
    reduceTenure: {
      mode: "tenure",
      emiAfter: base.instalments[0]?.payment ?? 0,
      months: tenure.months,
      lifetimeInterest: tenure.totalInterest,
      interestSaved: tenureSaved,
      emisSaved: base.months - tenure.months,
    },
    reduceEmi: {
      mode: "emi",
      emiAfter: emi.finalEmi,
      months: emi.months,
      lifetimeInterest: emi.totalInterest,
      interestSaved: emiSaved,
      emisSaved: base.months - emi.months,
    },
    tenureAdvantage: advantage,
    recommendation:
      advantage > 0
        ? `Reducing the tenure saves ₹${formatIndian(advantage)} more than reducing the EMI, ` +
          `and closes the loan ${base.months - tenure.months} instalments early.`
        : `Reducing the EMI saves ₹${formatIndian(-advantage)} more here, which is unusual — ` +
          `check the figures before committing.`,
    prepaymentCharge,
  };
}

/** R19 · A recurring extra payment, and what it buys. */
export function compareExtraMonthly(input: {
  principal: Paise;
  annualRatePct: number;
  months: number;
  extraMonthly: Paise;
}): { baseline: Schedule; withExtra: Schedule; interestSaved: Paise; emisSaved: number } {
  const { principal, annualRatePct, months, extraMonthly } = input;
  // The baseline must not inherit the extra payment, or this compares a
  // schedule against itself and reports a saving of zero.
  const baseline = buildSchedule({ principal, annualRatePct, months });
  const withExtra = buildSchedule({ principal, annualRatePct, months, extraMonthly });
  return {
    baseline,
    withExtra,
    interestSaved: baseline.totalInterest - withExtra.totalInterest,
    emisSaved: baseline.months - withExtra.months,
  };
}

// ---------------------------------------------------------------------------
// R20 · Rate reset
// ---------------------------------------------------------------------------

export interface RateResetOptions {
  outstanding: Paise;
  remainingMonths: number;
  oldRatePct: number;
  newRatePct: number;
  /** Keep paying the same instalment; the tenure moves instead. */
  keepEmi: { emi: Paise; months: number; monthsDelta: number };
  /** Keep the closure date; the instalment moves instead. */
  keepTenure: { emi: Paise; months: number; emiDelta: Paise };
}

/**
 * R20.2 · The borrower's options at a reset, and what each costs — which RBI
 * requires lenders to offer, and which the household has to choose between.
 */
export function rateResetOptions(input: {
  outstanding: Paise;
  currentEmi: Paise;
  remainingMonths: number;
  oldRatePct: number;
  newRatePct: number;
}): RateResetOptions {
  const { outstanding, currentEmi, remainingMonths, oldRatePct, newRatePct } = input;

  // R20.3 / R17.4: an instalment below the new monthly interest cannot amortise.
  const newMonthlyInterest = outstanding * monthlyRate(newRatePct);
  if (currentEmi <= newMonthlyInterest) {
    throw new NegativeAmortisation(currentEmi, toPaise(newMonthlyInterest));
  }

  const keptEmi = buildSchedule({
    principal: outstanding,
    annualRatePct: newRatePct,
    months: remainingMonths,
    emi: currentEmi,
  });

  const keptTenureEmi = emiFor(outstanding, newRatePct, remainingMonths);

  return {
    outstanding,
    remainingMonths,
    oldRatePct,
    newRatePct,
    keepEmi: {
      emi: currentEmi,
      months: keptEmi.months,
      monthsDelta: keptEmi.months - remainingMonths,
    },
    keepTenure: {
      emi: keptTenureEmi,
      months: remainingMonths,
      emiDelta: keptTenureEmi - currentEmi,
    },
  };
}

// ---------------------------------------------------------------------------
// R22 · Lifetime metrics
// ---------------------------------------------------------------------------

export interface LifetimeMetrics {
  /** Sum of interest portions of **recorded actual** instalments. Never projected. */
  interestPaid: Paise;
  /** interestPaid + interest on the remaining projected instalments. */
  interestProjected: Paise;
  /** Interest under the schedule as at origination. */
  baselineInterest: Paise;
  /** baseline − projected. Positive means ahead. */
  interestSaved: Paise;
  emisSaved: number;
  principalRepaid: Paise;
  /** principalRepaid ÷ total disbursed. */
  progressPercent: number;
  totalCostOfBorrowing: Paise;
  /** R22.3: set when history predates the app. */
  fromDate: IsoDate | null;
  /**
   * R22.4 · Rate movements are excluded from "saved by your actions" and
   * reported separately, so a rate cut is not sold back as an achievement.
   */
  savedByAction: Paise;
  savedByRateMovement: Paise;
}

export function lifetimeMetrics(input: {
  disbursed: Paise;
  actualInterestPaid: Paise;
  actualPrincipalRepaid: Paise;
  projectedRemainingInterest: Paise;
  baselineInterest: Paise;
  baselineMonths: number;
  projectedMonths: number;
  fees?: Paise;
  /** Interest difference attributable to rate changes rather than payments. */
  rateMovementEffect?: Paise;
  fromDate?: IsoDate | null;
}): LifetimeMetrics {
  const fees = input.fees ?? 0;
  const rateMovement = input.rateMovementEffect ?? 0;
  const interestProjected = input.actualInterestPaid + input.projectedRemainingInterest;
  const interestSaved = input.baselineInterest - interestProjected;

  return {
    interestPaid: input.actualInterestPaid,
    interestProjected,
    baselineInterest: input.baselineInterest,
    interestSaved,
    emisSaved: input.baselineMonths - input.projectedMonths,
    principalRepaid: input.actualPrincipalRepaid,
    progressPercent:
      input.disbursed > 0 ? (input.actualPrincipalRepaid / input.disbursed) * 100 : 0,
    totalCostOfBorrowing: interestProjected + fees,
    fromDate: input.fromDate ?? null,
    savedByAction: interestSaved - rateMovement,
    savedByRateMovement: rateMovement,
  };
}

/** R18.4 · Drift, and whether it is worth interrupting someone about. */
export function drift(projectedOutstanding: Paise, actualOutstanding: Paise): {
  amount: Paise;
  material: boolean;
  threshold: Paise;
} {
  const amount = projectedOutstanding - actualOutstanding;
  // R18.5: ₹500 or 0.1% of outstanding, whichever is larger.
  const threshold = Math.max(50_000, Math.round(Math.abs(actualOutstanding) * 0.001));
  return { amount, material: Math.abs(amount) > threshold, threshold };
}

function formatIndian(paise: Paise): string {
  const whole = Math.round(Math.abs(paise) / 100).toString();
  if (whole.length <= 3) return whole;
  const last3 = whole.slice(-3);
  return `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}
