/**
 * TAX-1 · Home loan interest for section 24(b), from the loan's own ledger.
 *
 * ## Accrued, not paid
 *
 * Section 24(b) allows interest *payable* for the year, whether or not it was
 * paid in it — the lender's interest certificate is drawn up that way, April
 * to March. The loan interest report adds up the interest column of payments
 * dated in the year, which is cash. The two differ at the edges: an EMI on
 * 5 April is, nearly all of it, March's interest, charged in arrears.
 *
 * So each instalment's interest is spread evenly over the days it pays for —
 * from the previous instalment (or a month before, for the first one recorded,
 * or after a gap) up to its own date — and each financial year takes the days
 * that fall in it. The 5 April EMI above gives 26 of its 31 days to the year
 * that ended on 31 March. Interest in a prepayment, an extra payment or a
 * settlement is a broken period ending that day and is counted on that day.
 * Charges are not interest and are left out, as the interest report leaves
 * them out.
 *
 * Instalments not yet recorded come from the loan's projected schedule, dated
 * a month apart from the last one recorded. That is what lets a year still in
 * progress — or one whose last weeks are paid by an April instalment not yet
 * entered — show a whole year's interest rather than the part already paid.
 *
 * ## What "estimated" means
 *
 * A figure is confirmed only where every rupee of it is from a split the
 * lender gave — entered from the statement, not worked out by this app.
 * Interest from an instalment whose split the app estimated (R18.3), or from
 * the projection, makes the figure estimated, and the screen says how much of
 * it is. The lender's certificate is the number a return should use; this is
 * the number to expect, and the override on the tax screen is where the
 * certificate's figure goes.
 */

import type { DB } from "../db/db.ts";
import { queryAll } from "../db/db.ts";
import type { Paise } from "../core/money.ts";
import { addDays, daysBetween, fiscalYearRange, type IsoDate } from "../core/dates.ts";
import { shiftMonths } from "../loans/amortisation.ts";
import { getLoan, listPayments, projectLoan, type PropertyUse } from "./loans.ts";

/** Interest that accrued evenly over the days after `start`, up to and including `end`. */
export interface InterestPeriod {
  start: IsoDate;
  end: IsoDate;
  interest: Paise;
  /** From an estimated split or from the projection, not the lender's figure. */
  estimated: boolean;
}

/**
 * A gap this long between two recorded instalments (beyond the month the later
 * one pays for) means instalments were not entered, and their interest is
 * missing rather than spread.
 */
const GAP_TOLERANCE_DAYS = 5;

/** How much of each period falls between `from` and `to`, both inclusive. */
export function accrueBetween(
  periods: readonly InterestPeriod[], from: IsoDate, to: IsoDate,
): { total: Paise; estimated: Paise } {
  let total = 0, estimated = 0;
  const dayBefore = addDays(from, -1);
  for (const p of periods) {
    const days = daysBetween(p.start, p.end);
    let share: number;
    if (days <= 0) {
      share = p.end >= from && p.end <= to ? p.interest : 0;
    } else {
      const lo = p.start > dayBefore ? p.start : dayBefore;
      const hi = p.end < to ? p.end : to;
      const overlap = Math.max(0, daysBetween(lo, hi));
      share = overlap === days ? p.interest : Math.round((p.interest * overlap) / days);
    }
    total += share;
    if (p.estimated) estimated += share;
  }
  return { total: total as Paise, estimated: estimated as Paise };
}

/**
 * The loan's interest as periods: what is recorded, then what is projected.
 * `gaps` lists the stretches where instalments were not recorded.
 */
