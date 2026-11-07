/**
 * IMP-31 · Reconciling a SafeGold statement against what is already held.
 *
 * The same shape as `cas-plan.ts`, for one instrument instead of many:
 *
 *   · A row is matched by a **reference recorded with what it wrote**, made
 *     from the row's own content (date, time, kind, grams, amount), so a
 *     statement read twice — uploaded and then mailed, or mailed twice —
 *     adds nothing the second time, even after a sale has shrunk the lot.
 *   · A purchase is a lot at the rate per gram, and its cost is the amount
 *     the statement says was paid: the GST and any rounding are the lot's
 *     fees, capitalised into the basis as every purchase charge is (R24.5).
 *   · A sale is a FIFO sale at the rate, realising a gain the gains-tax
 *     estimate files as gold: long-term after 24 months (s112, 12.5%).
 *   · Nothing writes until a person confirms (`04` I2), and a statement whose
 *     rows do not reach its own closing balance is refused unless they say
 *     to import it anyway (R24.3, N9).
 *   · The import is one event on the holding, which undoes as one action.
 */

import type { DB } from "../db/db.ts";
import { transact, queryAll } from "../db/db.ts";
import { createHash } from "node:crypto";
import { appendEvent, type Actor } from "../core/events.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale,
  listAssetAccounts, listHoldings, listInstruments, holdingOf,
} from "../domain/assets.ts";
import { totalUnits, valueOf } from "../portfolio/holdings.ts";
import { Refusal } from "../core/refusal.ts";
import { memberScope } from "../domain/member-scope.ts";
import {
  SAFEGOLD_INSTRUMENT, gramsDisagreement, formatGrams,
  type SafeGoldRow, type SafeGoldStatement,
} from "./safegold.ts";

/** The instrument's symbol: how a later import finds it again, whatever it has been renamed. */
export const SAFEGOLD_SYMBOL = "SAFEGOLD-24K-MG";
/** The account a first import creates when the household has no commodity account for it. */
export const SAFEGOLD_ACCOUNT = "SafeGold";

