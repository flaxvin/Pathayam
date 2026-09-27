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
import { accountBalances, accountBalancesThrough } from "../engine/repository.ts";
import { listLoans, projectLoan, outstandingPrincipal } from "./loans.ts";
import { accountDrifts, type AccountDrift } from "./account-drift.ts";
import { familyLoanNetWorth, listFamilyLoans } from "./family-loans.ts";
import { SIMPLE_TRACKING_SUBTYPES, hiddenAccountIds, type HolderScope } from "./accounts.ts";
import {
  listAssetAccounts, listHoldings, viewHolding, holdingValueOn, valuationInBase, ASSET_LABELS,
  ASSET_CLASS_LABELS,
  type AssetSubtype, type AssetClass,
} from "./assets.ts";

export interface NetWorthLine {
  label: string;
  accountId: string | null;
  value: Paise;
  /** R29.1 · The date this input is as of, so the total can carry its caveat. */
  asOf: IsoDate | null;
  stale: boolean;
  /**
   * Where to go to change this figure. A hand-valued asset is revalued, an
   * account is reconciled, a loan is paid — every line on this page comes from
   * somewhere the reader can act on, and naming that here keeps the screen
   * from having to guess a line's kind back out of its shape.
   */
  href?: string;
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
  /**
   * Accounts whose ledger and shown figure have parted company. Reported
   * beside the total rather than resolved, because no single rule is right for
   * both a recurring deposit being paid into and a flat being revalued.
   */
  drifts: AccountDrift[];
}

