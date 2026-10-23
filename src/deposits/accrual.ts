/**
 * What a deposit is worth on a given day, from its terms.
 *
 * Pure functions, no database and no clock — the same footing as the
 * amortisation engine beside it (`loans/amortisation.ts`). The domain layer
 * (`domain/deposits.ts`) reads the terms and the register and hands them here.
 *
 * ## Per kind
 *
 * | Kind | Grows from | Interest |
 * |---|---|---|
 * | `fd` | the principal, on the start date | compounded at the chosen frequency (a bank FD: quarterly) |
 * | `rd` | one instalment a month, on the start date's day | each instalment compounded like an FD from its own date (quarterly) |
 * | `ppf` | the principal on the start date, then the register | monthly on the lowest balance between the close of the 5th and the month's end, credited each 31 March |
 * | `epf` | the principal on the start date, then the register | monthly on the balance the month opened with, credited each 31 March |
 * | `other` | the principal, then each register entry from its own date | compounded at the chosen frequency |
 *
 * A compounding period is counted from the date the money went in, in calendar
 * months (a quarter is three), so a deposit made on the 31st compounds on the
 * last day of a shorter month. The part of a period not yet complete earns
 * simple interest for the days it has run, on an actual/365 basis — what an
 * Indian bank pays on a broken period. `simple` compounding is that alone,
 * from start to end.
 *
 * After the maturity date nothing more accrues: the value stays at what it
 * matured to until somebody records what happened to the money. A bank pays a
 * savings rate on an overdue deposit, which this does not guess at.
 *
 * Periodic payout (an FD or `other` paying its interest out at each
 * compounding date) leaves the deposit worth its principal; the interest is
 * income in whichever account it lands in.
 *
 * ## Rounding
 *
 * Inputs are whole paise. Growth is carried unrounded, as fractional paise,
 * and rounded **once**, to the nearest paisa with a half going away from zero,
 * when a figure leaves this module. PPF and EPF are the exception, because the
 * interest is a real credit to the account: each year's interest is rounded to
 * the nearest paisa when it is credited on 31 March, and becomes part of the
 * whole-paise balance that earns the next year's.
 *
 * Worked example: ₹1,00,000 in an FD at 7% compounded quarterly for one year
 * is 1,00,000 × 1.0175⁴ = ₹1,07,185.90 — ₹1,07,186 to the rupee.
 */

import type { Paise } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import {
  addMonths, daysBetween, daysInMonth, isIsoDate, lastDayOfMonth, monthOf, type IsoDate,
} from "../core/dates.ts";

/** Fractional paise. Internal to this module only. */
type Exact = number;

export const DEPOSIT_KINDS = ["fd", "rd", "ppf", "epf", "other"] as const;
export type DepositKind = (typeof DEPOSIT_KINDS)[number];

export const COMPOUNDINGS = ["simple", "monthly", "quarterly", "half-yearly", "yearly"] as const;
export type Compounding = (typeof COMPOUNDINGS)[number];

export const PAYOUTS = ["cumulative", "periodic"] as const;
export type Payout = (typeof PAYOUTS)[number];

export const DEPOSIT_KIND_LABELS: Record<DepositKind, string> = {
  fd: "Fixed deposit",
  rd: "Recurring deposit",
  ppf: "Public Provident Fund",
  epf: "Employees' Provident Fund",
  other: "Other deposit",
};

export const COMPOUNDING_LABELS: Record<Compounding, string> = {
  simple: "simple interest",
  monthly: "compounded monthly",
  quarterly: "compounded quarterly",
  "half-yearly": "compounded half-yearly",
  yearly: "compounded yearly",
};

/** What a kind compounds at when nobody says otherwise. */
export const DEFAULT_COMPOUNDING: Record<DepositKind, Compounding> = {
  fd: "quarterly",
  rd: "quarterly",
  ppf: "yearly",
  epf: "yearly",
  other: "quarterly",
};

/**
 * Kinds whose money arrives over time and is recorded in the account's
 * register. An FD is one sum and an RD a fixed instalment, both known from the
 * terms alone; a PPF, an EPF or `other` is whatever was paid in.
 */
export const READS_REGISTER: ReadonlySet<DepositKind> = new Set(["ppf", "epf", "other"]);

/** Highest annual rate taken seriously, in basis points: the loans' ceiling of 100%. */
export const MAX_RATE_BP = 10_000;

export interface DepositTerms {
  kind: DepositKind;
  /** The sum on the start date. For a PPF or EPF, the balance brought forward. */
  principal: Paise;
  /** An RD's monthly instalment. Null for every other kind. */
  instalment: Paise | null;
  /** Annual rate in basis points: 7.10% is 710. */
  rateBp: number;
  compounding: Compounding;
  startDate: IsoDate;
  maturityDate: IsoDate | null;
  payout: Payout;
}

