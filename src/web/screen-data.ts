/**
 * The figures behind a handful of screens, without the screen.
 *
 * These were computed inline in their route handlers, which was fine while a
 * page was the only thing that read them. The analysis layer (`src/ai/`) and
 * its snapshot export read the same figures for somebody who is not looking at
 * a page, and a second copy of the arithmetic is the copy that drifts — the
 * Overview's net-worth headline once disagreed with the page behind it by
 * exactly the private money it should not have counted. So the route and the
 * analysis both call these, and the rules are identical by construction.
 *
 * Moved verbatim from `app.ts`: each takes, as arguments, what its route read
 * from the request, and nothing else changed.
 */

import type { DB } from "../db/db.ts";
import { queryAll, queryOne } from "../db/db.ts";
import type { Paise } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import {
  todayIST, fiscalYearOf, addDays, addMonths, monthOf, lastDayOfMonth, daysBetween, type MonthKey,
} from "../core/dates.ts";
import { listMembers } from "../auth/sessions.ts";
import {
  listAccounts, paymentCategoryFor, lastCardStatement, creditedSinceStatement, nextDueByDay, hiddenAccountIds,
  DERIVED_VALUE_SUBTYPES, type HolderScope,
} from "../domain/accounts.ts";
import { listCategories } from "../domain/budget.ts";
import { listLoans, projectLoan } from "../domain/loans.ts";
import {
  listHoldings, viewHolding, standingValuation, listAssetAccounts, listValuableAccounts,
  valuationInBase,
} from "../domain/assets.ts";
import { getDepositTerms, listMaturities } from "../domain/deposits.ts";
import { netWorthStatement, netWorthHistory } from "../domain/networth.ts";
import { listSchedules, projectCashflow, describeCashflow } from "../domain/schedules.ts";
import { policiesDueBy, policyTaxSuggestion, applyPolicySuggestion } from "../domain/insurance.ts";
import { envelopeSpendByMonth } from "../domain/reports.ts";
import { spendingInsights } from "../domain/insights.ts";
import { cameWithTheCard } from "../domain/card-shortfall.ts";
import {
  staleRatesWarning, assertKnownYear, RATES_VERIFIED_ON, RATES_SOURCE, RULES, ADVANCE_TAX_RULES,
  estimateTax, advanceTaxSchedule, getDeclaration, hasDeclaration,
  incomeInFinancialYear, settle, taxPaid, listTaxPayments,
  type AdvanceInstalment,
} from "../domain/tax.ts";
import { homeLoanInterestFor } from "../domain/home-loan-interest.ts";
import { capitalGainsTaxFor, type GainsTax } from "../domain/capital-gains-tax.ts";
import { ltcgHarvestHint, type HarvestHint } from "../domain/ltcg-harvest.ts";
import { accountBalances, creditOutstanding } from "../engine/repository.ts";
import { cardFunding } from "../engine/engine.ts";
import { xirr } from "../portfolio/holdings.ts";
import { buildBudgetView } from "./viewmodel.ts";
import type { AccountRow } from "./pages/accounts.ts";
import type { CardDue } from "./pages/cards.ts";
import type { PortfolioRow } from "./pages/portfolio.ts";
import type { renderOverview } from "./pages/overview.ts";
import type { TaxPageProps } from "./pages/tax.ts";

/**
 * What an account is actually worth, when that is not its transaction balance.
 *
 * A loan's balance is whatever has been posted to the account, which is usually
 * nothing — the debt lives in its amortisation schedule. A demat account is the
 * same: the holdings carry the value. So a list of accounts showed "₹0" against
 * eighteen lakh of debt, next to a button offering to add a transaction that
 * would then appear on no screen.
 *
 * Returns null for accounts worth exactly what their transactions say, which is
 * most of them.
 */
