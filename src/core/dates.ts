/**
 * Dates — civil dates in IST, no wall-clock arithmetic.
 *
 * A date in this app is a civil date: the day something happened, with no time
 * and no zone attached. It is stored and passed around as "YYYY-MM-DD" so it
 * sorts lexically, compares with ===, and cannot drift across a zone boundary.
 *
 * "Today" is always evaluated in IST regardless of the device's setting (L12).
 * A member in another zone entering a spend at 01:00 local must not book it to
 * a different day than the household sees.
 *
 * Implements L3, L4, L12 of `02` §6.
 */

/** A civil date, "YYYY-MM-DD". */
export type IsoDate = string;

/** A budget month, "YYYY-MM". The unit assignments belong to (R7). */
export type MonthKey = string;

/** IST is UTC+5:30 with no daylight saving, which makes this a fixed offset. */
const IST_OFFSET_MINUTES = 5 * 60 + 30;

export function todayIST(now: Date = new Date()): IsoDate {
  const shifted = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 10);
}

export function nowIST(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().replace("Z", "+05:30");
}

export function isIsoDate(v: unknown): v is IsoDate {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

export function isMonthKey(v: unknown): v is MonthKey {
  if (typeof v !== "string" || !/^\d{4}-\d{2}$/.test(v)) return false;
  const m = Number(v.slice(5));
  return m >= 1 && m <= 12;
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function monthOf(date: IsoDate): MonthKey {
  return date.slice(0, 7);
}

export function firstDayOfMonth(month: MonthKey): IsoDate {
  return `${month}-01`;
}

export function lastDayOfMonth(month: MonthKey): IsoDate {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5));
  return `${month}-${String(daysInMonth(year, m)).padStart(2, "0")}`;
}

/** Shift a month key by `delta` months. addMonths("2026-12", 1) === "2027-01". */
export function addMonths(month: MonthKey, delta: number): MonthKey {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5));
  const total = year * 12 + (m - 1) + delta;
  const newYear = Math.floor(total / 12);
  const newMonth = total - newYear * 12 + 1;
  return `${String(newYear).padStart(4, "0")}-${String(newMonth).padStart(2, "0")}`;
}

/** Whole months from `a` to `b`. monthsBetween("2026-08", "2026-11") === 3. */
export function monthsBetween(a: MonthKey, b: MonthKey): number {
  const ay = Number(a.slice(0, 4));
  const am = Number(a.slice(5));
  const by = Number(b.slice(0, 4));
  const bm = Number(b.slice(5));
  return (by * 12 + bm) - (ay * 12 + am);
}

export function addDays(date: IsoDate, delta: number): IsoDate {
  const t = Date.parse(`${date}T00:00:00Z`) + delta * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Clamp a day-of-month to a month that may not have it. A schedule due on the
 * 31st in February resolves by policy (F7.3).
 */
export function resolveDayOfMonth(
  month: MonthKey,
  day: number,
  policy: "last-day" | "skip" | "next-day" = "last-day",
): IsoDate | null {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5));
  const max = daysInMonth(year, m);
  if (day <= max) return `${month}-${String(day).padStart(2, "0")}`;
  if (policy === "skip") return null;
  if (policy === "last-day") return `${month}-${String(max).padStart(2, "0")}`;
  return addDays(`${month}-${String(max).padStart(2, "0")}`, 1);
}

// ---------------------------------------------------------------------------
// Display and entry — L3
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export interface StatementPeriod {
  /** First day the cycle covers. */
  start: IsoDate;
  /** The statement date itself — the last day the cycle covers. */
  end: IsoDate;
  /** "19 Sep – 18 Oct", for a column or a heading. */
  label: string;
}

/**
 * Which statement cycle a card transaction falls in, given the card's statement
 * day.
 *
 * A statement dated the 18th covers everything after the previous 18th up to and
 * including this one, so a charge on the 19th belongs to *next* month's
 * statement. Getting that boundary wrong by a day is the difference between a
 * cycle that reconciles against the paper statement and one that does not, which
 * is the whole reason to derive this rather than eyeball it.
 *
 * Short months clamp, the same way a due date does: with a statement day of 31,
 * February's statement is dated the 28th (or the 29th).
 */