/** A dated movement in the register: positive paid in, negative taken out. */
export interface Contribution {
  date: IsoDate;
  amount: Paise;
}

/** Nearest paisa, a half going away from zero. */
export function roundPaise(value: Exact): Paise {
  return (value < 0 ? -Math.round(-value) : Math.round(value)) as Paise;
}

/** `date` plus `months` calendar months, landing on the last day of a shorter month. */
export function addMonthsToDate(date: IsoDate, months: number): IsoDate {
  const target = addMonths(monthOf(date), months);
  const day = Math.min(
    Number(date.slice(8, 10)),
    daysInMonth(Number(target.slice(0, 4)), Number(target.slice(5, 7))),
  );
  return `${target}-${String(day).padStart(2, "0")}`;
}

const PERIOD_MONTHS: Record<Exclude<Compounding, "simple">, number> = {
  monthly: 1, quarterly: 3, "half-yearly": 6, yearly: 12,
};

/**
 * `amount` placed on `from`, grown to `to`: whole compounding periods from
 * `from`, then simple interest on the days of the period still running.
 */
export function grow(amount: Exact, from: IsoDate, to: IsoDate, rateBp: number, compounding: Compounding): Exact {
  if (to <= from || rateBp === 0) return amount;
  const r = rateBp / 10_000;
  if (compounding === "simple") return amount * (1 + (r * daysBetween(from, to)) / 365);

  const m = PERIOD_MONTHS[compounding];
  // Months elapsed, then step back while the anniversary overshoots `to`.
  const elapsed = (Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7)))
    - (Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)));
  let k = Math.max(0, Math.floor(elapsed / m));
  while (k > 0 && addMonthsToDate(from, k * m) > to) k--;
  const anchor = addMonthsToDate(from, k * m);
  return amount * Math.pow(1 + (r * m) / 12, k) * (1 + (r * daysBetween(anchor, to)) / 365);
}

/** The day the deposit stops accruing for a reading on `on`. */
function endFor(terms: DepositTerms, on: IsoDate): IsoDate {
  return terms.maturityDate && terms.maturityDate < on ? terms.maturityDate : on;
}

/** An RD's instalment dates up to `end`, none on or after maturity. */
export function instalmentDates(terms: DepositTerms, end: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let i = 0; i < 1200; i++) {
    const date = addMonthsToDate(terms.startDate, i);
    if (date > end) break;
    if (terms.maturityDate && date >= terms.maturityDate) break;
    out.push(date);
  }
  return out;
}

/**
 * PPF and EPF: interest month by month on an eligible balance, credited at
 * the end of the financial year.
 *
 * `cutoff` is the day of the month whose closing balance starts the month's
 * reckoning — 5 for a PPF (money in by the 5th earns that month), 0 for an EPF
 * (the balance the month opened with; this month's contribution earns from
 * next month). Money taken out later in the month lowers the eligible balance;
 * money paid in after the cutoff does not raise it. A month still running on
 * the day asked about earns nothing yet.
 */
function providentFund(
  terms: DepositTerms, end: IsoDate, contributions: Contribution[], cutoff: number,
): Paise {
  const r = terms.rateBp / 10_000;
  const events = [
    { date: terms.startDate, amount: terms.principal },
    ...contributions.filter((c) => c.date >= terms.startDate && c.date <= end),
  ].sort((a, b) => a.date.localeCompare(b.date));

  let balance = 0;
  let accrued: Exact = 0;
  let i = 0;
  for (let month = monthOf(terms.startDate); month <= monthOf(end); month = addMonths(month, 1)) {
    const inMonth: Contribution[] = [];
    while (i < events.length && monthOf(events[i]!.date) === month) inMonth.push(events[i++]!);

    if (lastDayOfMonth(month) > end) {
      // Not over yet: the money is there, the month's interest is not.
      for (const e of inMonth) balance += e.amount;
      break;
    }
    let running = balance;
    let k = 0;
    for (; k < inMonth.length && Number(inMonth[k]!.date.slice(8, 10)) <= cutoff; k++) {
      running += inMonth[k]!.amount;
    }
    let lowest = running;
    for (; k < inMonth.length; k++) {
      running += inMonth[k]!.amount;
      lowest = Math.min(lowest, running);
    }
    balance = running;
    accrued += (Math.max(0, lowest) * r) / 12;

    if (month.endsWith("-03")) {
      balance += roundPaise(accrued);
      accrued = 0;
    }
  }
  return (balance + roundPaise(accrued)) as Paise;
}

/**
 * What the deposit is worth at the end of `on`. Nothing before it starts; its
 * matured value after it matures.
 *
 * `contributions` is the register, read only by the kinds in READS_REGISTER.
 */