export function interestPeriods(db: DB, loanId: string): {
  periods: InterestPeriod[];
  gaps: { from: IsoDate; to: IsoDate }[];
} {
  const loan = getLoan(db, loanId);
  if (!loan) return { periods: [], gaps: [] };
  const periods: InterestPeriod[] = [];
  const gaps: { from: IsoDate; to: IsoDate }[] = [];

  // WEALTH-35 · Only rows that moved money; a waiver or re-anchor paid nothing.
  const payments = listPayments(db, loanId).filter((p) => p.amount > 0 && p.kind !== "charge");
  let lastInstalment: IsoDate | null = null;
  for (const p of payments) {
    if (p.kind !== "instalment") {
      if (p.interest > 0) {
        periods.push({ start: p.date, end: p.date, interest: p.interest, estimated: p.estimated === 1 });
      }
      continue;
    }
    const monthBefore = shiftMonths(p.date, -1);
    if (lastInstalment !== null && daysBetween(lastInstalment, monthBefore) > GAP_TOLERANCE_DAYS) {
      gaps.push({ from: addDays(lastInstalment, 1), to: monthBefore });
    }
    const start = lastInstalment !== null && lastInstalment > monthBefore ? lastInstalment : monthBefore;
    if (p.interest > 0) {
      periods.push({ start, end: p.date, interest: p.interest, estimated: p.estimated === 1 });
    }
    lastInstalment = p.date;
  }

  /*
   * The rest of the schedule, as long as its dates can be told: a month after
   * the last recorded instalment, or from the first instalment date when none
   * is recorded. A loan in its moratorium or still part-drawn runs to another
   * timetable, and is left at what is recorded.
   */
  const projection = loan.closed_at ? null : projectLoan(db, loanId);
  const anchor = lastInstalment ?? (loan.first_instalment_date ? shiftMonths(loan.first_instalment_date, -1) : null);
  if (projection && anchor && projection.moratorium === null && projection.preEmi === null) {
    let previous = anchor;
    projection.schedule.instalments.forEach((row, k) => {
      const due = shiftMonths(anchor, k + 1);
      if (row.interest > 0) periods.push({ start: previous, end: due, interest: row.interest, estimated: true });
      previous = due;
    });
  }
  return { periods, gaps };
}

export interface HomeLoanLine {
  loanId: string;
  name: string;
  use: PropertyUse;
  /** Interest accrued in the year, whole. */
  accrued: Paise;
  /** The part of `accrued` that is not the lender's own figure. */
  estimatedPart: Paise;
  /** Instalments not recorded in the year, so `accrued` is short. */
  incomplete: boolean;
  /** Whether it goes into the estimate. */
  carried: boolean;
  /** Why not, when it does not. */
  reason: string | null;
}

export interface HomeLoanInterest {
  lines: HomeLoanLine[];
  /** Self-occupied interest carried, before the cap. */
  selfOccupied: Paise;
  /** Let-out interest, shown and never deducted. */
  letOut: Paise;
  /** Some of `selfOccupied` is estimated, or some of it is missing. */
  estimated: boolean;
}

/**
 * The year's home loan interest for one member: loans marked as for a house,
 * held by them — or held by nobody, in a one-member household.
 *
 * Whose interest it is follows the loan's holder, as a capital gain follows
 * the demat's (WEALTH-7). A joint loan is carried whole to its holder; the
 * co-borrower's share is a figure each of them enters as their own.
 */
export function homeLoanInterestFor(db: DB, fy: number, memberId: string): HomeLoanInterest {
  const { from, to } = fiscalYearRange(fy);
  const soleMember = (queryAll<{ n: number }>(
    db, `SELECT COUNT(*) AS n FROM members WHERE removed_at IS NULL`,
  )[0]?.n ?? 0) <= 1;

  const loans = queryAll<{
    id: string; lender: string; nickname: string | null; loan_type: string;
    property_use: PropertyUse; holder: string | null; visibility: string;
  }>(
    db,
    `SELECT l.id, l.lender, l.nickname, l.loan_type, l.property_use,
            a.holder_member_id AS holder, a.visibility
       FROM loans l JOIN accounts a ON a.id = l.account_id
      WHERE l.property_use IS NOT NULL
        AND (a.holder_member_id = ? OR (a.holder_member_id IS NULL AND a.visibility <> 'private'))
      ORDER BY l.created_at`,
    memberId,
  );

  const lines: HomeLoanLine[] = [];
  for (const l of loans) {
    const { periods, gaps } = interestPeriods(db, l.id);
    const { total, estimated } = accrueBetween(periods, from, to);
    const incomplete = gaps.some((g) => g.from <= to && g.to >= from);
    if (total === 0 && !incomplete) continue;

    let reason: string | null = null;
    if (l.holder === null && !soleMember) {
      reason = "the loan names no holder, so whose deduction it is cannot be told — name the holder on the loan";
    } else if (l.loan_type === "home-under-construction") {
      reason = "interest before the house is finished is claimed in five equal parts from the year it is, which this app does not work out";
    } else if (l.property_use === "let-out") {
      reason = "a let-out house's interest is set against its rent, which this app does not know";
    }
    lines.push({
      loanId: l.id, name: l.nickname || l.lender, use: l.property_use,
      accrued: total, estimatedPart: estimated, incomplete,
      carried: reason === null, reason,
    });
  }

  const carried = lines.filter((x) => x.carried);
  return {
    lines,
    selfOccupied: carried.reduce((t, x) => t + x.accrued, 0) as Paise,
    letOut: lines.filter((x) => x.use === "let-out").reduce((t, x) => t + x.accrued, 0) as Paise,
    estimated: carried.some((x) => x.estimatedPart > 0 || x.incomplete),
  };
}