export function derivedWorth(
  db: DB, account: { id: string; subtype: string },
  viewerMemberId: string | null,
): { value: Paise; label: string; href: string } | null {
  if (!DERIVED_VALUE_SUBTYPES.has(account.subtype)) return null;

  if (account.subtype === "loan" || account.subtype === "emi") {
    // Scoped, though the account itself is already one this viewer can see —
    // an unscoped read here would still be a read of the whole household.
    const loan = listLoans(db, { viewerMemberId }).find((l) => l.account_id === account.id);
    const projection = loan ? projectLoan(db, loan.id) : null;
    return {
      value: (projection ? -projection.outstanding : 0) as Paise,
      label: "Open the loan",
      href: loan ? `/loans/${loan.id}` : "/loans",
    };
  }

  if (account.subtype === "family-loan") {
    return { value: 0 as Paise, label: "Open lending", href: "/family" };
  }

  if (account.subtype === "investment") {
    const total = listHoldings(db, account.id).reduce((sum, h) => {
      const view = viewHolding(db, h.id);
      return sum + (view?.marketValue ?? 0);
    }, 0);
    return { value: total as Paise, label: "Open the portfolio", href: "/portfolio" };
  }

  const valuation = standingValuation(db, account.id);
  return {
    value: (valuation?.value ?? 0) as Paise,
    label: "Open the portfolio",
    href: "/portfolio",
  };
}

/**
 * S2 · The rows of the accounts list: the accounts of one budget, plus the
 * tracking accounts, which fund no budget and so belong to the household's
 * picture whichever one is selected (FW1).
 */
export function accountRows(
  db: DB,
  opts: { budgetId: string; viewerMemberId: string | null; includeClosed?: boolean },
): AccountRow[] {
  const { budgetId: scope, viewerMemberId } = opts;
  const balances = accountBalances(db);
  const outstanding = creditOutstanding(db);
  const view = buildBudgetView(db, undefined, scope, viewerMemberId);

  const memberNames = new Map(listMembers(db).map((m) => [m.id, m.name]));
  return listAccounts(db, { viewerMemberId, includeClosed: opts.includeClosed })
    .filter((account) => account.kind === "tracking" || account.budget_id === scope)
    .map((account) => {
      const recon = queryOne<{ as_of: string; broken_at: string | null }>(
        db,
        `SELECT as_of, broken_at FROM reconciliations WHERE account_id = ? ORDER BY as_of DESC LIMIT 1`,
        account.id,
      );
      const paymentCategory = account.kind === "credit" ? paymentCategoryFor(db, account.id) : null;
      const funded = paymentCategory ? view.categories.get(paymentCategory.id)?.state.balance ?? 0 : 0;

      return {
        account,
        holderName: account.holder_member_id ? memberNames.get(account.holder_member_id) ?? null : null,
        balances: balances.get(account.id)!,
        derived: derivedWorth(db, account, viewerMemberId),
        // DEPOSITS · A deposit with terms is worth what they say, as on net worth.
        deposit: getDepositTerms(db, account.id)
          ? (() => {
              const v = standingValuation(db, account.id);
              return v ? { value: v.value, source: v.source } : null;
            })()
          : null,
        unclearedCount:
          queryOne<{ n: number }>(
            db,
            `SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND cleared = 0 AND deleted_at IS NULL`,
            account.id,
          )?.n ?? 0,
        lastReconciled: recon?.as_of ?? null,
        checkpointBroken: Boolean(recon?.broken_at),
        funding:
          account.kind === "credit"
            ? cardFunding(
                account.id,
                outstanding.get(account.id) ?? 0,
                funded,
                view.monthState.unfundedByAccount[account.id] ?? 0,
              )
            : null,
        // S15 · A recent running-balance series for an inline sparkline. Walk
        // the last few dozen transactions back from the current balance.
        balanceSeries: (() => {
          const recent = queryAll<{ amount: number }>(
            db,
            `SELECT amount FROM transactions WHERE account_id = ? AND deleted_at IS NULL
              ORDER BY date DESC, created_at DESC LIMIT 24`,
            account.id,
          );
          if (recent.length < 2) return undefined;
          let bal = balances.get(account.id)!.working;
          const series = [bal];
          for (const t of recent) { bal -= t.amount; series.push(bal); }
          return series.reverse();
        })(),
      };
    });
}

