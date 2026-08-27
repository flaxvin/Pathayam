/**
 * R29 · The net worth statement.
 *
 * ```
 * Net worth = Σ Budget account balances
 *           + Σ Asset account values
 *           − Σ Credit account balances
 *           − Σ Loan outstanding principal
 * ```
 *
 * R23.4 is worth restating here because it is what makes the figure sane:
 * *"omit the property and this household appears to be ₹25.3 lakh underwater.
 * Tracking a loan without its asset is worse than tracking neither."* So an
 * asset account missing against a tracked loan is surfaced, not ignored.
 *
 * FW3 / R29.5 · None of this ever reaches the budget screen. `viewmodel.ts`
 * does not import this module, and `assets.test.ts` asserts that.
 */

import type { DB } from "../db/db.ts";
import { queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, type Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf, addMonths, formatDate, type IsoDate } from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import { accountBalances } from "../engine/repository.ts";
import { listLoans, projectLoan } from "./loans.ts";
import {
  listAssetAccounts, listHoldings, viewHolding, latestValuation, ASSET_LABELS,
  type AssetSubtype,
} from "./assets.ts";

export interface NetWorthLine {
  label: string;
  accountId: string | null;
  value: Paise;
  /** R29.1 · The date this input is as of, so the total can carry its caveat. */
  asOf: IsoDate | null;
  stale: boolean;
}

export interface NetWorthGroup {
  name: string;
  total: Paise;
  lines: NetWorthLine[];
}

export interface NetWorthStatement {
  asOf: IsoDate;
  assetGroups: NetWorthGroup[];
  liabilityGroups: NetWorthGroup[];
  totalAssets: Paise;
  totalLiabilities: Paise;
  netWorth: Paise;
  /** R29.1 · The staleness of the worst input, stated with the figure. */
  worstInputDate: IsoDate | null;
  hasStaleInputs: boolean;
  /** R23.4 · Loans with no asset tracked against them. */
  untrackedAssetWarnings: string[];
}

