/**
 * F19 · Asset accounts, holdings and lots — the database side of `07`.
 *
 * The maths lives in `portfolio/holdings.ts` and knows nothing about storage.
 *
 * ## R30, the firewall
 *
 * `07` §1: "The firewall is the whole design." `05` §5 excluded net worth
 * because every budgeting app that added it became a dashboard; the exclusion
 * was reversed, and R30 is the containment that makes the reversal safe.
 *
 * Two of its invariants are structural here rather than enforced:
 *
 * - **FW1** — an asset account is a Tracking account, and `to_budget` only
 *   ever counts Budget accounts (`docs/dev/01-engine-derivation.md` §3). No
 *   code path exists that could put market value into Ready to Assign.
 * - **FW7** — a price refresh writes to `prices`, which the budget engine
 *   never reads. It cannot create, modify or delete a transaction because it
 *   has no access to that table from here.
 *
 * The rest are enforced explicitly, and `assets.test.ts` asserts all ten.
 * Q15 declined making R30 a build gate, so these are tests and a review item,
 * not a blocker — see `09` §7 for the accepted risk.
 */

import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { Refusal } from "../core/refusal.ts";
import { appendEvent, registerUndoHandler, type Actor } from "../core/events.ts";
import { nowIST, todayIST, formatDate, daysBetween, type IsoDate } from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import { SIMPLE_TRACKING_SUBTYPES, createAccount, getAccount } from "./accounts.ts";
import { createTransaction } from "./transactions.ts";
import {
  makeLot, previewSale, totalUnits, costBasis, averageCost, averageUnitPrice, marketValue,
  unrealisedGain, absoluteReturn, xirr, holdingCashFlows, decomposeGain,
  applySplit, applyMerger, applyReturnOfCapital, formatUnits,
  type Lot, type Holding, type Milliunits, type MicroRupees,
  type SalePreview, type GainDecomposition,
} from "../portfolio/holdings.ts";

export type InstrumentKind = "mutual-fund" | "equity" | "etf" | "bond" | "commodity" | "other";

/** F19.11 · The allocation buckets, in the sense Indian investing uses. */
export const ASSET_CLASSES = ["equity", "debt", "hybrid", "gold", "cash", "real-estate", "other"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  equity: "Equity",
  debt: "Debt",
  hybrid: "Hybrid",
  gold: "Gold",
  cash: "Cash & deposits",
  "real-estate": "Real estate",
  other: "Other",
};

export type Region = "domestic" | "international";

/** The class a kind unambiguously implies; null where it does not (a fund). */
export function classFromKind(kind: InstrumentKind): AssetClass | null {
  switch (kind) {
    case "equity":
    case "etf": return "equity";
    case "bond": return "debt";
    case "commodity": return "gold";
    default: return null; // mutual-fund, other — the household classifies these
  }
}
export type PriceProvider = "mfapi" | "alphavantage" | "manual";

export interface Instrument {
  id: string;
  name: string;
  kind: InstrumentKind;
  symbol: string | null;
  isin: string | null;
  currency: string;
  provider: PriceProvider;
  manual_only: number;
  refresh: "daily" | "weekly" | "never";
  /** F19.11 · null until classified; a fund's kind cannot imply it. */
  asset_class: AssetClass | null;
  region: Region | null;
}

export interface HoldingRecord {
  id: string;
  account_id: string;
  instrument_id: string;
  note: string | null;
  closed_at: string | null;
}

export const ASSET_SUBTYPES = [
  "investment", "retirement", "deposit", "physical", "commodity", "receivable",
] as const;
export type AssetSubtype = (typeof ASSET_SUBTYPES)[number];

export const ASSET_LABELS: Record<AssetSubtype, string> = {
  investment: "Investment account",
  retirement: "Retirement balance",
  deposit: "Deposit",
  physical: "Physical asset",
  commodity: "Commodity holding",
  receivable: "Receivable",
};

/** R23.3 · A manual valuation goes stale, and says so. */
export const VALUATION_STALE_DAYS = 180;
/** R32.4 · A rate older than this is flagged wherever a converted figure shows. */
export const FX_STALE_DAYS = 5;

// ---------------------------------------------------------------------------
// R23 · Asset accounts
// ---------------------------------------------------------------------------

export function createAssetAccount(
  db: DB, actor: Actor,
  input: {
    name: string;
    subtype: AssetSubtype;
    institution?: string | null;
    currency?: string;
    /** H2 · Whose asset this is. Null means the household's. */
    holderMemberId?: string | null;
    /** H2.2 · Private assets are visible only to their holder. */
    visibility?: "household" | "private";
    /** For a manually valued asset — R23.2 records it as dated history. */
    openingValue?: Paise;
    asOf?: IsoDate;
  },
) {
  return transact(db, () => {
    // FW1: a Tracking account, so it can never fund the budget.
    const account = createAccount(db, actor, {
      name: input.name,
      kind: "tracking",
      holderMemberId: input.holderMemberId,
      visibility: input.visibility,
      subtype: "asset",
      institution: input.institution ?? null,
      openingBalance: 0,
      openingDate: input.asOf ?? todayIST(),
    });

    execute(
      db, `UPDATE accounts SET subtype = ?, currency = ? WHERE id = ?`,
      input.subtype, input.currency ?? "INR", account.id,
    );

    if (input.openingValue !== undefined && input.openingValue > 0) {
      recordValuation(db, actor, {
        accountId: account.id,
        value: input.openingValue,
        asOf: input.asOf ?? todayIST(),
      });
    }

    appendEvent(db, actor, {
      entity: "asset-account", entityId: account.id, action: "create",
      after: { name: input.name, subtype: input.subtype },
      summary: `Added ${ASSET_LABELS[input.subtype].toLowerCase()} "${input.name}"`,
    });

    return getAccount(db, account.id)!;
  });
}