/**
 * 15 §3A.5 · The cards of one budget and what each owes, soonest due first.
 * A card's debt, and the envelope funding it, belong to the budget that owns
 * the account.
 */
export function cardsDue(
  db: DB, opts: { month: MonthKey; budgetId: string; viewerMemberId: string | null },
): CardDue[] {
  const { month, budgetId: scope, viewerMemberId } = opts;
  const view = buildBudgetView(db, month, scope, viewerMemberId);
  // WEBUX-2 · The envelope is the viewed month's, so the debt it is weighed
  // against is too; what the card owes, beside its statement, is today's.
  const outstanding = creditOutstanding(db, month);
  const owedNow = month < monthOf(todayIST()) ? creditOutstanding(db) : outstanding;
  const today = todayIST();

  return listAccounts(db, { viewerMemberId })
    .filter((a) => a.kind === "credit" && a.budget_id === scope)
    .map((account) => {
      const payment = [...view.categories.values()]
        .find((c) => c.paymentAccountId === account.id) ?? null;
      const funded = payment?.state.balance ?? 0;
      const funding = cardFunding(
        account.id,
        outstanding.get(account.id) ?? 0,
        funded,
        view.monthState.unfundedByAccount[account.id] ?? 0,
        account.opening_balance,
      );
      const statement = lastCardStatement(db, account.id);
      const owed = Math.max(0, -(owedNow.get(account.id) ?? 0)) as Paise;
      // UI-9 · With no statement, the due day stored on the card, as the
      // cashflow projection already pays it.
      const dueByDay = !statement && owed > 0 && account.due_day ? nextDueByDay(account.due_day, today) : null;

      return {
        accountId: account.id,
        name: account.nickname || account.name,
        last4: account.last4,
        startingDebtNote: cameWithTheCard(funding),
        owed,
        credit: Math.max(0, owedNow.get(account.id) ?? 0) as Paise,
        funded,
        setAside: funding.setAside,
        unfunded: funding.unfunded,
        statement: statement
          ? {
              amount: statement.amount, date: statement.statement_date,
              due: statement.due_date, minimum: statement.minimum_due,
            }
          : null,
        dueByDay,
        daysToDue: statement ? daysBetween(today, statement.due_date)
          : dueByDay ? daysBetween(today, dueByDay) : null,
        paidSinceStatement: statement
          ? creditedSinceStatement(db, account.id, statement.statement_date)
          : (0 as Paise),
        paymentCategoryId: payment?.id ?? null,
      };
    })
    /*
     * Soonest first. A card with no statement sorts by its stored due day
     * (UI-9); one with neither has no due date to sort by, so it goes last
     * rather than being guessed at — R6 never invents a cycle.
     */
    .sort((a, b) => {
      if (a.daysToDue === null && b.daysToDue === null) return b.owed - a.owed;
      if (a.daysToDue === null) return 1;
      if (b.daysToDue === null) return -1;
      return a.daysToDue - b.daysToDue;
    });
}

/**
 * S8 · Whether a schedule is listed under one budget on the Schedules screen.
 */
