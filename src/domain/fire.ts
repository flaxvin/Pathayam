/**
 * How long until the household could stop earning.
 *
 * The arithmetic is not the hard part. A corpus that throws off enough to cover
 * a year's spending, forever, is expenses divided by a withdrawal rate, and the
 * years to reach it are compound interest solved for time. What makes this
 * worth writing carefully is that every input is a place to be quietly wrong in
 * a direction that flatters the reader.
 *
 * Three of those are handled here rather than left to the screen:
 *
 * **Expenses are what left the envelopes, not what left the bank.** B77 is the
 * standing warning: the same household spent ₹22,010 in a month the app
 * reported ₹1,060, because the measure counted cash leaving budget accounts and
 * the card did the rest. A FIRE number is that measure multiplied by twenty-five
 * or more, so the error is not a wrong tile — it is telling somebody they can
 * retire on a fifth of what they need. `envelopeSpendBetween` is the one
 * definition, and this uses it.
 *
 * **A house is not a retirement.** The net worth page is right to count the
 * property, the car and the money a cousin owes. None of them pay for
 * groceries: you cannot sell a tenth of the flat you live in every year. Only
 * assets that can actually be drawn down are counted, and everything excluded is
 * named on the page so the gap against net worth is visible rather than
 * mysterious.
 *
 * **EPF and NPS are not available to somebody retiring at forty.** This is the
 * Indian-specific trap, and the one a spreadsheet copied from an American blog
 * gets wrong. A provident fund balance is real money that is genuinely part of
 * the plan at sixty and genuinely unreachable before it, so it is counted
 * separately and the years between are reported as what they are: a bridge the
 * liquid corpus has to cover alone.
 *
 * **Nothing further is earned.** The corpus grows at its own real return and by
 * no other means — no salary, no continued saving. It answers "when is what I
 * already hold enough", not "when could I stop if I keep saving at this rate",
 * because the second question needs a contribution assumed decades forward and
 * that is the easiest promise on this screen to make and not keep.
 *
 * Everything here is a projection, so it is arithmetic on assumptions rather
 * than a fact about the household. `terms.html` already says no figure in this
 * app is advice; this is the screen where that matters most.
 */

import type { DB } from "../db/db.ts";
import { todayIST, addDays, addMonths, monthOf, type IsoDate, type MonthKey } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";
import { accountBalances, envelopeSpendBetween } from "../engine/repository.ts";
import { queryAll } from "../db/db.ts";
import { hiddenAccountIds, type HolderScope } from "./accounts.ts";
import {
  listValuableAccounts, listHoldings, viewHolding, valuationInBase,
  type AssetSubtype,
} from "./assets.ts";
import { incomeVsExpense } from "./reports.ts";

/**
 * Assets a person can actually spend in the year they stop working.
 *
 * Deposits are in because an Indian household's safety is often an FD rather
 * than a fund, and leaving them out would understate the corpus of exactly the
 * conservative saver most likely to be reading this.
 */
const DRAWABLE_NOW: ReadonlySet<string> = new Set([
  "investment", "deposit", "commodity", "fixed-deposit", "recurring-deposit",
]);

/** Real money, genuinely part of the plan, genuinely locked until 58-60. */
const LOCKED_UNTIL_RETIREMENT: ReadonlySet<string> = new Set(["retirement"]);

/**
 * Counted by the net worth page, not by this one, and each for its own reason:
 * `physical` is the roof over their head, `receivable` is somebody else's
 * intention to pay, and `asset` is the untyped catch-all that could be either.
 */
const NOT_A_RETIREMENT: ReadonlySet<string> = new Set([
  "physical", "receivable", "asset",
]);

export interface CorpusLine {
  label: string;
  accountId: string;
  value: Paise;
  subtype: string;
}

export interface FireAssumptions {
  /**
   * The share of the corpus drawn in the first year, in basis points.
   *
   * 4% is the number everyone has heard, and it comes from US data: a 30-year
   * horizon, a 50/50 domestic portfolio, and US inflation. Indian inflation has
   * run higher for most of living memory, and somebody retiring early is asking
   * the corpus to last fifty years rather than thirty. Both push the safe rate
   * down, so the default here is 3.5% and the page shows what 4% would claim
   * instead — the gap between them is the honest uncertainty, and hiding it
   * would be the only real mistake.
   */
  withdrawalRateBp: number;
  /**
   * Expected return *after* inflation, in basis points. Working in real terms is
   * what lets today's expenses stand in for the future's without a separate
   * inflation figure quietly compounding somewhere out of sight.
   */
  realReturnBp: number;
  /** Whether a provident fund counts toward the target at all. */
  includeLocked: boolean;
  /** Age now and the age the locked corpus unlocks, for the bridge. */
  currentAge: number | null;
  unlockAge: number;
}