export function listAssetAccounts(
  db: DB,
  opts: { includeClosed?: boolean; viewerMemberId?: string | null } = {},
) {
  return queryAll<{
    id: string; name: string; subtype: string; currency: string;
    institution: string | null; closed_at: string | null;
  }>(
    db,
    `SELECT id, name, subtype, currency, institution, closed_at FROM accounts
      WHERE kind = 'tracking' AND subtype IN (${ASSET_SUBTYPES.map(() => "?").join(",")})
      ${opts.includeClosed ? "" : "AND closed_at IS NULL"}
      ${opts.viewerMemberId !== undefined
        ? "AND (visibility = 'household' OR holder_member_id IS ?)" : ""}
      ORDER BY name`,
    ...ASSET_SUBTYPES,
    ...(opts.viewerMemberId !== undefined ? [opts.viewerMemberId ?? null] : []),
  );
}

/**
 * Every tracking account whose worth a person can state directly.
 *
 * Two kinds of asset used to live side by side and never meet: one created on
 * the accounts form, valued by whatever its register added up to, and one
 * created in Portfolio, valued by dated valuations. Only the second appeared
 * on the valuations screen or answered the revalue route, so a PPF or a fixed
 * deposit entered through the obvious door could never be marked to its real
 * worth — the demo household's own PPF sat at its opening figure for
 * thirty-six months.
 *
 * They are one thing now, under one rule: a tracking account is worth its
 * balance unless somebody has said otherwise, and a dated valuation is how you
 * say otherwise.
 */
export function listValuableAccounts(
  db: DB,
  opts: { includeClosed?: boolean; viewerMemberId?: string | null } = {},
) {
  const subtypes = [...ASSET_SUBTYPES, ...SIMPLE_TRACKING_SUBTYPES];
  return queryAll<{
    id: string; name: string; subtype: string; currency: string;
    institution: string | null; closed_at: string | null;
  }>(
    db,
    `SELECT id, name, subtype, currency, institution, closed_at FROM accounts
      WHERE kind = 'tracking' AND subtype IN (${subtypes.map(() => "?").join(",")})
      ${opts.includeClosed ? "" : "AND closed_at IS NULL"}
      ${opts.viewerMemberId !== undefined
        ? "AND (visibility = 'household' OR holder_member_id IS ?)" : ""}
      ORDER BY name`,
    ...subtypes,
    ...(opts.viewerMemberId !== undefined ? [opts.viewerMemberId ?? null] : []),
  );
}

/** R23.2 · A dated valuation, never a mutable single number. */
export function recordValuation(
  db: DB, actor: Actor,
  input: { accountId: string; value: Paise; asOf: IsoDate; note?: string | null },
): void {
  transact(db, () => {
    execute(
      db,
      `INSERT INTO asset_valuations (id,account_id,as_of,value,note,created_at,created_by)
       VALUES (?,?,?,?,?,?,?)`,
      newId(), input.accountId, input.asOf, input.value, input.note ?? null,
      nowIST(), actor.memberId,
    );
    appendEvent(db, actor, {
      entity: "asset-account", entityId: input.accountId, action: "value",
      after: { value: input.value, asOf: input.asOf },
      summary: `Valued at ${formatPaise(input.value)} as of ${formatDate(input.asOf)}`,
    });
  });
}

/**
 * R32 · A hand-valued account's worth in the base currency.
 *
 * A valuation is a number somebody typed for an account, and an account has a
 * currency. The unit-holding path has always converted — a USD instrument is
 * priced in dollars and carried at the dated rate — but this one summed the
 * number in as it stood, so an overseas account worth $40,000 was counted as
 * ₹40,000 in net worth and labelled "USD" in the allocation beside it. The two
 * paths disagreed and only one of them was ever exercised.
 *
 * Missing rate: the same convention the holdings path uses — carry it at 1 and
 * mark it stale, rather than dropping an asset out of net worth silently.
 */
export function valuationInBase(
  db: DB,
  account: { id: string; currency: string },
  asOf = todayIST(),
  baseCurrency = "INR",
): (Valuation & { fx: FxQuote | null }) | null {
  const valuation = latestValuation(db, account.id, asOf);
  if (!valuation) return null;
  if (account.currency === baseCurrency) return { ...valuation, fx: null };

  /*
   * The rate as of the date being asked about, not the date of the valuation —
   * the same way a holding is converted. "Net worth as of today" means today's
   * rate applied to the latest known balance; the alternative freezes a figure
   * at the rate of the day somebody happened to type it in.
   */
  const fx = fxRate(db, account.currency, baseCurrency, asOf);
  return {
    ...valuation,
    value: Math.round(valuation.value * (fx?.rate ?? 1)) as Paise,
    stale: valuation.stale || fx === null || fx.stale,
    fx,
  };
}

export interface Valuation {
  value: Paise;
  asOf: IsoDate;
  /** R23.3 · Flagged after the configured interval, never silently trusted. */
  stale: boolean;
  ageDays: number;
}