export function netWorthStatement(
  db: DB, asOf = todayIST(), baseCurrency = "INR",
  /**
   * H2.2 · Who is looking. A private tracking account must not be counted into
   * a total shown to somebody else: they can see every other line, so a total
   * that includes what they cannot see publishes it by subtraction.
   *
   * Omitted means count everything, which is what the operator's backup
   * wants. Screens pass the authenticated member; a snapshot passes null (see
   * snapshotNetWorth).
   */
  opts: { viewerMemberId?: string | null; scope?: HolderScope } = {},
): NetWorthStatement {
  /*
   * WEALTH-15 · A statement for a past day is that day's, not today's.
   *
   * Month close snapshots the last day of the month it closes, and
   * backfillMonthlySnapshots the first of each earlier month — but every line
   * here was read as of now: all transactions ever, today's open lots, the
   * loan's current outstanding. Closing June in September recorded September's
   * money against 30 June, and overwrote whatever had been stored for that
   * date. So for a date before today the balances run through that day only,
   * holdings are the lots held on it, loans owe what they owed then, and an
   * account closed since still counts. (Its opening date is no test: a demat
   * opened today can hold lots bought years ago, and a balance before an
   * account's opening is nil anyway.)
   *
   * Today's statement is unchanged: a future-dated transaction still counts,
   * because a screen is "as of now".
   */
  const dated = asOf < todayIST();
  const balances = dated ? accountBalancesThrough(db, asOf) : accountBalances(db);
  const openOnDate = dated
    ? new Set(queryAll<{ id: string }>(
        db,
        `SELECT id FROM accounts WHERE closed_at IS NULL OR substr(closed_at, 1, 10) > ?`,
        asOf,
      ).map((r) => r.id))
    : null;
  const hidden = opts.viewerMemberId === undefined
    ? new Set<string>()
    : hiddenAccountIds(db, opts.viewerMemberId ?? null, opts.scope ?? "household");
  /** Counted on this statement: visible to the reader, and not closed by its date. */
  const counts = (accountId: string) =>
    !hidden.has(accountId) && (openOnDate === null || openOnDate.has(accountId));
  const stillOpen = dated ? "" : "AND closed_at IS NULL";

  // --- Assets ---------------------------------------------------------------
  const cashLines: NetWorthLine[] = queryAll<{ id: string; name: string }>(
    db, `SELECT id, name FROM accounts WHERE kind = 'budget' ${stillOpen} ORDER BY name`,
  ).filter((a) => counts(a.id)).map((a) => ({
    label: a.name,
    accountId: a.id,
    value: balances.get(a.id)?.working ?? 0,
    asOf,
    stale: false,
    href: `/accounts/${a.id}`,
  }));

  const investmentLines: NetWorthLine[] = [];
  const otherAssetLines: NetWorthLine[] = [];
  let worstDate: IsoDate | null = null;
  let anyStale = false;

  const noteDate = (date: IsoDate | null, stale: boolean) => {
    if (stale) anyStale = true;
    if (date && (worstDate === null || date < worstDate)) worstDate = date;
  };

  for (const account of listAssetAccounts(db, { includeClosed: dated })) {
    if (!counts(account.id)) continue;
    const holdings = listHoldings(db, account.id);

    if (dated) {
      // Every holding the account has ever had, closed ones included: one
      // sold out in August was still held on a June date.
      const everHeld = queryAll<{ id: string }>(
        db, `SELECT id FROM holdings WHERE account_id = ?`, account.id,
      );
      if (everHeld.length > 0) {
        let total = 0;
        let oldest: IsoDate | null = null;
        let stale = false;
        for (const holding of everHeld) {
          const view = holdingValueOn(db, holding.id, asOf, baseCurrency);
          if (!view || view.value === 0) continue;
          total += view.value;
          if (view.quote) {
            if (!oldest || view.quote.asOf < oldest) oldest = view.quote.asOf;
            if (view.quote.stale) stale = true;
          }
          if (view.fx?.stale) stale = true;
        }
        investmentLines.push({
          label: account.name, accountId: account.id, value: total, asOf: oldest, stale,
          href: "/portfolio",
        });
        noteDate(oldest, stale);
        continue;
      }
    } else if (holdings.length > 0) {
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

      investmentLines.push({
        label: account.name, accountId: account.id, value: total, asOf: oldest, stale,
        href: "/portfolio",
      });
      noteDate(oldest, stale);
      continue;
    }

    // A manually valued asset — R23.2's dated history, not a mutable number,
    // and R32's currency: an account worth $40,000 is not worth ₹40,000.
    const valuation = valuationInBase(db, account, asOf, baseCurrency);
    if (!valuation) continue;
    otherAssetLines.push({
      label: `${account.name} (${ASSET_LABELS[account.subtype as AssetSubtype] ?? account.subtype})`,
      accountId: account.id,
      value: valuation.value,
      asOf: valuation.asOf,
      stale: valuation.stale,
      href: `/portfolio/asset/${account.id}/revalue`,
    });
    noteDate(valuation.asOf, valuation.stale);
  }

  // --- Liabilities ----------------------------------------------------------
  const cardLines: NetWorthLine[] = [];
  for (const a of queryAll<{ id: string; name: string }>(
    db, `SELECT id, name FROM accounts WHERE kind = 'credit' ${stillOpen} ORDER BY name`,
  )) {
    if (!counts(a.id)) continue;
    const balance = balances.get(a.id)?.working ?? 0;
    if (balance < 0) {
      cardLines.push({
        label: a.name, accountId: a.id, value: -balance, asOf, stale: false, href: `/accounts/${a.id}`,
      });
    } else if (balance > 0) {
      /*
       * WEALTH-28 · A card in credit — overpaid, or refunded after the bill
       * was paid — owes the household money, and was on neither side: the
       * liability was floored at nil and then dropped. It is money you can
       * spend, so it sits with the cash.
       */
      cashLines.push({
        label: `${a.name} (in credit)`, accountId: a.id, value: balance, asOf, stale: false,
        href: `/accounts/${a.id}`,
      });
    }
  }

  const loanLines: NetWorthLine[] = [];
  const untrackedAssetWarnings: string[] = [];
  const assetNames = listAssetAccounts(db).map((a) => a.name.toLowerCase());

  for (const loan of listLoans(db, { includeClosed: dated })) {
    // H2.2 · A private loan leaves somebody else's total as well as their list —
    // the cash and asset lines above already do this, and the liabilities did not,
    // so the debt side of a private arrangement was published to everyone.
    if (!counts(loan.account_id)) continue;
    if (dated && loan.sanction_date > asOf) continue;
    // WEALTH-15 · On a past date, what was owed then: draws and payments dated
    // by that day. A loan closed since was still owed on it.
    const outstanding = dated
      ? outstandingPrincipal(db, loan.id, asOf)
      : projectLoan(db, loan.id)?.outstanding;
    if (outstanding === undefined) continue;
    loanLines.push({
      label: loan.nickname || loan.lender,
      accountId: loan.account_id,
      value: outstanding,
      asOf,
      stale: false,
      href: `/loans/${loan.id}`,
    });

    // R23.4: a tracked liability without its underlying asset makes net worth
    // systematically wrong and alarming.
    const secured = ["home", "home-under-construction", "car", "loan-against-property", "gold"];
    if (secured.includes(loan.loan_type) && outstanding > 0) {
      const hint = loan.loan_type.startsWith("home") ? "property" : loan.loan_type;
      const tracked = assetNames.some((n) => n.includes(hint));
      if (!tracked) {
        untrackedAssetWarnings.push(
          `${loan.nickname || loan.lender} is secured against something you haven't ` +
            `recorded as an asset. Net worth is ${formatPaise(outstanding)} lower ` +
            `than reality until you add it.`,
        );
      }
    }
  }

  // FL8 · Private lending counts, on both sides. Lent money is an asset and
  // borrowed money is a liability, both at the derived balance — there is no
  // typed figure to go stale, so neither carries a staleness flag.
  //
  // H2.2 · And a private arrangement is hidden from everyone but its holder, by
  // the same set that hides a private loan. Money lent to a cousin out of your
  // own pocket was being published on both sides of somebody else's net worth.
  const family = dated ? familyLoansOn(db, balances) : familyLoanNetWorth(db);
  for (const line of family.lent) {
    if (!counts(line.accountId)) continue;
    otherAssetLines.push({ ...line, asOf, stale: false });
  }
  const familyLines: NetWorthLine[] = family.borrowed
    .filter((line: { accountId: string }) => counts(line.accountId))
    .map((line: { label: string; accountId: string; value: Paise }) => ({
      ...line, asOf, stale: false,
    }));

  // B56 · Plain tracking accounts (a fixed deposit, an "other asset" or "other
  // liability") count by their balance, so one created on the accounts form is
  // never orphaned from net worth. Their subtypes belong to no companion table,
  // so nothing above has already counted them.
  const otherLiabilityLines: NetWorthLine[] = [];
  const simpleTracking = queryAll<{ id: string; name: string; subtype: string; currency: string }>(
    db,
    `SELECT id, name, subtype, currency FROM accounts
      WHERE kind = 'tracking' ${stillOpen}
        AND subtype IN (${SIMPLE_TRACKING_SUBTYPES.map(() => "?").join(",")})
      ORDER BY name`,
    ...SIMPLE_TRACKING_SUBTYPES,
  );
  for (const account of simpleTracking) {
    if (!counts(account.id)) continue;
    const working = balances.get(account.id)?.working ?? 0;
    /*
     * B56 · A tracking account is worth its balance — unless somebody has
     * stated otherwise with a dated valuation, which is the only way to say
     * what a PPF or a fixed deposit has actually grown to. The stated figure
     * wins, and carries its own date and staleness like every other valued
     * asset; the register still holds the history either way.
     */
    const stated = valuationInBase(db, account, asOf, baseCurrency);
    const value = stated ? stated.value : working;
    const lineAsOf = stated ? stated.asOf : asOf;
    const lineStale = stated ? stated.stale : false;
    const href = stated
      ? `/portfolio/asset/${account.id}/revalue`
      : `/accounts/${account.id}`;
    if (stated) noteDate(stated.asOf, stated.stale);

    if (value > 0) {
      otherAssetLines.push({
        label: account.name, accountId: account.id, value,
        asOf: lineAsOf, stale: lineStale, href,
      });
    } else if (value < 0) {
      otherLiabilityLines.push({
        label: account.name, accountId: account.id, value: -value,
        asOf: lineAsOf, stale: lineStale, href,
      });
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
    group("Owed to family", familyLines),
    group("Other liabilities", otherLiabilityLines),
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
    drifts: accountDrifts(db, { viewerMemberId: opts.viewerMemberId, asOf }),
  };
}

/**
 * WEALTH-15 · Family arrangements on a past date: familyLoanNetWorth's lines,
 * read off the balances through that date. A family loan's outstanding is its
 * tracking account's balance (viewFamilyLoan), and one written off or closed
 * since was still owed on the day.
 */
function familyLoansOn(
  db: DB, balances: Map<string, { working: Paise }>,
): ReturnType<typeof familyLoanNetWorth> {
  const out: ReturnType<typeof familyLoanNetWorth> = { lent: [], borrowed: [] };
  for (const loan of listFamilyLoans(db, { includeClosed: true })) {
    const balance = balances.get(loan.account_id)?.working ?? 0;
    if (balance > 0) {
      out.lent.push({ label: `${loan.counterparty} owes you`, accountId: loan.account_id, value: balance });
    } else if (balance < 0) {
      out.borrowed.push({ label: `You owe ${loan.counterparty}`, accountId: loan.account_id, value: -balance });
    }
  }
  return out;
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

/**
 * 15 · A snapshot is one row per date, read back by every member — the history
 * on /net-worth, the change line under it, the sparkline on the budget page and
 * /net-worth.csv. It used to count everything, so with Ravi's private
 * ₹3,00,000 savings account in the household, the figure Priya's history showed
 * for today was ₹3,00,000 above the live total on the same page: his balance,
 * published by subtraction.
 *
 * A shared row can only hold what everybody may see, so it is taken as nobody
 * in particular — the household's accounts and nothing held privately. Each
 * member's live statement still counts their own private accounts; the history
 * is the household's. (Per-member history would need a member column on the
 * snapshot table.)
 */
export function snapshotNetWorth(db: DB, actor: Actor, asOf = todayIST()): Snapshot {
  const statement = netWorthStatement(db, asOf, "INR", { viewerMemberId: null });
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
  /** Net cash added, plus what was put into holdings net of what came out — the part that was actually saved. */
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

  /*
   * WEALTH-26 · The investment change that is not explained by money moving in
   * or out is market movement — so the money moving in or out has to be taken
   * out of it. It was not: ₹1,00,000 moved from the bank into a fund whose
   * price never moved read "−₹1,00,000 saved, ₹1,00,000 from the market", and
   * every SIP month reported its SIP as market gain and as dis-saving. What was
   * put in, net of what came out, is saving that happens to be invested.
   * FX is carried separately by each holding's decomposition (R34); at the
   * portfolio level it is aggregated from those.
   */
  const contributed = netContributions(db, start.as_of, end.as_of);
  const moneySaved = end.cash - start.cash + contributed;
  const investmentChange = end.investments - start.investments;
  const fxMovement = portfolioFxMovement(db, start.as_of, end.as_of);
  const marketMovement = investmentChange - fxMovement - contributed;

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

/**
 * WEALTH-26 · Money put into holdings over (from, to], less money taken out,
 * over the holdings the snapshots counted.
 *
 * What a lot cost when it was bought is its cost now plus what later sales
 * consumed of it — a partial sale rewrites the surviving lot's cost in place,
 * a lot sold out is closed (and counted only through the sale), and a sale's
 * parcels (B88) record what each took, dated by purchase. A
 * reinvested dividend makes a lot too, but it is return, not new money. What
 * came out is the sale proceeds. A return of capital, which rewrites lot costs
 * as well, is not separated: it is rare, and small against the rest.
 */
function netContributions(db: DB, from: IsoDate, to: IsoDate): Paise {
  const hidden = hiddenAccountIds(db, null);
  const counted = (accountId: string) => !hidden.has(accountId);

  let total = 0;
  for (const lot of queryAll<{ account_id: string; cost: number }>(
    db,
    `SELECT h.account_id, l.cost FROM lots l JOIN holdings h ON h.id = l.holding_id
      WHERE l.trade_date > ? AND l.trade_date <= ? AND l.closed_at IS NULL`,
    from, to,
  )) {
    if (counted(lot.account_id)) total += lot.cost;
  }
  for (const e of queryAll<{ account_id: string; kind: string; date: IsoDate; amount: number | null; detail_json: string | null }>(
    db,
    `SELECT h.account_id, e.kind, e.date, e.amount, e.detail_json
       FROM holding_events e JOIN holdings h ON h.id = e.holding_id
      WHERE e.kind IN ('sale', 'dividend-reinvested')`,
  )) {
    if (!counted(e.account_id)) continue;
    const inWindow = e.date > from && e.date <= to;
    if (e.kind === "dividend-reinvested") {
      if (inWindow) total -= e.amount ?? 0;
      continue;
    }
    if (inWindow) total -= e.amount ?? 0;
    let parcels: { tradeDate?: IsoDate; cost: number }[] = [];
    try {
      parcels = e.detail_json ? (JSON.parse(e.detail_json).parcels ?? []) : [];
    } catch {
      parcels = [];
    }
    for (const p of parcels) {
      if (p.tradeDate && p.tradeDate > from && p.tradeDate <= to) total += p.cost;
    }
  }
  return total as Paise;
}

/** R34.2 · Asset gain and FX gain aggregated separately across foreign holdings. */
function portfolioFxMovement(db: DB, from: IsoDate, to: IsoDate): Paise {
  let movement = 0;
  // 15 · Over the holdings the snapshots counted, and no others.
  const hidden = hiddenAccountIds(db, null);
  for (const holding of listHoldings(db)) {
    if (hidden.has(holding.account_id)) continue;
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
  // WEALTH-15 · Nothing was recorded before the first account opened, so a
  // snapshot then would be a ₹0 the household never had.
  const firstOpened = queryOne<{ d: string | null }>(
    db, `SELECT MIN(opening_date) AS d FROM accounts`,
  )?.d ?? null;
  for (let i = months; i >= 0; i--) {
    const asOf = `${addMonths(monthOf(today), -i)}-01`;
    if (asOf > today) continue;
    if (firstOpened === null || asOf < firstOpened) continue;
    const existing = queryOne(db, `SELECT as_of FROM net_worth_snapshots WHERE as_of = ?`, asOf);
    if (existing) continue;
    snapshotNetWorth(db, actor, asOf);
    created++;
  }
  return created;
}

// ---------------------------------------------------------------------------
// F19.11 · Asset allocation
// ---------------------------------------------------------------------------

/**
 * How a manually-valued asset account maps to an allocation class.
 *
 * A fixed deposit is cash-like, a flat is real estate, gold is gold. These are
 * unambiguous from the subtype, unlike a mutual fund from its kind — so they
 * need no per-account classification.
 */
const SUBTYPE_CLASS: Record<AssetSubtype, AssetClass> = {
  investment: "equity",
  retirement: "debt",
  physical: "real-estate",
  commodity: "gold",
};

export interface AllocationSlice {
  key: string;
  label: string;
  value: Paise;
  /** Of the classified total; the unclassified bucket is reported separately. */
  share: number;
}

export interface AssetAllocation {
  byClass: AllocationSlice[];
  byRegion: AllocationSlice[];
  byCurrency: AllocationSlice[];
  total: Paise;
  /**
   * F19.11 / N9 · Holdings whose class the household has not set. Reported as
   * its own figure rather than folded into a bucket, so the allocation never
   * implies a precision it does not have.
   */
  unclassified: { value: Paise; holdings: { instrumentId: string; name: string; value: Paise }[] };
}

/**
 * F19.11 · Allocation across the whole portfolio — unit holdings and
 * manually-valued assets alike, at market value as of `asOf`.
 *
 * Percentages are of the *classified* total. An unclassified fund is not
 * counted into equity or debt on a guess; it is surfaced so the household can
 * classify it, and until they do the shares stay honest about what is known.
 */
export function assetAllocation(
  db: DB, asOf: IsoDate = todayIST(), baseCurrency = "INR",
  /**
   * 15 · Who is looking. The allocation page asked for everything, so Priya's
   * "Equity" slice included the ₹8,000 of "Bandersnatch Secret Fund" in Ravi's
   * private demat, and the unclassified list named the fund outright. The
   * same rule as the net worth statement: omitted counts everything.
   */
  opts: { viewerMemberId?: string | null } = {},
): AssetAllocation {
  const hidden = opts.viewerMemberId === undefined
    ? new Set<string>()
    : hiddenAccountIds(db, opts.viewerMemberId ?? null);
  const byClass = new Map<string, number>();
  const byRegion = new Map<string, number>();
  const byCurrency = new Map<string, number>();
  const unclassifiedHoldings: { instrumentId: string; name: string; value: Paise }[] = [];
  let unclassifiedValue = 0;
  let classifiedTotal = 0;

  const addClassified = (
    cls: AssetClass, region: string, currency: string, value: number,
  ) => {
    byClass.set(cls, (byClass.get(cls) ?? 0) + value);
    byRegion.set(region, (byRegion.get(region) ?? 0) + value);
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + value);
    classifiedTotal += value;
  };

  // Unit holdings.
  for (const holding of listHoldings(db)) {
    if (hidden.has(holding.account_id)) continue;
    const view = viewHolding(db, holding.id, asOf, baseCurrency);
    if (!view || view.marketValue <= 0) continue;

    const cls = view.instrument.asset_class;
    if (!cls) {
      unclassifiedValue += view.marketValue;
      unclassifiedHoldings.push({
        instrumentId: view.instrument.id, name: view.instrument.name, value: view.marketValue,
      });
      continue;
    }
    addClassified(
      cls,
      view.instrument.region ?? "domestic",
      view.instrument.currency,
      view.marketValue,
    );
  }

  // Manually-valued asset accounts. Their subtype fixes the class.
  for (const account of listAssetAccounts(db)) {
    if (hidden.has(account.id)) continue;
    if (listHoldings(db, account.id).length > 0) continue; // a unit account, counted above
    // R32 · In the base currency, like every other line in this total. The
    // slice is still labelled with the account's own currency — that is the
    // question "by currency" asks — but the share it takes of the whole is
    // arithmetic, and arithmetic needs one unit.
    const valuation = valuationInBase(db, account, asOf, baseCurrency);
    if (!valuation || valuation.value <= 0) continue;

    addClassified(
      SUBTYPE_CLASS[account.subtype as AssetSubtype] ?? "other",
      account.currency === baseCurrency ? "domestic" : "international",
      account.currency,
      valuation.value,
    );
  }

  /*
   * WEALTH-36 · Plain tracking accounts, valued as the net worth statement
   * values them (B56): a stated valuation if there is one, else the balance.
   * Only the four asset subtypes were read, so ₹10 lakh in a fixed deposit
   * beside ₹1 lakh in a fund read "Equity 100%" — the page told a cautious
   * saver they were all-in on shares. A deposit is cash; "other asset" is
   * other; a liability, or anything worth nothing, is not an allocation.
   */
  const balances = asOf < todayIST() ? accountBalancesThrough(db, asOf) : accountBalances(db);
  for (const account of queryAll<{ id: string; subtype: string; currency: string }>(
    db,
    `SELECT id, subtype, currency FROM accounts
      WHERE kind = 'tracking' AND closed_at IS NULL
        AND subtype IN (${SIMPLE_TRACKING_SUBTYPES.map(() => "?").join(",")})`,
    ...SIMPLE_TRACKING_SUBTYPES,
  )) {
    if (hidden.has(account.id) || account.subtype === "liability") continue;
    const stated = valuationInBase(db, account, asOf, baseCurrency);
    const value = stated ? stated.value : balances.get(account.id)?.working ?? 0;
    if (value <= 0) continue;
    addClassified(
      account.subtype === "asset" ? "other" : "cash",
      account.currency === baseCurrency ? "domestic" : "international",
      account.currency,
      value,
    );
  }

  const toSlices = (
    m: Map<string, number>, label: (k: string) => string,
  ): AllocationSlice[] =>
    [...m.entries()]
      .map(([key, value]) => ({
        key, label: label(key), value: value as Paise,
        share: classifiedTotal > 0 ? value / classifiedTotal : 0,
      }))
      .sort((a, b) => b.value - a.value);

  return {
    byClass: toSlices(byClass, (k) => ASSET_CLASS_LABELS[k as AssetClass] ?? k),
    byRegion: toSlices(byRegion, (k) => (k === "domestic" ? "India" : "International")),
    byCurrency: toSlices(byCurrency, (k) => k),
    total: classifiedTotal as Paise,
    unclassified: {
      value: unclassifiedValue as Paise,
      holdings: unclassifiedHoldings.sort((a, b) => b.value - a.value),
    },
  };
}