export function scheduleInScope(
  db: DB, opts: { budgetId: string; viewerMemberId: string | null },
): (s: { account_id: string | null; category_id: string | null }) => boolean {
  const { budgetId: scope, viewerMemberId } = opts;
  /*
   * 15 §3A.4 · A schedule belongs to a budget through **either** end: the
   * account the money comes out of, or the envelope it lands in. Those differ
   * exactly when one of you pays a shared bill from your own account, and the
   * rent is then a household schedule and hers at once — which is the same rule
   * Query uses for a transaction that crosses budgets.
   *
   * Scoping on the account alone made five household bills vanish from the
   * household's list the moment the account paying them moved into a personal
   * budget. The cashflow projection stays account-based, because that one is
   * about whose cash actually leaves.
   */
  const accountsInScope = new Set(
    listAccounts(db, { viewerMemberId })
      .filter((a) => a.budget_id === scope)
      .map((a) => a.id),
  );
  const categoriesInScope = new Set(
    listCategories(db, { includeHidden: true, budgetId: scope, viewerMemberId })
      .map((c) => c.id),
  );
  /*
   * A tracking account belongs to no budget, and money into it names no
   * envelope — so a "PPF deposit" schedule matched neither end in any scope:
   * "Schedule added.", then never listed, with no Paid, Skip, Edit or Remove
   * anywhere. With no envelope to place it, it shows wherever its account is
   * visible, the way a schedule with neither end always has.
   */
  const unbudgetedAccounts = new Set(
    listAccounts(db, { viewerMemberId })
      .filter((a) => a.budget_id === null)
      .map((a) => a.id),
  );
  return (s: { account_id: string | null; category_id: string | null }): boolean =>
    (!s.account_id && !s.category_id)
    || (s.account_id !== null && accountsInScope.has(s.account_id))
    || (s.category_id !== null && categoriesInScope.has(s.category_id))
    || (s.category_id === null && s.account_id !== null && unbudgetedAccounts.has(s.account_id));
}

/**
 * S16 · The Overview's figures for one budget: the five most-checked numbers
 * from the budget, cashflow, net worth and insight engine.
 */