export function statementPeriodOf(date: IsoDate, statementDay: number): StatementPeriod {
  const month = monthOf(date);
  const thisMonths = resolveDayOfMonth(month, statementDay, "last-day")!;

  // On or before this month's statement date, the cycle ends here; after it, the
  // charge belongs to next month's.
  const end = date <= thisMonths
    ? thisMonths
    : resolveDayOfMonth(addMonths(month, 1), statementDay, "last-day")!;

  const previous = resolveDayOfMonth(addMonths(monthOf(end), -1), statementDay, "last-day")!;
  const start = addDays(previous, 1);

  return { start, end, label: `${shortDate(start)} – ${shortDate(end)}` };
}

/** "19 Sep" — compact enough for a table column. */
function shortDate(date: IsoDate): string {
  return `${Number(date.slice(8, 10))} ${MONTH_NAMES[Number(date.slice(5, 7)) - 1]!.slice(0, 3)}`;
}

/** DD-MM-YYYY (L3). */
export function formatDate(date: IsoDate): string {
  return `${date.slice(8, 10)}-${date.slice(5, 7)}-${date.slice(0, 4)}`;
}

/**
 * "11-09-2026 14:52" — a logged timestamp, in the same DD-MM-YYYY order as
 * every other date the app shows (L3).
 *
 * Takes the stored string as written rather than parsing it into a `Date`:
 * every timestamp is already recorded in IST by `nowIST`, and re-parsing would
 * reinterpret it in whatever zone the server happens to run in.
 */
export function formatDateTime(at: string): string {
  const date = at.slice(0, 10);
  const time = at.slice(11, 16);
  if (!isIsoDate(date)) return at;
  return time ? `${formatDate(date)} ${time}` : formatDate(date);
}

/** "26th" — a day of the month, said the way a person says it. */
export function ordinal(day: number): string {
  const tail = day % 100 >= 11 && day % 100 <= 13
    ? "th"
    : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  return `${day}${tail}`;
}

/** "August 2026" — the budget screen's month heading. */
export function formatMonth(month: MonthKey): string {
  const name = MONTH_NAMES[Number(month.slice(5)) - 1] ?? month;
  return `${name} ${month.slice(0, 4)}`;
}

/** "Aug 2026" — where space is tight. */
export function formatMonthShort(month: MonthKey): string {
  const name = MONTH_NAMES[Number(month.slice(5)) - 1]?.slice(0, 3) ?? month;
  return `${name} ${month.slice(0, 4)}`;
}

/**
 * Parse a date the user typed. Accepts DD-MM-YYYY, DD/MM/YYYY, the DD-MM and
 * DD/MM shorthands (L3), and the ISO form the app itself emits.
 *
 * Shorthand resolves against `reference`'s year, choosing the nearest
 * interpretation: typing "31-12" on 02-01-2027 means last December, not a year
 * away. Returns null rather than guessing when the input is not a date.
 */
export function parseDate(input: string, reference: IsoDate = todayIST()): IsoDate | null {
  const s = input.trim();
  if (s === "") return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isIsoDate(s) ? s : null;

  const full = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (full) {
    const d = Number(full[1]);
    const m = Number(full[2]);
    let y = Number(full[3]);
    if (full[3]!.length === 2) y += y < 70 ? 2000 : 1900;
    const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return isIsoDate(iso) ? iso : null;
  }

  const short = /^(\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (short) {
    const d = Number(short[1]);
    const m = Number(short[2]);
    const refYear = Number(reference.slice(0, 4));
    const candidates = [refYear - 1, refYear, refYear + 1]
      .map((y) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`)
      .filter(isIsoDate);
    if (candidates.length === 0) return null;
    let best = candidates[0]!;
    for (const c of candidates) {
      if (Math.abs(daysBetween(reference, c)) < Math.abs(daysBetween(reference, best))) best = c;
    }
    return best;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Fiscal year — L4, L14
// ---------------------------------------------------------------------------

/**
 * The Indian financial year runs 1 April to 31 March. FY 2026-27 starts
 * 01-04-2026. Reports offer this alongside the calendar year (L4). Nothing in
 * this module computes a tax liability — that lives in `domain/tax.ts`, which
 * Q31 added after reversing L14 and N15.
 */
export function fiscalYearOf(date: IsoDate): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month >= 4 ? year : year - 1;
}

export function fiscalYearRange(startYear: number): { from: IsoDate; to: IsoDate } {
  return { from: `${startYear}-04-01`, to: `${startYear + 1}-03-31` };
}

/** "FY 2026-27" */
export function formatFiscalYear(startYear: number): string {
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}