function rowRef(row: SafeGoldRow, occurrence: number): string {
  const digest = createHash("sha256")
    .update(`safegold|${row.date}|${row.time ?? ""}|${row.kind}|${row.units}|${row.amount ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return `safegold:${digest}:${occurrence}`;
}

export interface PlannedGoldRow {
  row: SafeGoldRow;
  status: "new" | "already-held" | "skipped";
  note: string | null;
  ref: string;
  /** What the lot or sale is recorded at, in micro-rupees per milligram. */
  price: number | null;
  /** A purchase's fees (GST and rounding) or a sale's charges, in paise. */
  charges: Paise;
}

export interface PlannedGoldStatement {
  period: SafeGoldStatement["period"];
  openingUnits: number | null;
  closingUnits: number | null;
  /** R24.3 · closing less opening-plus-rows; null when they agree. */
  disagreement: number | null;
  unparsed: string[];
}

export interface SafeGoldPlan {
  statements: PlannedGoldStatement[];
  /** Where the gold lands; null when the import is to create the account. */
  accountId: string | null;
  accountName: string;
  newAccount: boolean;
  instrumentId: string | null;
  /** What the ledger holds now, in milliunits of a milligram. */
  heldUnits: number;
  /**
   * The last statement's closing balance less what the ledger will hold once
   * the new rows are recorded; null when they agree or there is no closing
   * figure. Gold bought before the first imported statement shows here.
   */
  ledgerGap: number | null;
  rows: PlannedGoldRow[];
  totals: { newEntries: number; alreadyHeld: number; skipped: number; invested: Paise; soldFor: Paise };
}

/** Where a SafeGold import lands, for the viewer: their gold holding, else the one commodity account. */
function destination(
  db: DB, viewerMemberId: string | null | undefined, instrumentId: string | null,
): { accountId: string | null; name: string } {
  const scope = viewerMemberId === undefined ? null : memberScope(db, viewerMemberId);
  const accounts = listAssetAccounts(db, viewerMemberId === undefined ? {} : { viewerMemberId });
  const named = new Map(accounts.map((a) => [a.id, a.name]));
  if (instrumentId) {
    const held = listHoldings(db).find((h) => h.instrument_id === instrumentId && !scope?.hides(h.account_id));
    if (held && named.has(held.account_id)) return { accountId: held.account_id, name: named.get(held.account_id)! };
  }
  const commodity = accounts.filter((a) => a.subtype === "commodity");
  const pick = commodity.length === 1
    ? commodity[0]
    : commodity.find((a) => /safe\s*gold/i.test(`${a.name} ${a.institution ?? ""}`));
  return pick ? { accountId: pick.id, name: pick.name } : { accountId: null, name: SAFEGOLD_ACCOUNT };
}

function safeGoldInstrument(db: DB): string | null {
  const found = listInstruments(db).find((i) => i.symbol === SAFEGOLD_SYMBOL)
    ?? listInstruments(db).find((i) => i.name === SAFEGOLD_INSTRUMENT);
  return found?.id ?? null;
}

/** References already recorded against a holding. */
function recordedRefs(db: DB, holdingId: string): Set<string> {
  return new Set(queryAll<{ source_ref: string }>(
    db,
    `SELECT source_ref FROM lots WHERE holding_id = ? AND source_ref IS NOT NULL
     UNION ALL
     SELECT source_ref FROM holding_events WHERE holding_id = ? AND source_ref IS NOT NULL`,
    holdingId, holdingId,
  ).map((r) => r.source_ref));
}

/**
 * What importing these statements would do, against the current ledger.
 * Several at once is a Gmail fetch reading a few months' statements.
 */
export function planSafeGoldImport(
  db: DB, statements: SafeGoldStatement[],
  /** Who is importing; their visible gold holding is the one matched. Undefined is the whole household. */
  viewerMemberId?: string | null,
): SafeGoldPlan {
  const instrumentId = safeGoldInstrument(db);
  const where = destination(db, viewerMemberId, instrumentId);
  const holding = where.accountId && instrumentId
    ? listHoldings(db, where.accountId).find((h) => h.instrument_id === instrumentId)
    : undefined;
  const known = holding ? recordedRefs(db, holding.id) : new Set<string>();
  const heldUnits = holding ? totalUnits(holdingOf(db, holding.id)) : 0;

  const ordered = [...statements].sort((a, b) => (a.period?.from ?? "").localeCompare(b.period?.from ?? ""));
  const planned: PlannedGoldStatement[] = [];
  const rows: PlannedGoldRow[] = [];
  const inThisPlan = new Set<string>();
  const totals = { newEntries: 0, alreadyHeld: 0, skipped: 0, invested: 0 as Paise, soldFor: 0 as Paise };

  for (const statement of ordered) {
    planned.push({
      period: statement.period, openingUnits: statement.openingUnits, closingUnits: statement.closingUnits,
      disagreement: gramsDisagreement(statement), unparsed: statement.unparsed,
    });
    // Occurrences within one statement: two identical ₹10 purchases on one day are both real.
    const seen = new Map<string, number>();
    for (const row of statement.rows) {
      const base = rowRef(row, 0);
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      const ref = rowRef(row, occurrence);

      if (known.has(ref) || inThisPlan.has(ref)) {
        rows.push({ row, ref, status: "already-held", note: "An earlier statement already recorded this.", price: null, charges: 0 });
        totals.alreadyHeld++;
        continue;
      }
      if (row.kind === "other") {
        rows.push({
          row, ref, status: "skipped", price: null, charges: 0,
          note: "Not a purchase or a sale — record it by hand if it changes what you hold.",
        });
        totals.skipped++;
        continue;
      }

      const grams = Math.abs(row.units);
      // The rate as printed; failing that, what the amount less its GST works out to.
      const price = row.price ?? (row.amount !== null
        ? Math.round(((row.amount - (row.kind === "buy" ? row.gst : 0)) * 10_000_000) / grams)
        : null);
      if (price === null || price <= 0) {
        rows.push({
          row, ref, status: "skipped", price: null, charges: 0,
          note: "The statement gives no rate or amount for this, so it has no cost to record.",
        });
        totals.skipped++;
        continue;
      }
      const value = valueOf(grams, price);
      let charges: Paise;
      if (row.kind === "buy") {
        // The cost is what was paid. An amount that already includes the GST
        // is the whole of it; one printed before GST has it added.
        const paid = row.amount === null
          ? value + row.gst
          : row.amount >= value + row.gst - Math.max(100, Math.round(value / 100)) ? row.amount : row.amount + row.gst;
        charges = Math.max(0, paid - value) as Paise;
        totals.invested = (totals.invested + value + charges) as Paise;
      } else {
        // A sale credited less than the gold's value at the rate: the difference is its charge.
        charges = (row.amount !== null ? Math.max(0, value - row.amount) : 0) as Paise;
        totals.soldFor = (totals.soldFor + value - charges) as Paise;
      }
      inThisPlan.add(ref);
      rows.push({ row, ref, status: "new", note: null, price, charges });
      totals.newEntries++;
    }
  }

  const last = planned[planned.length - 1];
  const after = rows.filter((r) => r.status === "new").reduce((sum, r) => sum + r.row.units, heldUnits);
  const gap = last?.closingUnits != null ? last.closingUnits - after : 0;

  return {
    statements: planned,
    accountId: where.accountId,
    accountName: where.name,
    newAccount: where.accountId === null,
    instrumentId,
    heldUnits,
    ledgerGap: gap === 0 ? null : gap,
    rows,
    totals,
  };
}

export interface SafeGoldApplyResult { lots: number; sales: number; accountId: string | null }

/**
 * Apply a plan a person has confirmed. Only `new` rows are written, oldest
 * first so a sale finds the lots it sells from. One event on the holding
 * records the import, with the lots as they stood before it, so it undoes as
 * one action (assets.ts, the holding's undo).
 */
export function applySafeGoldPlan(
  db: DB, actor: Actor, plan: SafeGoldPlan, opts: { acceptMismatch?: boolean } = {},
): SafeGoldApplyResult {
  const mismatched = plan.statements.find((s) => s.disagreement !== null);
  if (mismatched && !opts.acceptMismatch) {
    throw new Refusal(
      `The statement closes at ${formatGrams(mismatched.closingUnits ?? 0)}, but its opening balance and ` +
      `rows come to ${formatGrams((mismatched.closingUnits ?? 0) - mismatched.disagreement!)} — a row is ` +
      `probably missing. Nothing was imported. Tick "import it anyway" to record the rows it does show.`,
    );
  }
  const fresh = plan.rows
    .filter((r) => r.status === "new")
    .sort((a, b) => `${a.row.date} ${a.row.time ?? ""}`.localeCompare(`${b.row.date} ${b.row.time ?? ""}`));
  if (fresh.length === 0) return { lots: 0, sales: 0, accountId: plan.accountId };

  return transact(db, () => {
    const accountId = plan.accountId ?? createAssetAccount(db, actor, {
      name: SAFEGOLD_ACCOUNT, subtype: "commodity", institution: "SafeGold",
      holderMemberId: actor.memberId ?? null,
    }).id;
    const instrumentId = plan.instrumentId ?? findOrCreateInstrument(db, actor, {
      name: SAFEGOLD_INSTRUMENT, kind: "commodity", symbol: SAFEGOLD_SYMBOL, provider: "manual",
    }).id;

    const existing = listHoldings(db, accountId).find((h) => h.instrument_id === instrumentId);
    const before = existing
      ? queryAll<{ id: string; units: number; cost: number; closed_at: string | null }>(
          db, `SELECT id, units, cost, closed_at FROM lots WHERE holding_id = ?`, existing.id,
        )
      : [];

    let holdingId = existing?.id ?? null;
    const result: SafeGoldApplyResult = { lots: 0, sales: 0, accountId };
    let invested = 0;
    for (const { row, ref, price, charges } of fresh) {
      if (row.kind === "buy") {
        const lot = recordPurchase(db, actor, {
          accountId, instrumentId, tradeDate: row.date, price: price!, units: row.units,
          fees: charges, fromAccountId: null, sourceRef: ref,
        });
        invested += lot.cost;
        holdingId ??= listHoldings(db, accountId).find((h) => h.instrument_id === instrumentId)!.id;
        result.lots++;
        continue;
      }
      const held = holdingId ? totalUnits(holdingOf(db, holdingId)) : 0;
      if (!holdingId || Math.abs(row.units) > held) {
        throw new Refusal(
          `The statement sells ${formatGrams(Math.abs(row.units))} of gold on ${row.date}, but only ` +
          `${formatGrams(held)} are recorded here. Record the earlier purchases first.`,
        );
      }
      recordSale(db, actor, {
        holdingId, units: Math.abs(row.units), price: price!, date: row.date,
        charges, toAccountId: null, sourceRef: ref,
      });
      result.sales++;
    }

    const period = plan.statements.length === 1 && plan.statements[0]!.period
      ? ` for ${plan.statements[0]!.period.from} to ${plan.statements[0]!.period.to}` : "";
    appendEvent(db, actor, {
      entity: "holding", entityId: holdingId!, action: "safegold-import",
      before: { lots: before },
      after: {
        accountId, instrumentId, refs: fresh.map((r) => r.ref), createdHolding: !existing,
        lots: result.lots, sales: result.sales,
      },
      summary:
        `Imported a SafeGold statement${period}: ${result.lots} ${result.lots === 1 ? "purchase" : "purchases"}` +
        (result.sales > 0 ? `, ${result.sales} ${result.sales === 1 ? "sale" : "sales"}` : "") +
        `, ${formatPaise(invested as Paise)} invested`,
    });
    return result;
  });
}

// ---------------------------------------------------------------------------
// Holding a plan between the review screen and the confirmation
// ---------------------------------------------------------------------------

/** In memory, never on disk, for half an hour — as a CAS plan is, and for the same reasons. */
const PLAN_TTL_MS = 30 * 60 * 1000;
const stash = new Map<string, { plan: SafeGoldPlan; memberId: string | null; at: number }>();

export function stashSafeGoldPlan(token: string, plan: SafeGoldPlan, memberId: string | null): void {
  const now = Date.now();
  for (const [key, entry] of stash) if (now - entry.at > PLAN_TTL_MS) stash.delete(key);
  stash.set(token, { plan, memberId, at: now });
}

/** The stashed plan, left in place: the review page reads it, the confirmation takes it. */
export function peekSafeGoldPlan(token: string, memberId: string | null): SafeGoldPlan | null {
  const entry = stash.get(token);
  if (!entry || entry.memberId !== memberId || Date.now() - entry.at > PLAN_TTL_MS) return null;
  return entry.plan;
}

export function takeSafeGoldPlan(token: string, memberId: string | null): SafeGoldPlan | null {
  const plan = peekSafeGoldPlan(token, memberId);
  if (plan) stash.delete(token);
  return plan;
}