export function overviewData(
  db: DB, opts: {
    budgetId: string; viewerMemberId: string | null; assets: boolean;
    /** PLAN-1 · A module that is off leaves its items out of "due soon". Omitted is on. */
    schedules?: boolean; insurance?: boolean; deposits?: boolean;
  },
): Parameters<typeof renderOverview>[0] {
  const { budgetId: scope, viewerMemberId } = opts;
  const view = buildBudgetView(db, undefined, scope, viewerMemberId);
  const month = view.month;
  // DEBUG-ENGINE-9 · The budget on screen, as the Schedules page asks it.
  const cashflow = projectCashflow(db, { days: 60, budgetId: scope, viewerMemberId });
  const outstanding = creditOutstanding(db);
  const unfundedCards = [...view.categories.values()]
    .filter((c) => c.paymentAccountId)
    .map((c) => ({
      name: c.name,
      amount: cardFunding(
        c.paymentAccountId!,
        outstanding.get(c.paymentAccountId!) ?? 0,
        c.state.balance,
        view.monthState.unfundedByAccount[c.paymentAccountId!] ?? 0,
      ).unfunded,
    }))
    .filter((c) => c.amount > 0);
  /*
   * B78 · Both figures below are envelope spend, not cash through budget
   * accounts. The tile read "Spent this month ₹1,060" on a month the
   * household spent ₹22,010, because 95% of it was on cards — and the runway
   * denominator had the same blind spot, which is the more dangerous of the
   * two: it reported months of safety the household did not have.
   */
  const monthSpend =
    (envelopeSpendByMonth(db, `${month}-01`, todayIST(), scope, viewerMemberId)
      .at(-1)?.spent ?? 0) as Paise;

  // #12 · Months of runway = liquid cash ÷ typical monthly spend (mean of the
  // three complete months before this one, so a partial month doesn't skew it).
  const bals = accountBalances(db);
  const cash = listAccounts(db, { viewerMemberId })
    .filter((acc) => acc.kind === "budget" && acc.budget_id === scope)
    .reduce((sum, acc) => sum + Math.max(0, bals.get(acc.id)?.working ?? 0), 0);
  const priorMonths = envelopeSpendByMonth(
    db, `${addMonths(month, -3)}-01`, lastDayOfMonth(addMonths(month, -1)), scope, viewerMemberId,
  );
  const avgMonthlySpend = priorMonths.length
    ? priorMonths.reduce((s, m) => s + m.spent, 0) / priorMonths.length
    : 0;
  const runwayMonths = avgMonthlySpend > 0 ? cash / avgMonthlySpend : null;

  // #13 · Bills due in the next fortnight, each with a one-tap "mark paid".
  const soon = addDays(todayIST(), 14);
  // 15 §3A.4 · Either end, the same as the schedules screen: a household bill
  // paid from somebody's own account is still a household bill.
  const budgetAccounts = new Set(
    listAccounts(db, { viewerMemberId })
      .filter((acc) => acc.budget_id === scope)
      .map((acc) => acc.id),
  );
  const budgetCategories = new Set(
    listCategories(db, { includeHidden: true, budgetId: scope, viewerMemberId })
      .map((c) => c.id),
  );
  const dueSoon = (opts.schedules === false ? [] : listSchedules(db, { viewerMemberId }))
    .filter((s) => s.next_due && s.next_due <= soon && (s.amount ?? 0) < 0)
    .filter((s) =>
      (!s.account_id && !s.category_id)
      || (s.account_id !== null && budgetAccounts.has(s.account_id))
      || (s.category_id !== null && budgetCategories.has(s.category_id)))
    .sort((x, y) => (x.next_due ?? "").localeCompare(y.next_due ?? ""))
    .map((s) => ({ id: s.id, name: s.name, amount: Math.abs(s.amount ?? 0) as Paise, nextDue: s.next_due! }))
    // INSURANCE-1 · Premiums and renewals, in the same fortnight.
    .concat((opts.insurance === false ? [] : policiesDueBy(db, { viewerMemberId, until: soon, budgetId: scope }))
      .map((p) => ({ ...p, policy: true })))
    .sort((x, y) => x.nextDue.localeCompare(y.nextDue))
    .slice(0, 6);

  return {
    month,
    rta: view.monthState.readyToAssign,
    rtaState: view.monthState.rtaState,
    /*
     * H2.2 · With the viewer, the same as the net-worth page itself. Without
     * it this headline was the whole household's — so somebody saw ₹55.6L
     * here and ₹28.6L on the page behind it, and the difference was the
     * private money they could not see, published by subtraction.
     */
    netWorth: opts.assets
      ? netWorthStatement(db, undefined, "INR", { viewerMemberId }).netWorth
      : (0 as Paise),
    netWorthHistory: opts.assets ? netWorthHistory(db) : [],
    cashflow,
    cashflowReading: describeCashflow(cashflow),
    unfundedCards,
    insights: spendingInsights(db, todayIST(), 4, viewerMemberId),
    monthSpend,
    cash: cash as Paise,
    runwayMonths,
    dueSoon,
    // DEPOSITS · Maturities in the same fortnight, from accounts this
    // member can see. Shown, never posted.
    maturing: (opts.deposits === false ? [] : listMaturities(db, { from: todayIST(), to: soon, viewerMemberId }))
      .map((m) => ({ accountId: m.accountId, name: m.name, amount: m.amount, date: m.date })),
  };
}