export function depositValueOn(
  terms: DepositTerms, on: IsoDate, contributions: Contribution[] = [],
): Paise {
  if (on < terms.startDate) return 0 as Paise;
  const end = endFor(terms, on);
  const counted = READS_REGISTER.has(terms.kind)
    ? contributions.filter((c) => c.date >= terms.startDate && c.date <= end)
    : [];

  switch (terms.kind) {
    case "ppf":
      return providentFund(terms, end, counted, 5);
    case "epf":
      return providentFund(terms, end, counted, 0);
    case "rd": {
      const each = terms.instalment ?? 0;
      let total: Exact = 0;
      for (const date of instalmentDates(terms, end)) {
        total += grow(each, date, end, terms.rateBp, terms.compounding);
      }
      return roundPaise(total);
    }
    case "fd":
    case "other": {
      if (terms.payout === "periodic") {
        return (terms.principal + counted.reduce((s, c) => s + c.amount, 0)) as Paise;
      }
      let total: Exact = grow(terms.principal, terms.startDate, end, terms.rateBp, terms.compounding);
      for (const c of counted) total += grow(c.amount, c.date, end, terms.rateBp, terms.compounding);
      return roundPaise(total);
    }
  }
}

/**
 * The maturity date and what it pays, or null for a deposit with no maturity.
 * For a kind that reads the register this counts only what has been paid in
 * so far — nothing here assumes future contributions.
 */
export function maturity(
  terms: DepositTerms, contributions: Contribution[] = [],
): { date: IsoDate; amount: Paise } | null {
  if (!terms.maturityDate) return null;
  return { date: terms.maturityDate, amount: depositValueOn(terms, terms.maturityDate, contributions) };
}

/**
 * Refuses terms that cannot be priced, each with a sentence. Returns the
 * terms with the kind's defaults filled in.
 */
export function checkTerms(input: {
  kind: string;
  principal?: Paise | null;
  instalment?: Paise | null;
  rateBp: number;
  compounding?: string | null;
  startDate: string;
  maturityDate?: string | null;
  payout?: string | null;
}): DepositTerms {
  if (!(DEPOSIT_KINDS as readonly string[]).includes(input.kind)) {
    throw new Refusal(`Pick a kind of deposit: ${DEPOSIT_KINDS.map((k) => DEPOSIT_KIND_LABELS[k]).join(", ")}.`);
  }
  const kind = input.kind as DepositKind;
  if (!Number.isInteger(input.rateBp) || input.rateBp < 0 || input.rateBp > MAX_RATE_BP) {
    throw new Refusal("The rate is a yearly percentage from 0 to 100, to two decimal places — 7.1 for 7.10%.");
  }
  const compounding = (input.compounding || DEFAULT_COMPOUNDING[kind]) as Compounding;
  if (!(COMPOUNDINGS as readonly string[]).includes(compounding)) {
    throw new Refusal("Pick how the interest compounds: simple, monthly, quarterly, half-yearly or yearly.");
  }
  if ((kind === "ppf" || kind === "epf") && compounding !== "yearly") {
    throw new Refusal(
      `A ${kind === "ppf" ? "PPF" : "provident fund"} credits its interest once a year, on 31 March, ` +
      "so it compounds yearly.",
    );
  }
  const payout = (input.payout || "cumulative") as Payout;
  if (!(PAYOUTS as readonly string[]).includes(payout)) {
    throw new Refusal("Say whether the interest stays in the deposit or is paid out.");
  }
  if (payout === "periodic" && !(kind === "fd" || kind === "other")) {
    throw new Refusal(`A ${DEPOSIT_KIND_LABELS[kind].toLowerCase()} keeps its interest; only a fixed or other deposit pays it out.`);
  }
  if (payout === "periodic" && compounding === "simple") {
    throw new Refusal("Interest paid out is paid at a frequency — monthly, quarterly, half-yearly or yearly — not as simple interest.");
  }
  if (!isIsoDate(input.startDate)) throw new Refusal("Give the date the deposit started.");
  const maturityDate = input.maturityDate || null;
  if (maturityDate !== null && !isIsoDate(maturityDate)) throw new Refusal("The maturity date is not a date.");
  if (maturityDate !== null && maturityDate <= input.startDate) {
    throw new Refusal("A deposit matures after it starts.");
  }
  const principal = input.principal ?? 0;
  if (!Number.isInteger(principal) || principal < 0) throw new Refusal("The principal is an amount, zero or more.");
  if (kind === "fd" && principal <= 0) throw new Refusal("A fixed deposit needs the sum put in.");
  let instalment: Paise | null = null;
  if (kind === "rd") {
    instalment = input.instalment ?? 0;
    if (!Number.isInteger(instalment) || instalment <= 0) {
      throw new Refusal("A recurring deposit needs its monthly instalment.");
    }
    if (principal !== 0) throw new Refusal("A recurring deposit is its instalments; leave the principal empty.");
  }
  return {
    kind, principal, instalment, rateBp: input.rateBp, compounding,
    startDate: input.startDate, maturityDate, payout,
  };
}