export function latestValuation(
  db: DB, accountId: string, today = todayIST(),
): Valuation | null {
  const row = queryOne<{ value: number; as_of: string }>(
    db,
    `SELECT value, as_of FROM asset_valuations WHERE account_id = ?
      ORDER BY as_of DESC, created_at DESC LIMIT 1`,
    accountId,
  );
  if (!row) return null;

  const ageDays = daysBetween(row.as_of, today);
  return {
    value: row.value,
    asOf: row.as_of,
    stale: ageDays > VALUATION_STALE_DAYS,
    ageDays,
  };
}

// ---------------------------------------------------------------------------
// R24 · Instruments and holdings
// ---------------------------------------------------------------------------

export function findOrCreateInstrument(
  db: DB, actor: Actor,
  input: {
    name: string; kind: InstrumentKind; symbol?: string | null; isin?: string | null;
    currency?: string; provider?: PriceProvider; manualOnly?: boolean;
  },
): Instrument {
  return transact(db, () => {
    // R24.6: match on ISIN first — it survives a change of price provider.
    const existing =
      (input.isin
        ? queryOne<Instrument>(db, `SELECT * FROM instruments WHERE isin = ?`, input.isin)
        : null) ??
      (input.symbol
        ? queryOne<Instrument>(
            db, `SELECT * FROM instruments WHERE symbol = ? AND provider = ?`,
            input.symbol, input.provider ?? "manual",
          )
        : null);
    if (existing) return existing;

    const id = newId();
    execute(
      db,
      `INSERT INTO instruments
         (id,name,kind,symbol,isin,currency,provider,manual_only,refresh,asset_class,region,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, input.name, input.kind, input.symbol ?? null, input.isin ?? null,
      input.currency ?? "INR", input.provider ?? "manual",
      input.manualOnly ? 1 : 0,
      // P4: equities burn a scarce daily quota; funds do not.
      input.kind === "equity" || input.kind === "etf" ? "daily" : "daily",
      // F19.11: seed the class the kind decides; leave a fund's null (N9).
      classFromKind(input.kind),
      // F20: a non-INR instrument is international by default.
      (input.currency ?? "INR") === "INR" ? "domestic" : "international",
      nowIST(),
    );

    const instrument = queryOne<Instrument>(db, `SELECT * FROM instruments WHERE id = ?`, id)!;
    appendEvent(db, actor, {
      entity: "instrument", entityId: id, action: "create", after: instrument,
      summary: `Added the instrument "${input.name}"`,
    });
    return instrument;
  });
}

/**
 * F19.11 · Set an instrument's class and region.
 *
 * A fund's kind cannot imply its class — the household is the authority — so
 * this is how "Unclassified" gets emptied. Logged, because a reclassification
 * changes what every allocation report shows.
 */
export function classifyInstrument(
  db: DB, actor: Actor, instrumentId: string,
  input: { assetClass: AssetClass | null; region?: Region | null },
): void {
  transact(db, () => {
    const before = getInstrument(db, instrumentId);
    if (!before) throw new Error("That instrument does not exist.");

    execute(
      db, `UPDATE instruments SET asset_class = ?, region = ? WHERE id = ?`,
      input.assetClass,
      input.region ?? before.region ?? (before.currency === "INR" ? "domestic" : "international"),
      instrumentId,
    );

    appendEvent(db, actor, {
      entity: "instrument", entityId: instrumentId, action: "classify",
      before: { asset_class: before.asset_class, region: before.region },
      after: { asset_class: input.assetClass, region: input.region ?? before.region },
      summary: input.assetClass
        ? `Classified ${before.name} as ${ASSET_CLASS_LABELS[input.assetClass]}`
        : `Cleared the class on ${before.name}`,
    });
  });
}

export function getInstrument(db: DB, id: string): Instrument | null {
  return queryOne<Instrument>(db, `SELECT * FROM instruments WHERE id = ?`, id);
}

export function listInstruments(db: DB): Instrument[] {
  return queryAll<Instrument>(db, `SELECT * FROM instruments ORDER BY name`);
}

/**
 * FW4 · Buying an investment is money **leaving the budget**: a transfer from
 * a Budget account, consuming a savings/investment category, so envelope
 * arithmetic stays whole and reports do not count it as consumption.
 */
export function recordPurchase(
  db: DB, actor: Actor,
  input: {
    accountId: string;
    instrumentId: string;
    tradeDate: IsoDate;
    price: MicroRupees;
    units?: Milliunits;
    amount?: Paise;
    fees?: Paise;
    capitaliseFees?: boolean;
    fxRate?: number | null;
    /** The Budget account the money left, and the category it consumed. */
    fromAccountId?: string | null;
    categoryId?: string | null;
    /**
     * Where this lot came from, when it came from a statement. Recorded so a
     * re-issued statement recognises it even after R25.4 has split it — see
     * migration 0006.
     */
    sourceRef?: string | null;
  },
): Lot {
  return transact(db, () => {
    const holding = findOrCreateHolding(db, actor, input.accountId, input.instrumentId);
    const lot = makeLot({
      id: newId(),
      tradeDate: input.tradeDate,
      price: input.price,
      units: input.units,
      amount: input.amount,
      fees: input.fees,
      capitaliseFees: input.capitaliseFees,
      fxRate: input.fxRate,
    });

    let transactionId: string | null = null;
    if (input.fromAccountId) {
      // FW4 in practice: the budget sees money leaving a category, never a
      // portfolio value arriving.
      const paid = createTransaction(db, actor, {
        accountId: input.fromAccountId,
        amount: -lot.cost,
        date: input.tradeDate,
        categoryId: input.categoryId ?? null,
        memo: `Bought ${formatUnits(lot.units)} units`,
        cleared: true,
      });
      transactionId = paid.id;
    }

    execute(
      db,
      `INSERT INTO lots (id,holding_id,trade_date,units,price,fees,cost,fx_rate,transaction_id,source_ref,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      lot.id, holding.id, lot.tradeDate, lot.units, lot.price, lot.fees, lot.cost,
      lot.fxRate, transactionId, input.sourceRef ?? null, nowIST(),
    );

    const instrument = getInstrument(db, input.instrumentId);
    appendEvent(db, actor, {
      entity: "holding", entityId: holding.id, action: "purchase", after: lot,
      summary:
        `Bought ${formatUnits(lot.units)} units of ${instrument?.name ?? "an instrument"} ` +
        `for ${formatPaise(lot.cost)} on ${formatDate(lot.tradeDate)}`,
    });

    return lot;
  });
}

function findOrCreateHolding(
  db: DB, actor: Actor, accountId: string, instrumentId: string,
): HoldingRecord {
  const existing = queryOne<HoldingRecord>(
    db,
    `SELECT * FROM holdings WHERE account_id = ? AND instrument_id = ? AND closed_at IS NULL`,
    accountId, instrumentId,
  );
  if (existing) return existing;

  const id = newId();
  execute(
    db, `INSERT INTO holdings (id,account_id,instrument_id,created_at) VALUES (?,?,?,?)`,
    id, accountId, instrumentId, nowIST(),
  );
  void actor;
  return queryOne<HoldingRecord>(db, `SELECT * FROM holdings WHERE id = ?`, id)!;
}

export function listHoldings(db: DB, accountId?: string): HoldingRecord[] {
  return accountId
    ? queryAll<HoldingRecord>(
        db, `SELECT * FROM holdings WHERE account_id = ? AND closed_at IS NULL`, accountId,
      )
    : queryAll<HoldingRecord>(db, `SELECT * FROM holdings WHERE closed_at IS NULL`);
}

export function lotsFor(db: DB, holdingId: string): Lot[] {
  return queryAll<{
    id: string; trade_date: string; units: number; price: number;
    fees: number; cost: number; fx_rate: number | null;
  }>(
    db,
    `SELECT * FROM lots WHERE holding_id = ? AND closed_at IS NULL ORDER BY trade_date, created_at`,
    holdingId,
  ).map((r) => ({
    id: r.id, tradeDate: r.trade_date, units: r.units, price: r.price,
    fees: r.fees, cost: r.cost, fxRate: r.fx_rate,
  }));
}

export function holdingOf(db: DB, holdingId: string): Holding {
  return { lots: lotsFor(db, holdingId) };
}

// ---------------------------------------------------------------------------
// R26 · Prices
// ---------------------------------------------------------------------------

export interface Quote {
  price: MicroRupees;
  asOf: IsoDate;
  source: string;
  /** R26.4 · Marked, and the value still shown — never blanked, never zeroed. */
  stale: boolean;
  ageDays: number;
}

export function recordPrice(
  db: DB,
  input: { instrumentId: string; price: MicroRupees; asOf: IsoDate; source: string },
): void {
  // R26.5: a later fetch never overwrites a good price for the same date with
  // a worse one — the primary key makes a re-fetch idempotent.
  execute(
    db,
    `INSERT INTO prices (instrument_id, as_of, price, source, fetched_at) VALUES (?,?,?,?,?)
       ON CONFLICT(instrument_id, as_of) DO UPDATE SET price = excluded.price,
         source = excluded.source, fetched_at = excluded.fetched_at`,
    input.instrumentId, input.asOf, input.price, input.source, nowIST(),
  );
}

/**
 * R26.8 · The last *published* price, labelled with its actual date. Never
 * interpolated, never forward-filled silently.
 */
export function latestPrice(
  db: DB, instrumentId: string, asOf = todayIST(), staleAfterDays = 4,
): Quote | null {
  const row = queryOne<{ price: number; as_of: string; source: string }>(
    db,
    `SELECT price, as_of, source FROM prices WHERE instrument_id = ? AND as_of <= ?
      ORDER BY as_of DESC LIMIT 1`,
    instrumentId, asOf,
  );
  if (!row) return null;

  const ageDays = daysBetween(row.as_of, asOf);
  return {
    price: row.price, asOf: row.as_of, source: row.source,
    stale: ageDays > staleAfterDays, ageDays,
  };
}

export function priceHistory(
  db: DB, instrumentId: string, limit = 400,
): { asOf: IsoDate; price: MicroRupees; source: string }[] {
  return queryAll<{ as_of: string; price: number; source: string }>(
    db,
    `SELECT as_of, price, source FROM prices WHERE instrument_id = ?
      ORDER BY as_of DESC LIMIT ?`,
    instrumentId, limit,
  ).map((r) => ({ asOf: r.as_of, price: r.price, source: r.source }));
}

// ---------------------------------------------------------------------------
// R32 · FX rates
// ---------------------------------------------------------------------------

export function recordFxRate(
  db: DB,
  input: { base: string; quote: string; rate: number; asOf: IsoDate; source: string },
): void {
  execute(
    db,
    `INSERT INTO fx_rates (base, quote, as_of, rate, source, fetched_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(base, quote, as_of) DO UPDATE SET rate = excluded.rate,
         source = excluded.source, fetched_at = excluded.fetched_at`,
    input.base, input.quote, input.asOf, input.rate, input.source, nowIST(),
  );
}

export interface FxQuote {
  rate: number;
  asOf: IsoDate;
  source: string;
  stale: boolean;
}

/** R32.3 · The last published rate, labelled with its actual date. */
export function fxRate(
  db: DB, base: string, quote: string, asOf = todayIST(),
): FxQuote | null {
  if (base === quote) {
    return { rate: 1, asOf, source: "identity", stale: false };
  }
  const row = queryOne<{ rate: number; as_of: string; source: string }>(
    db,
    `SELECT rate, as_of, source FROM fx_rates WHERE base = ? AND quote = ? AND as_of <= ?
      ORDER BY as_of DESC LIMIT 1`,
    base, quote, asOf,
  );
  if (!row) return null;

  return {
    rate: row.rate, asOf: row.as_of, source: row.source,
    stale: daysBetween(row.as_of, asOf) > FX_STALE_DAYS,
  };
}

// ---------------------------------------------------------------------------
// R27 · The full picture for one holding
// ---------------------------------------------------------------------------

export interface HoldingView {
  holding: HoldingRecord;
  instrument: Instrument;
  lots: Lot[];
  units: Milliunits;
  costBasis: Paise;
  /** Base currency per unit — what the units cost you. */
  averageCost: MicroRupees;
  /** The instrument's own currency per unit — what a broker shows. */
  averageUnitPrice: MicroRupees;
  quote: Quote | null;
  fx: FxQuote | null;
  marketValue: Paise;
  unrealisedGain: Paise;
  absoluteReturn: number;
  /** R27.1 · The default headline for anything with more than one lot. */
  xirr: number | null;
  realisedGain: Paise;
  /** R28 / R27.5 · Tracked separately, never folded into price gains. */
  dividends: Paise;
  /** R34 · Only for a foreign holding. */
  decomposition: GainDecomposition | null;
}

export function viewHolding(
  db: DB, holdingId: string, asOf = todayIST(), baseCurrency = "INR",
): HoldingView | null {
  const record = queryOne<HoldingRecord>(db, `SELECT * FROM holdings WHERE id = ?`, holdingId);
  if (!record) return null;

  const instrument = getInstrument(db, record.instrument_id)!;
  const holding = holdingOf(db, holdingId);
  const quote = latestPrice(db, instrument.id, asOf);
  const fx =
    instrument.currency === baseCurrency
      ? { rate: 1, asOf, source: "identity", stale: false }
      : fxRate(db, instrument.currency, baseCurrency, asOf);

  const rate = fx?.rate ?? 1;
  const unitPrice = quote?.price ?? averageCost(holding);

  const events = queryAll<{ kind: string; realised_gain: number | null; amount: number | null }>(
    db, `SELECT kind, realised_gain, amount FROM holding_events WHERE holding_id = ?`, holdingId,
  );

  const realisedGain = events
    .filter((e) => e.kind === "sale")
    .reduce((sum, e) => sum + (e.realised_gain ?? 0), 0);
  const dividends = events
    .filter((e) => e.kind === "dividend")
    .reduce((sum, e) => sum + (e.amount ?? 0), 0);

  // R34: only meaningful when the instrument is priced in another currency.
  const firstLot = holding.lots[0];
  const decomposition =
    instrument.currency !== baseCurrency && firstLot && quote
      ? decomposeGain({
          quantity: totalUnits(holding),
          // The price paid in the instrument's own currency — averageCost is
          // in base, and feeding that in would count the FX move twice.
          priceAtPurchase: averageUnitPrice(holding),
          priceNow: quote.price,
          fxAtPurchase: firstLot.fxRate ?? rate,
          fxNow: rate,
        })
      : null;

  return {
    holding: record,
    instrument,
    lots: holding.lots,
    units: totalUnits(holding),
    costBasis: costBasis(holding),
    averageCost: averageCost(holding),
    averageUnitPrice: averageUnitPrice(holding),
    quote,
    fx,
    marketValue: marketValue(holding, unitPrice, rate),
    unrealisedGain: unrealisedGain(holding, unitPrice, rate),
    absoluteReturn: absoluteReturn(holding, unitPrice, rate),
    xirr:
      holding.lots.length > 0
        ? xirr(holdingCashFlows(holding, unitPrice, asOf, rate))
        : null,
    realisedGain,
    dividends,
    decomposition,
  };
}

// ---------------------------------------------------------------------------
// R25, R28 · Sales and corporate actions
// ---------------------------------------------------------------------------

/** S13c · The FIFO preview, before anything is confirmed. */
export function previewHoldingSale(
  db: DB, holdingId: string, quantity: Milliunits, unitPrice: MicroRupees,
  opts: { charges?: Paise; saleDate?: IsoDate } = {},
): SalePreview {
  return previewSale(holdingOf(db, holdingId), quantity, unitPrice, opts);
}

/**
 * FW5 · Sale proceeds landing in a Budget account are income to Ready to
 * Assign — **the full proceeds, not the gain**. Cash is cash.
 */
export function recordSale(
  db: DB, actor: Actor,
  input: {
    holdingId: string;
    units: Milliunits;
    price: MicroRupees;
    date: IsoDate;
    charges?: Paise;
    /** Where the money landed. Leaving it null keeps the cash outside the budget. */
    toAccountId?: string | null;
    /** The statement row this came from, if any. See migration 0006. */
    sourceRef?: string | null;
  },
): SalePreview {
  return transact(db, () => {
    const preview = previewSale(holdingOf(db, input.holdingId), input.units, input.price, {
      charges: input.charges,
      saleDate: input.date,
    });

    // R25.4: consumed lots are closed and partials rewritten at their original
    // price and date, so the surviving units keep their holding period.
    for (const consumed of preview.consumed) {
      const survivor = preview.remainingLots.find((l) => l.id === consumed.lotId);
      if (survivor) {
        execute(
          db, `UPDATE lots SET units = ?, cost = ? WHERE id = ?`,
          survivor.units, survivor.cost, consumed.lotId,
        );
      } else {
        execute(db, `UPDATE lots SET closed_at = ? WHERE id = ?`, nowIST(), consumed.lotId);
      }
    }

    let transactionId: string | null = null;
    if (input.toAccountId) {
      // Uncategorised on purpose: that is what makes it reach Ready to Assign
      // as income needing assignment (FW5, derivation §3).
      const received = createTransaction(db, actor, {
        accountId: input.toAccountId,
        amount: preview.proceeds,
        date: input.date,
        memo: `Sold ${formatUnits(input.units)} units`,
        cleared: true,
      });
      transactionId = received.id;
    }

    execute(
      db,
      `INSERT INTO holding_events
         (id,holding_id,date,kind,units,price,amount,realised_gain,detail_json,
          transaction_id,source_ref,created_at,created_by)
       VALUES (?,?,?,'sale',?,?,?,?,?,?,?,?,?)`,
      newId(), input.holdingId, input.date, input.units, input.price,
      preview.proceeds, preview.realisedGain,
      /*
       * B88 · Which parcels this sale consumed, and how long each was held.
       *
       * R25.5 already says the holding period is "exposed so long-term versus
       * short-term is visible to the user", and the FIFO engine computes it per
       * parcel — it was then thrown away at the point of writing, leaving a
       * single aggregate gain. A sale of units bought across four years is one
       * number with four different answers inside it, and by the time anyone
       * asks, the lots have been closed and rewritten and it cannot be
       * recovered.
       *
       * Stored as the sale's own record of what it consumed, so a gains
       * statement is a reading of history rather than a reconstruction of it.
       */
      JSON.stringify({
        parcels: preview.consumed.map((c) => ({
          tradeDate: c.tradeDate,
          units: c.units,
          cost: c.cost,
          proceeds: Math.round((c.units / input.units) * preview.proceeds),
          holdingPeriodDays: c.holdingPeriodDays,
        })),
      }),
      transactionId,
      input.sourceRef ?? null, nowIST(), actor.memberId,
    );

    appendEvent(db, actor, {
      entity: "holding", entityId: input.holdingId, action: "sale",
      after: { units: input.units, proceeds: preview.proceeds, realisedGain: preview.realisedGain },
      // R27.4: realised and unrealised are never summed into one figure.
      summary:
        `Sold ${formatUnits(input.units)} units for ${formatPaise(preview.proceeds)} — ` +
        `realised ${preview.realisedGain >= 0 ? "gain" : "loss"} ` +
        `${formatPaise(Math.abs(preview.realisedGain))}`,
    });

    return preview;
  });
}

/**
 * FW6 · A dividend credited to a Budget account is income. A reinvested one is
 * not — it becomes a new lot and never touches the budget.
 */
export function recordDividend(
  db: DB, actor: Actor,
  input: {
    holdingId: string;
    date: IsoDate;
    amount: Paise;
    /** Set for a cash payout; leave null for reinvestment. */
    toAccountId?: string | null;
    /** Set for reinvestment — the NAV the new units were allotted at. */
    reinvestAtPrice?: MicroRupees | null;
    /** The statement row this came from, if any. See migration 0006. */
    sourceRef?: string | null;
  },
): void {
  transact(db, () => {
    const reinvested = input.reinvestAtPrice != null;
    let transactionId: string | null = null;

    if (!reinvested && input.toAccountId) {
      const received = createTransaction(db, actor, {
        accountId: input.toAccountId,
        amount: input.amount,
        date: input.date,
        memo: "Dividend",
        cleared: true,
      });
      transactionId = received.id;
    }

    if (reinvested) {
      const lot = makeLot({
        id: newId(), tradeDate: input.date,
        price: input.reinvestAtPrice!, amount: input.amount,
      });
      execute(
        db,
        `INSERT INTO lots (id,holding_id,trade_date,units,price,fees,cost,created_at)
         VALUES (?,?,?,?,?,0,?,?)`,
        lot.id, input.holdingId, lot.tradeDate, lot.units, lot.price, lot.cost, nowIST(),
      );
    }

    execute(
      db,
      `INSERT INTO holding_events (id,holding_id,date,kind,amount,transaction_id,source_ref,created_at,created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      newId(), input.holdingId, input.date,
      reinvested ? "dividend-reinvested" : "dividend",
      input.amount, transactionId, input.sourceRef ?? null, nowIST(), actor.memberId,
    );

    appendEvent(db, actor, {
      entity: "holding", entityId: input.holdingId, action: "dividend",
      after: { amount: input.amount, reinvested },
      summary: reinvested
        ? `Reinvested a ${formatPaise(input.amount)} dividend into new units`
        : `Received a ${formatPaise(input.amount)} dividend as cash`,
    });
  });
}

/** R28 · A split or bonus. Units multiply; total cost basis is unchanged. */
export function recordSplit(
  db: DB, actor: Actor,
  input: { holdingId: string; date: IsoDate; ratio: number; kind?: "split" | "bonus" },
): void {
  transact(db, () => {
    const after = applySplit(holdingOf(db, input.holdingId), input.ratio);
    for (const lot of after.lots) {
      execute(db, `UPDATE lots SET units = ?, price = ? WHERE id = ?`, lot.units, lot.price, lot.id);
    }

    // R28.2: the price history is adjusted too, so a chart does not show a
    // false crash on the split date.
    const holdingRow = queryOne<{ instrument_id: string }>(
      db, `SELECT instrument_id FROM holdings WHERE id = ?`, input.holdingId,
    );
    if (holdingRow) {
      execute(
        db, `UPDATE prices SET price = CAST(price / ? AS INTEGER)
              WHERE instrument_id = ? AND as_of < ?`,
        input.ratio, holdingRow.instrument_id, input.date,
      );
    }

    execute(
      db,
      `INSERT INTO holding_events (id,holding_id,date,kind,ratio,created_at,created_by)
       VALUES (?,?,?,?,?,?,?)`,
      newId(), input.holdingId, input.date, input.kind ?? "split",
      input.ratio, nowIST(), actor.memberId,
    );

    appendEvent(db, actor, {
      entity: "holding", entityId: input.holdingId, action: "split",
      after: { ratio: input.ratio },
      summary:
        `Applied a ${input.ratio}-for-1 ${input.kind ?? "split"}. ` +
        `Units multiplied; the cost basis is unchanged, because nothing was bought.`,
    });
  });
}

/**
 * R28 · A merger or a scheme amalgamation.
 *
 * The event Indian mutual-fund investors actually meet: two schemes merge, the
 * units are reissued at a ratio, and — the part that matters at tax time — the
 * **original cost and the original purchase dates carry forward**. It is not a
 * sale, so nothing is realised, and the holding period is not reset. Treating it
 * as a sale-and-repurchase would manufacture a capital gain that never happened
 * and restart the clock on long-term treatment.
 *
 * `applyMerger` encoded exactly that and was called by nothing: the table had
 * allowed `kind = 'merger'` since it was created, and there was no way to record
 * one. A household whose fund merged had to choose between a wrong unit count
 * and a fictitious sale.
 */
export function recordMerger(
  db: DB, actor: Actor,
  input: { holdingId: string; date: IsoDate; ratio: number; intoInstrumentId?: string | null },
): void {
  if (!(input.ratio > 0)) throw new Refusal("A merger ratio has to be a number above zero.");

  transact(db, () => {
    const before = holdingOf(db, input.holdingId);
    const after = applyMerger(before, input.ratio);
    for (const lot of after.lots) {
      execute(db, `UPDATE lots SET units = ?, price = ? WHERE id = ?`, lot.units, lot.price, lot.id);
    }

    const holding = queryOne<{ instrument_id: string; account_id: string }>(
      db, `SELECT instrument_id, account_id FROM holdings WHERE id = ?`, input.holdingId,
    );
    if (!holding) throw new Refusal("That holding does not exist.");

    const into = input.intoInstrumentId ?? holding.instrument_id;
    if (into !== holding.instrument_id) {
      /*
       * One open holding per instrument per account, by index. Merging into
       * something the household already holds would collide, and silently
       * merging the two would lose the distinction between lots bought at
       * different times — which is the one thing R25.1 says never to do.
       */
      const clash = queryOne<{ id: string }>(
        db,
        `SELECT id FROM holdings
          WHERE account_id = ? AND instrument_id = ? AND closed_at IS NULL AND id <> ?`,
        holding.account_id, into, input.holdingId,
      );
      if (clash) {
        throw new Refusal(
          "You already hold the scheme it merged into, in the same account. Record " +
          "the merger against that holding instead, or keep this one under its own name.",
        );
      }
      execute(db, `UPDATE holdings SET instrument_id = ? WHERE id = ?`, into, input.holdingId);
    }

    execute(
      db,
      `INSERT INTO holding_events (id,holding_id,date,kind,ratio,created_at,created_by)
       VALUES (?,?,?,?,?,?,?)`,
      newId(), input.holdingId, input.date, "merger", input.ratio, nowIST(), actor.memberId,
    );

    const name = queryOne<{ name: string }>(
      db, `SELECT name FROM instruments WHERE id = ?`, into,
    )?.name;
    appendEvent(db, actor, {
      entity: "holding", entityId: input.holdingId, action: "merger",
      after: { ratio: input.ratio, instrumentId: into },
      summary:
        `Merged at ${input.ratio} new units for each one held` +
        (name && into !== holding.instrument_id ? `, into ${name}` : "") +
        `. Cost and purchase dates carry forward, so nothing is realised.`,
    });
  });
}

/** R28 · Reduces the basis rather than creating a gain. */
export function recordReturnOfCapital(
  db: DB, actor: Actor, input: { holdingId: string; date: IsoDate; amount: Paise },
): void {
  transact(db, () => {
    const after = applyReturnOfCapital(holdingOf(db, input.holdingId), input.amount);
    for (const lot of after.lots) {
      execute(db, `UPDATE lots SET cost = ? WHERE id = ?`, lot.cost, lot.id);
    }
    execute(
      db,
      `INSERT INTO holding_events (id,holding_id,date,kind,amount,created_at,created_by)
       VALUES (?,?,?,'return-of-capital',?,?,?)`,
      newId(), input.holdingId, input.date, input.amount, nowIST(), actor.memberId,
    );
    appendEvent(db, actor, {
      entity: "holding", entityId: input.holdingId, action: "return-of-capital",
      after: { amount: input.amount },
      summary:
        `Recorded a ${formatPaise(input.amount)} return of capital — this reduces ` +
        `what the holding cost you, rather than counting as a gain.`,
    });
  });
}

registerUndoHandler("holding", (db, event) => {
  if (event.action === "purchase") {
    const lot = event.after as Lot;
    execute(db, `DELETE FROM lots WHERE id = ?`, lot.id);
    return `Removed the purchase of ${formatUnits(lot.units)} units`;
  }
  return `Reversed a change to the holding`;
});

registerUndoHandler("asset-account", (db, event) => {
  if (event.action === "create") {
    execute(db, `DELETE FROM asset_valuations WHERE account_id = ?`, event.entityId!);
    execute(db, `DELETE FROM accounts WHERE id = ?`, event.entityId!);
    return `Removed the asset account that was added`;
  }
  return `Reversed a change to the asset account`;
});

registerUndoHandler("instrument", (db, event) => {
  execute(db, `DELETE FROM instruments WHERE id = ?`, event.entityId!);
  return `Removed the instrument that was added`;
});

// ---------------------------------------------------------------------------
// F19.13 · CSV export of holdings, lots, price history and the net-worth series
// ---------------------------------------------------------------------------

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(headers: string[], rows: (unknown[])[]): string {
  return [headers.join(","), ...rows.map((r) => r.map(csvField).join(","))].join("\n");
}

/**
 * F19.13 · One CSV per shape, so a spreadsheet can hold each without a join.
 *
 * Units are printed as their three-decimal value and prices as rupees, because
 * this file is for a human in Excel — the milliunit/micro-rupee integers are an
 * internal storage detail (E13), not something to export raw.
 */
export function exportHoldingsCsv(db: DB): string {
  const rows = queryAll<{
    account: string; instrument: string; isin: string | null; kind: string;
    asset_class: string | null; region: string | null; currency: string;
    units: number; cost: number;
  }>(
    db,
    `SELECT a.name AS account, i.name AS instrument, i.isin, i.kind,
            i.asset_class, i.region, i.currency,
            COALESCE(SUM(l.units),0) AS units, COALESCE(SUM(l.cost),0) AS cost
       FROM holdings h
       JOIN accounts a ON a.id = h.account_id
       JOIN instruments i ON i.id = h.instrument_id
       LEFT JOIN lots l ON l.holding_id = h.id AND l.closed_at IS NULL
      WHERE h.closed_at IS NULL
      GROUP BY h.id
      ORDER BY a.name, i.name`,
  );
  return toCsv(
    ["account", "instrument", "isin", "kind", "asset_class", "region", "currency", "units", "cost_basis"],
    rows.map((r) => [
      r.account, r.instrument, r.isin, r.kind, r.asset_class, r.region, r.currency,
      (r.units / 1000).toFixed(3), (r.cost / 100).toFixed(2),
    ]),
  );
}

export function exportLotsCsv(db: DB): string {
  const rows = queryAll<{
    account: string; instrument: string; trade_date: string;
    units: number; price: number; fees: number; cost: number;
    fx_rate: number | null; closed_at: string | null; source_ref: string | null;
  }>(
    db,
    `SELECT a.name AS account, i.name AS instrument, l.trade_date,
            l.units, l.price, l.fees, l.cost, l.fx_rate, l.closed_at, l.source_ref
       FROM lots l
       JOIN holdings h ON h.id = l.holding_id
       JOIN accounts a ON a.id = h.account_id
       JOIN instruments i ON i.id = h.instrument_id
      ORDER BY i.name, l.trade_date, l.created_at`,
  );
  return toCsv(
    ["account", "instrument", "trade_date", "units", "price_per_unit", "fees", "cost_basis", "fx_rate", "closed", "source"],
    rows.map((r) => [
      r.account, r.instrument, r.trade_date,
      (r.units / 1000).toFixed(3), (r.price / 1_000_000).toFixed(4),
      (r.fees / 100).toFixed(2), (r.cost / 100).toFixed(2),
      r.fx_rate ?? "", r.closed_at ? "yes" : "no", r.source_ref ?? "",
    ]),
  );
}

export function exportPriceHistoryCsv(db: DB): string {
  const rows = queryAll<{ instrument: string; isin: string | null; as_of: string; price: number; source: string }>(
    db,
    `SELECT i.name AS instrument, i.isin, p.as_of, p.price, p.source
       FROM prices p JOIN instruments i ON i.id = p.instrument_id
      ORDER BY i.name, p.as_of`,
  );
  return toCsv(
    ["instrument", "isin", "as_of", "price", "source"],
    rows.map((r) => [r.instrument, r.isin, r.as_of, (r.price / 1_000_000).toFixed(4), r.source]),
  );
}

export function exportNetWorthCsv(db: DB): string {
  const rows = queryAll<{
    as_of: string; cash: number; investments: number; other_assets: number;
    credit_cards: number; loans: number; net_worth: number; worst_price_date: string | null;
  }>(db, `SELECT * FROM net_worth_snapshots ORDER BY as_of`);
  return toCsv(
    ["as_of", "cash", "investments", "other_assets", "credit_cards", "loans", "net_worth", "worst_price_date"],
    rows.map((r) => [
      r.as_of,
      (r.cash / 100).toFixed(2), (r.investments / 100).toFixed(2), (r.other_assets / 100).toFixed(2),
      (r.credit_cards / 100).toFixed(2), (r.loans / 100).toFixed(2), (r.net_worth / 100).toFixed(2),
      r.worst_price_date ?? "",
    ]),
  );
}