/** S13 · The portfolio page's holdings, hand-valued assets and pooled XIRR. */
export function portfolioData(
  db: DB, opts: { viewerMemberId: string | null; scope: HolderScope },
): {
  rows: PortfolioRow[];
  manualAssets: {
    id: string; name: string; subtype: string; value: Paise;
    asOf: string | null; stale: boolean; valued: boolean;
  }[];
  portfolioXirr: number | null;
} {
  const { viewerMemberId, scope } = opts;
  const balances = accountBalances(db);
  const hidden = hiddenAccountIds(db, viewerMemberId, scope);
  const accounts = new Map(
    listAssetAccounts(db, { viewerMemberId })
      .filter((a) => !hidden.has(a.id))
      .map((a) => [a.id, a.name]),
  );

  const rows: PortfolioRow[] = listHoldings(db)
    .filter((h) => accounts.has(h.account_id))
    .map((h) => {
      const view = viewHolding(db, h.id);
      return view ? { view, accountName: accounts.get(view.holding.account_id) ?? "" } : null;
    })
    .filter((r): r is PortfolioRow => r !== null);

  // F19.16 · A portfolio-level XIRR, labelled money-weighted — pooled from
  // each holding's own flows, dividends included (WEALTH-25).
  const flows = rows.flatMap((r) => r.view.cashFlows);

  /*
   * B101 · An asset with no valuation yet is still an asset.
   *
   * This dropped them, so adding "SafeGold" and not immediately valuing it
   * made the account disappear from Portfolio and from Net worth both — the
   * account was in the database and nowhere on screen, with nothing
   * prompting for the number that would bring it back. A thing that vanishes
   * after you create it is the worst way to lose someone's trust in a ledger.
   */
  /*
   * listValuableAccounts, not listAssetAccounts.
   *
   * The first covers the six asset subtypes; the second adds the plain ones —
   * "other asset", "other liability", fixed and recurring deposits. The
   * revalue-everything screen already used the wider list, so those accounts
   * appeared there, could be revalued, and were then nowhere on this page.
   * The same account being on one screen and not the other is how a household
   * concludes the revaluation did nothing.
   */
  const manualAssets = listValuableAccounts(db, { viewerMemberId })
    // A portfolio is what you hold. A deposit belongs here — it is an
    // investment, and a household thinks of it as one — but "other
    // liability" does not: it is a debt, it belongs on net worth's other
    // side, and it is revaluable from the valuations screen without
    // appearing on a page headed Portfolio.
    .filter((a) => a.subtype !== "liability")
    .filter((a) => listHoldings(db, a.id).length === 0)
    .map((a) => {
      // DEPOSITS · Computed from terms where it has them (standingValuation).
      // In rupees: an SGD savings balance of 41,120 was printed "₹41,120"
      // here while net worth and FIRE counted it as ₹25 lakh.
      const valuation = valuationInBase(db, a, todayIST());
      /*
       * A deposit is worth its balance unless somebody has said otherwise
       * (B56), and that is the whole reason it is a tracking account: the
       * interest credited to it is a transaction, and the balance moves with
       * it. Reading only the stated valuation showed a fixed deposit holding
       * ₹5,32,000 as "no value yet", which is the app disbelieving its own
       * ledger.
       */
      const counted = !DERIVED_VALUE_SUBTYPES.has(a.subtype);
      const balance = counted ? (balances.get(a.id)?.working ?? 0) as Paise : (0 as Paise);
      return {
        id: a.id, name: a.name, subtype: a.subtype,
        value: valuation?.value ?? balance,
        asOf: valuation?.asOf ?? (counted ? todayIST() : null),
        // "not valued recently" is about the valuation; an exchange rate a day
        // or two old is not a reason to ask the household to revalue.
        stale: valuation ? standingValuation(db, a.id)?.stale ?? false : false,
        valued: valuation !== null || (counted && balance !== 0),
      };
    });

  return { rows, manualAssets, portfolioXirr: flows.length >= 2 ? xirr(flows) : null };
}

/**
 * Q31 · Everything the tax page shows for one member and one financial year.
 *
 * Per member, because income tax in India is assessed on an individual — a
 * household figure would mix one member's salary into another's estimate.
 * `applyPolicies` is the page's "fill in from my policies" (INSURANCE-1).
 */