export const DEFAULT_ASSUMPTIONS: FireAssumptions = {
  withdrawalRateBp: 350,
  realReturnBp: 500,
  includeLocked: true,
  currentAge: null,
  unlockAge: 60,
};

export interface FireProjection {
  asOf: IsoDate;
  windowDays: number;
  /** True when the history is too short for the trailing year to mean anything. */
  windowIsShort: boolean;

  annualExpenses: Paise;
  annualIncome: Paise;
  annualSavings: Paise;
  savingsRatePct: number | null;

  drawableNow: Paise;
  lockedUntilRetirement: Paise;
  corpus: Paise;
  excluded: Paise;

  drawableLines: CorpusLine[];
  lockedLines: CorpusLine[];
  excludedLines: CorpusLine[];

  /** Expenses ÷ withdrawal rate. */
  fireNumber: Paise;
  /** What the familiar 4% rule would claim instead, for comparison. */
  fireNumberAtFourPercent: Paise;
  progressPct: number;
  shortfall: Paise;

  yearsToFire: number | null;
  /*
   * A month, not a day. The projection rests on a trailing average and an
   * assumed real return, so naming the 14th of September would be precision the
   * inputs cannot support — and a reader believes a date far more readily than
   * a range.
   */
  fireMonth: MonthKey | null;
  /** Years the liquid corpus must cover alone before a provident fund unlocks. */
  bridgeYears: number | null;
  bridgeCovered: boolean | null;

  assumptions: FireAssumptions;
}

/**
 * Years for `current` to reach `target`, saving `annual` a year at `rate`.
 *
 * Solved rather than iterated: with a constant contribution the balance after n
 * years is `P(1+r)^n + C·((1+r)^n − 1)/r`, and setting that equal to the target
 * gives n directly. Returns null when it never arrives — which is the true
 * answer for a household saving nothing, and much better than a number.
 */
export function yearsToTarget(
  current: number, annual: number, rate: number, target: number,
): number | null {
  if (current >= target) return 0;
  if (annual <= 0 && rate <= 0) return null;

  let years: number;
  if (rate <= 0) {
    if (annual <= 0) return null;
    years = (target - current) / annual;
  } else {
    const numerator = target * rate + annual;
    const denominator = current * rate + annual;
    // Saving nothing into an empty pot, or the contribution exactly cancelling
    // the growth — either way the balance never climbs to the target.
    if (denominator <= 0 || numerator <= 0) return null;
    years = Math.log(numerator / denominator) / Math.log(1 + rate);
  }

  // The guards belong to both branches, not just the compounding one. Saving ₹1
  // a year towards ₹10,00,000 is not a plan that takes 999,999 years; it is not
  // a plan, and the difference matters because the first renders as a date.
  if (!Number.isFinite(years) || years < 0) return null;
  return years > 100 ? null : years;
}