export function netWorthStatement(
  db: DB, asOf = todayIST(), baseCurrency = "INR",
): NetWorthStatement {
  const balances = accountBalances(db);

  // --- Assets ---------------------------------------------------------------
  const cashLines: NetWorthLine[] = queryAll<{ id: string; name: string }>(
    db, `SELECT id, name FROM accounts WHERE kind = 'budget' AND closed_at IS NULL ORDER BY name`,
  ).map((a) => ({
    label: a.name,
    accountId: a.id,
    value: balances.get(a.id)?.working ?? 0,
    asOf,
    stale: false,
  }));

  const investmentLines: NetWorthLine[] = [];
  const otherAssetLines: NetWorthLine[] = [];
  let worstDate: IsoDate | null = null;
  let anyStale = false;

  const noteDate = (date: IsoDate | null, stale: boolean) => {
    if (stale) anyStale = true;
    if (date && (worstDate === null || date < worstDate)) worstDate = date;
  };

  for (const account of listAssetAccounts(db)) {
    const holdings = listHoldings(db, account.id);

    if (holdings.length > 0) {
      let total = 0;
      let oldest: IsoDate | null = null;
      let stale = false;

      for (const holding of holdings) {
        const view = viewHolding(db, holding.id, asOf, baseCurrency);
        if (!view) continue;
        total += view.marketValue;
        if (view.quote) {
          if (!oldest || view.quote.asOf < oldest) oldest = view.quote.asOf;
          // R26.4 / R32.4: a stale price or a stale rate both taint the figure.
          if (view.quote.stale) stale = true;
        }
        if (view.fx?.stale) stale = true;
      }

      investmentLines.push({ label: account.name, accountId: account.id, value: total, asOf: oldest, stale });
      noteDate(oldest, stale);
      continue;
    }

    // A manually valued asset — R23.2's dated history, not a mutable number.
    const valuation = latestValuation(db, account.id, asOf);
    if (!valuation) continue;
    otherAssetLines.push({
      label: `${account.name} (${ASSET_LABELS[account.subtype as AssetSubtype] ?? account.subtype})`,
      accountId: account.id,
      value: valuation.value,
      asOf: valuation.asOf,
      stale: valuation.stale,
    });
    noteDate(valuation.asOf, valuation.stale);
  }

  // --- Liabilities ----------------------------------------------------------
  const cardLines: NetWorthLine[] = queryAll<{ id: string; name: string }>(
    db, `SELECT id, name FROM accounts WHERE kind = 'credit' AND closed_at IS NULL ORDER BY name`,
  )
    .map((a) => ({
      label: a.name,
      accountId: a.id,
      value: Math.max(0, -(balances.get(a.id)?.working ?? 0)),
      asOf,
      stale: false,
    }))
    .filter((line) => line.value > 0);

  const loanLines: NetWorthLine[] = [];
  const untrackedAssetWarnings: string[] = [];
  const assetNames = listAssetAccounts(db).map((a) => a.name.toLowerCase());

  for (const loan of listLoans(db)) {
    const projection = projectLoan(db, loan.id);
    if (!projection) continue;
    loanLines.push({
      label: loan.nickname || loan.lender,
      accountId: loan.account_id,
      value: projection.outstanding,
      asOf,
      stale: false,
    });

    // R23.4: a tracked liability without its underlying asset makes net worth
    // systematically wrong and alarming.
    const secured = ["home", "home-under-construction", "car", "loan-against-property", "gold"];
    if (secured.includes(loan.loan_type) && projection.outstanding > 0) {
      const hint = loan.loan_type.startsWith("home") ? "property" : loan.loan_type;
      const tracked = assetNames.some((n) => n.includes(hint));
      if (!tracked) {
        untrackedAssetWarnings.push(
          `${loan.nickname || loan.lender} is secured against something you haven't ` +
            `recorded as an asset. Net worth is ${formatPaise(projection.outstanding)} lower ` +
            `than reality until you add it.`,
        );
      }
    }
  }

  const group = (name: string, lines: NetWorthLine[]): NetWorthGroup => ({
    name,
    lines,
    total: lines.reduce((sum, l) => sum + l.value, 0),
  });

  const assetGroups = [
    group("Cash", cashLines),
    group("Investments", investmentLines),
    group("Other assets", otherAssetLines),
  ].filter((g) => g.lines.length > 0);

  const liabilityGroups = [
    group("Credit cards", cardLines),
    group("Loans", loanLines),
  ].filter((g) => g.lines.length > 0);

  const totalAssets = assetGroups.reduce((sum, g) => sum + g.total, 0);
  const totalLiabilities = liabilityGroups.reduce((sum, g) => sum + g.total, 0);

  return {
    asOf,
    assetGroups,
    liabilityGroups,
    totalAssets,
    totalLiabilities,
    netWorth: totalAssets - totalLiabilities,
    worstInputDate: worstDate,
    hasStaleInputs: anyStale,
    untrackedAssetWarnings,
  };
}

// ---------------------------------------------------------------------------
// R29.2 · A dated history, snapshotted at least monthly
// ---------------------------------------------------------------------------

export interface Snapshot {
  as_of: IsoDate;
  cash: Paise;
  investments: Paise;
  other_assets: Paise;
  credit_cards: Paise;
  loans: Paise;
  net_worth: Paise;
}

export function snapshotNetWorth(db: DB, actor: Actor, asOf = todayIST()): Snapshot {
  const statement = netWorthStatement(db, asOf);
  const find = (groups: NetWorthGroup[], name: string) =>
    groups.find((g) => g.name === name)?.total ?? 0;

  execute(
    db,
    `INSERT INTO net_worth_snapshots
       (as_of,cash,investments,other_assets,credit_cards,loans,net_worth,worst_price_date,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(as_of) DO UPDATE SET
         cash = excluded.cash, investments = excluded.investments,
         other_assets = excluded.other_assets, credit_cards = excluded.credit_cards,
         loans = excluded.loans, net_worth = excluded.net_worth,
         worst_price_date = excluded.worst_price_date`,
    asOf,
    find(statement.assetGroups, "Cash"),
    find(statement.assetGroups, "Investments"),
    find(statement.assetGroups, "Other assets"),
    find(statement.liabilityGroups, "Credit cards"),
    find(statement.liabilityGroups, "Loans"),
    statement.netWorth,
    statement.worstInputDate,
    nowIST(),
  );

  appendEvent(db, actor, {
    entity: "net-worth", entityId: asOf, action: "snapshot",
    after: { netWorth: statement.netWorth },
    summary: `Net worth ${formatPaise(statement.netWorth)} as of ${formatDate(asOf)}`,
  });

  return queryOne<Snapshot>(db, `SELECT * FROM net_worth_snapshots WHERE as_of = ?`, asOf)!;
}