export function taxPageModel(
  db: DB, memberId: string, fy: number, applyPolicies: boolean,
): TaxPageProps {
  const stored = getDeclaration(db, memberId, fy);
  // INSURANCE-1 · What the member's policies come to; filled in only when asked.
  const fromPolicies = policyTaxSuggestion(db, memberId, fy);
  const apply = applyPolicies && fromPolicies.lines.length > 0;
  const visible = listAccounts(db, { viewerMemberId: memberId })
    .filter((acc) => acc.kind === "budget")
    .map((acc) => acc.id);
  const ledgerIncome = incomeInFinancialYear(db, fy, visible);
  // WEALTH-6 · A saved declaration is used as saved, ₹0 included; the
  // ledger's receipts are only the starting point before anything is saved.
  const gross = hasDeclaration(db, memberId, fy) ? stored.gross : ledgerIncome;

  // Capital gains are taxed at their own rates and are scoped to this
  // member's own holdings — the accounts they are named holder of (WEALTH-7).
  // Another member's sale is not part of their assessment, however visible.
  //
  // TAX-FY25-1 · A year whose gains rates are not in the app is refused, not
  // taxed at the newest year's. The refusal is shown on the page in place of
  // the gains, so the rest of it — declarations, payments — still works.
  let gains: GainsTax | null = null;
  let gainsRefusal: string | null = null;
  try {
    gains = capitalGainsTaxFor(db, fy, memberId);
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    gainsRefusal = err.message;
  }
  // An older year with gains rates but no slabs (2024-25) shows its gains
  // and says why there is no estimate, instead of refusing the whole page.
  let slabsRefusal: string | null = null;
  if (!staleRatesWarning(fy)) {
    try {
      assertKnownYear(fy);
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      slabsRefusal = err.message;
    }
  }

  // HARVEST-1 · Only the year in progress has an exemption left to use, and
  // only its prices mean anything for a sale that has not happened yet.
  let harvest: HarvestHint | null = null;
  if (fy === fiscalYearOf(todayIST()) && !gainsRefusal) {
    try {
      harvest = ltcgHarvestHint(db, memberId);
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
    }
  }

  // TAX-1 · Interest on loans this member holds for a house they live in,
  // accrued in the year from the loan's ledger — unless they gave their own.
  const homeLoan = homeLoanInterestFor(db, fy, memberId);
  const s24b = (stored.s24bOverride ?? homeLoan.selfOccupied) as Paise;

  // TAX-2 · What has been paid already.
  const payments = listTaxPayments(db, memberId, fy);
  const paid = taxPaid(db, memberId, fy);

  let estimate = null;
  let advance: AdvanceInstalment[] = [];
  let settlement = null;
  // WEALTH-9 · Slab-rated gains are income too: a member whose only income
  // is a debt-fund gain was told to "enter a gross income" and shown nothing.
  if ((gross > 0 || (gains?.addToSlabIncome ?? 0) > 0 || (gains?.specialRateTax ?? 0) > 0)
      && !staleRatesWarning(fy) && !gainsRefusal && !slabsRefusal) {
    estimate = estimateTax(fy, gross, { ...stored, s24b }, gains);
    settlement = { old: settle(estimate.old, paid), new: settle(estimate.new, paid) };
    // TAX-3 · Section 208 tests the year's tax after TDS, not before.
    const liability = Math.max(
      0, (estimate.better === "old" ? estimate.old.total : estimate.new.total) - paid.tds,
    ) as Paise;
    advance = advanceTaxSchedule(fy, liability, payments.filter((p) => p.kind === "advance"));
  }

  return {
    fy, gross, ledgerIncome, estimate, advance, gains, gainsRefusal, slabsRefusal, fromPolicies, harvest,
    applyPolicies: apply,
    deductions: apply ? applyPolicySuggestion(stored, fromPolicies) : stored,
    homeLoan, s24bOverride: stored.s24bOverride ?? null, payments, paid, settlement,
    advanceThreshold: (ADVANCE_TAX_RULES[fy] ?? ADVANCE_TAX_RULES[2025]!).threshold,
    staleWarning: staleRatesWarning(fy),
    ratesVerifiedOn: RATES_VERIFIED_ON,
    ratesSource: RATES_SOURCE,
    availableYears: Object.keys(RULES).map(Number).sort((x, y) => y - x),
  };
}