export function fireProjection(
  db: DB,
  opts: {
    asOf?: IsoDate;
    windowDays?: number;
    viewerMemberId?: string | null;
    scope?: HolderScope;
    assumptions?: Partial<FireAssumptions>;
    baseCurrency?: string;
  } = {},
): FireProjection {
  const asOf = opts.asOf ?? todayIST();
  const windowDays = opts.windowDays ?? 365;
  const baseCurrency = opts.baseCurrency ?? "INR";
  const assumptions: FireAssumptions = { ...DEFAULT_ASSUMPTIONS, ...opts.assumptions };
  const from = addDays(asOf, -windowDays);

  // --- What a year costs ----------------------------------------------------
  const spend = envelopeSpendBetween(db, from, asOf, opts.viewerMemberId);
  const annualExpenses = Math.round((spend / windowDays) * 365);

  const income = incomeVsExpense(db, from, asOf, undefined, opts.viewerMemberId)
    .reduce((sum, point) => sum + point.income, 0);
  const annualIncome = Math.round((income / windowDays) * 365);
  const annualSavings = annualIncome - annualExpenses;
  const savingsRatePct = annualIncome > 0
    ? (annualSavings / annualIncome) * 100
    : null;

  // Is there enough history for a trailing year to be a year?
  const earliest = queryAll<{ d: string }>(
    db, `SELECT MIN(date) AS d FROM transactions WHERE deleted_at IS NULL`,
  )[0]?.d ?? null;
  const windowIsShort = earliest === null || earliest > from;

  // --- What the household holds ---------------------------------------------
  const balances = accountBalances(db);
  const hidden = opts.viewerMemberId === undefined
    ? new Set<string>()
    : hiddenAccountIds(db, opts.viewerMemberId ?? null, opts.scope ?? "household");

  const drawableLines: CorpusLine[] = [];
  const lockedLines: CorpusLine[] = [];
  const excludedLines: CorpusLine[] = [];

  // Cash in the budget accounts is drawable by definition — it is already being
  // drawn from. Credit balances are not netted off here: the card is settled
  // out of this month's envelopes, and it is this month's spending, not a claim
  // against the retirement corpus.
  for (const a of queryAll<{ id: string; name: string }>(
    db, `SELECT id, name FROM accounts WHERE kind = 'budget' AND closed_at IS NULL ORDER BY name`,
  )) {
    if (hidden.has(a.id)) continue;
    const value = balances.get(a.id)?.working ?? 0;
    if (value === 0) continue;
    drawableLines.push({ label: a.name, accountId: a.id, value, subtype: "cash" });
  }

  for (const account of listValuableAccounts(db)) {
    if (hidden.has(account.id)) continue;

    // Valued the same way the net worth page values it, so the two pages can
    // never disagree about what a holding is worth.
    let value = 0;
    const holdings = listHoldings(db, account.id);
    if (holdings.length > 0) {
      for (const holding of holdings) {
        const view = viewHolding(db, holding.id, asOf, baseCurrency);
        if (view) value += view.marketValue;
      }
    } else {
      const valuation = valuationInBase(db, account, asOf, baseCurrency);
      if (!valuation) continue;
      value = valuation.value;
    }
    if (value === 0) continue;

    const line: CorpusLine = {
      label: account.name, accountId: account.id, value, subtype: account.subtype,
    };
    if (DRAWABLE_NOW.has(account.subtype)) drawableLines.push(line);
    else if (LOCKED_UNTIL_RETIREMENT.has(account.subtype)) lockedLines.push(line);
    else if (NOT_A_RETIREMENT.has(account.subtype)) excludedLines.push(line);
  }

  const sum = (lines: CorpusLine[]) => lines.reduce((t, l) => t + l.value, 0);
  const drawableNow = sum(drawableLines);
  const lockedUntilRetirement = sum(lockedLines);
  const excluded = sum(excludedLines);
  const corpus = drawableNow + (assumptions.includeLocked ? lockedUntilRetirement : 0);

  // --- The target -----------------------------------------------------------
  const rate = assumptions.withdrawalRateBp / 10_000;
  const fireNumber = rate > 0 ? Math.round(annualExpenses / rate) : 0;
  const fireNumberAtFourPercent = Math.round(annualExpenses / 0.04);
  const progressPct = fireNumber > 0 ? (corpus / fireNumber) * 100 : 0;
  const shortfall = Math.max(0, fireNumber - corpus);

  /*
   * Nothing further is added.
   *
   * The corpus grows on its own return and on nothing else: no salary, no
   * continued saving, no raise. That is a deliberately harsher question than
   * the usual one — not "when could I retire if I keep working and saving at
   * this rate", but "when does what I already hold become enough on its own".
   *
   * It is the honest question for a plan whose whole premise is that the
   * earning stops, and it cannot flatter the reader the way a projected
   * contribution does: a savings rate assumed twenty years forward is the
   * single easiest place for this screen to promise something it has no way to
   * know. Income is still measured and shown, as context for the gap; it is
   * just not spent twice.
   */
  const yearsToFire = fireNumber > 0
    ? yearsToTarget(corpus, 0, assumptions.realReturnBp / 10_000, fireNumber)
    : null;

  const fireMonth = yearsToFire === null
    ? null
    : addMonths(monthOf(asOf), Math.round(yearsToFire * 12));

  // --- The bridge -----------------------------------------------------------
  // Only meaningful once we know how old they are and when they would stop.
  let bridgeYears: number | null = null;
  let bridgeCovered: boolean | null = null;
  if (
    assumptions.currentAge !== null && yearsToFire !== null && lockedUntilRetirement > 0
  ) {
    const ageAtFire = assumptions.currentAge + yearsToFire;
    bridgeYears = Math.max(0, assumptions.unlockAge - ageAtFire);
    // What the liquid side alone has to carry until the fund opens. Growth
    // during the bridge is deliberately ignored: a drawdown that depends on a
    // good decade is not a bridge, it is a hope.
    bridgeCovered = bridgeYears === 0
      || drawableNow >= Math.round(annualExpenses * bridgeYears);
  }

  return {
    asOf, windowDays, windowIsShort,
    annualExpenses, annualIncome, annualSavings, savingsRatePct,
    drawableNow, lockedUntilRetirement, corpus, excluded,
    drawableLines, lockedLines, excludedLines,
    fireNumber, fireNumberAtFourPercent, progressPct, shortfall,
    yearsToFire, fireMonth, bridgeYears, bridgeCovered,
    assumptions,
  };
}