export function netWorthHistory(db: DB, limit = 60): Snapshot[] {
  return queryAll<Snapshot>(
    db, `SELECT * FROM net_worth_snapshots ORDER BY as_of DESC LIMIT ?`, limit,
  ).reverse();
}

// ---------------------------------------------------------------------------
// R29.4 · The change, decomposed
// ---------------------------------------------------------------------------

export interface NetWorthChange {
  from: IsoDate;
  to: IsoDate;
  total: Paise;
  /** Net cash added — the part that was actually saved. */
  moneySaved: Paise;
  marketMovement: Paise;
  fxMovement: Paise;
  debtRepaid: Paise;
  /** R29.4's point, said in words. */
  reading: string;
}

/**
 * R29.4 · Four numbers that mean four different things.
 *
 * *"A net worth that rose because the rupee weakened is not the same
 * achievement as one that rose because you repaid principal."* A single
 * "+₹78,200" hides which of the four it was.
 */
export function netWorthChange(
  db: DB, from: IsoDate, to: IsoDate,
): NetWorthChange | null {
  const start = queryOne<Snapshot>(
    db, `SELECT * FROM net_worth_snapshots WHERE as_of <= ? ORDER BY as_of DESC LIMIT 1`, from,
  );
  const end = queryOne<Snapshot>(
    db, `SELECT * FROM net_worth_snapshots WHERE as_of <= ? ORDER BY as_of DESC LIMIT 1`, to,
  );
  if (!start || !end || start.as_of === end.as_of) return null;

  const total = end.net_worth - start.net_worth;
  const debtRepaid =
    start.loans + start.credit_cards - (end.loans + end.credit_cards);
  const moneySaved = end.cash - start.cash;

  // The investment change that is not explained by money moving in or out is
  // market movement. FX is carried separately by each holding's decomposition
  // (R34); at the portfolio level it is aggregated from those.
  const investmentChange = end.investments - start.investments;
  const fxMovement = portfolioFxMovement(db, start.as_of, end.as_of);
  const marketMovement = investmentChange - fxMovement;

  return {
    from: start.as_of,
    to: end.as_of,
    total,
    moneySaved,
    marketMovement,
    fxMovement,
    debtRepaid,
    reading: describeChange(total, moneySaved, marketMovement, fxMovement, debtRepaid),
  };
}

/** R34.2 · Asset gain and FX gain aggregated separately across foreign holdings. */
function portfolioFxMovement(db: DB, from: IsoDate, to: IsoDate): Paise {
  let movement = 0;
  for (const holding of listHoldings(db)) {
    const before = viewHolding(db, holding.id, from);
    const after = viewHolding(db, holding.id, to);
    if (!before?.decomposition || !after?.decomposition) continue;
    movement += after.decomposition.fxGain - before.decomposition.fxGain;
  }
  return movement;
}

function describeChange(
  total: Paise, saved: Paise, market: Paise, fx: Paise, debt: Paise,
): string {
  const parts: string[] = [];
  if (saved !== 0) parts.push(`${formatPaise(saved)} saved`);
  if (market !== 0) parts.push(`${formatPaise(market)} from the market`);
  if (fx !== 0) parts.push(`${formatPaise(fx)} from the exchange rate`);
  if (debt !== 0) parts.push(`${formatPaise(debt)} of debt repaid`);

  if (parts.length === 0) return "No change since the last snapshot.";
  return `${formatPaise(total)} in total — ${parts.join(", ")}.`;
}

/** Snapshot on the first of each month, so the trend is real (R29.2). */
export function backfillMonthlySnapshots(
  db: DB, actor: Actor, months = 12, today = todayIST(),
): number {
  let created = 0;
  for (let i = months; i >= 0; i--) {
    const asOf = `${addMonths(monthOf(today), -i)}-01`;
    if (asOf > today) continue;
    const existing = queryOne(db, `SELECT as_of FROM net_worth_snapshots WHERE as_of = ?`, asOf);
    if (existing) continue;
    snapshotNetWorth(db, actor, asOf);
    created++;
  }
  return created;
}
