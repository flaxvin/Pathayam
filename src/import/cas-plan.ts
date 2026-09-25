/**
 * `09` §6.2 · Reconciling a CAS against what is already held.
 *
 * The statement is cumulative. A CAS covering April–July restates every
 * transaction the June one already reported, so the naive import — create a
 * lot per row — doubles the portfolio on the second month. That is the failure
 * mode this file exists to prevent, and it is the same instinct as `04` §4:
 * duplicates destroy trust faster than anything else.
 *
 * A row is matched by a **recorded reference** derived from the row's own
 * content, not by comparing it against the current state of the holding. That
 * distinction is the whole design: R25.4 splits a lot on a partial sale, so
 * last month's 500-unit purchase is a 400-unit residual by the time the next
 * statement arrives. Matching on date and units would call that row new and
 * duplicate it. The reference excludes the NAV, because registrars restate a
 * price to more decimals often enough that matching on it would duplicate over
 * a hundredth of a rupee.
 *
 * Nothing here writes. `planCasImport` returns what *would* happen, and
 * `applyCasPlan` performs only what a human has confirmed (`04` I2).
 */

import type { DB } from "../db/db.ts";
import { transact, queryAll } from "../db/db.ts";
import { createHash } from "node:crypto";
import { appendEvent, type Actor } from "../core/events.ts";
import type { IsoDate } from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import {
  findOrCreateInstrument, recordPurchase, recordSale, recordDividend,
  listAssetAccounts, listHoldings, getInstrument, listInstruments,
} from "../domain/assets.ts";
import type { CasRow, CasScheme, CasStatement } from "./cas.ts";
import { unitsDisagreement } from "./cas.ts";

/**
 * A row's identity, from the row's own content.
 *
 * The scheme identifier is part of it so the same SIP amount on the same date
 * in two different funds does not collide. `occurrence` distinguishes two
 * genuinely identical instalments in one statement, which do happen and must
 * both survive.
 */
function rowRef(scheme: CasScheme, row: CasRow, occurrence: number): string {
  const digest = createHash("sha256")
    .update(`${scheme.isin ?? scheme.name}|${row.date}|${row.kind}|${row.units}|${row.amount}`)
    .digest("hex")
    .slice(0, 16);
  return `cas:${digest}:${occurrence}`;
}

/** Every CAS reference already recorded against a holding. */
function recordedRefs(db: DB, holdingId: string): Set<string> {
  const refs = queryAll<{ source_ref: string }>(
    db,
    `SELECT source_ref FROM lots WHERE holding_id = ? AND source_ref IS NOT NULL
     UNION ALL
     SELECT source_ref FROM holding_events WHERE holding_id = ? AND source_ref IS NOT NULL`,
    holdingId, holdingId,
  );
  return new Set(refs.map((r) => r.source_ref));
}

export type RowStatus =
  /** Not in the ledger: this is what the import will add. */
  | "new"
  /** Already recorded by an earlier statement, matched on its recorded ref. */
  | "already-held"
  /** Recognised but not something this import creates — see `note`. */
  | "skipped";

export interface PlannedRow {
  row: CasRow;
  status: RowStatus;
  note: string | null;
  /** Written alongside the lot or event, so the next statement recognises it. */
  ref: string;
}

export interface PlannedScheme {
  scheme: CasScheme;
  /** The asset account it will land in, and whether that account is new. */
  accountId: string | null;
  instrumentId: string | null;
  instrumentName: string;
  /** True when nothing in the household matches this ISIN yet. */
  newInstrument: boolean;
  rows: PlannedRow[];
  /** R24.3 · the statement's own closing balance versus the sum of its rows. */
  unitsDisagreement: number | null;
  /** What this scheme contributes if confirmed. */
  newLots: number;
  invested: Paise;
}

export interface CasPlan {
  period: CasStatement["period"];
  schemes: PlannedScheme[];
  unparsed: string[];
  totals: { newLots: number; alreadyHeld: number; invested: Paise };
}

/**
 * Work out what importing this statement would do, against the current ledger.
 *
 * `accountId` is where new holdings land. Existing holdings stay in whichever
 * account already has them, so a household that split its funds across two
 * demat accounts does not get them silently merged.
 */
export function planCasImport(
  db: DB, statement: CasStatement, accountId: string | null,
): CasPlan {
  const instruments = listInstruments(db);
  const schemes: PlannedScheme[] = [];
  let totalNew = 0;
  let totalHeld = 0;
  let invested = 0;

  for (const scheme of statement.schemes) {
    // R24.6: ISIN first. It is the one identifier that survives a change of
    // price provider, a renamed plan, or a merged scheme.
    const instrument =
      (scheme.isin ? instruments.find((i) => i.isin === scheme.isin) : undefined) ??
      instruments.find((i) => i.name.toLowerCase() === scheme.name.toLowerCase());

    const holding = instrument
      ? listHoldings(db).find((h) => h.instrument_id === instrument.id)
      : undefined;

    const known = holding ? recordedRefs(db, holding.id) : new Set<string>();
    const seen = new Map<string, number>();

    const rows: PlannedRow[] = [];
    let schemeNew = 0;
    let schemeInvested = 0;

    for (const row of scheme.rows) {
      const base = rowRef(scheme, row, 0);
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      const ref = rowRef(scheme, row, occurrence);

      if (row.kind === "other") {
        rows.push({
          row, ref, status: "skipped",
          note: "Not a purchase, sale or payout — confirm it by hand if it matters.",
        });
        continue;
      }

      if (known.has(ref)) {
        rows.push({
          row, ref, status: "already-held",
          note: "An earlier statement already recorded this.",
        });
        totalHeld++;
        continue;
      }

      rows.push({ row, ref, status: "new", note: null });
      schemeNew++;
      if (row.kind === "purchase") schemeInvested += Math.abs(row.amount);
    }

    schemes.push({
      scheme,
      accountId: holding?.account_id ?? accountId,
      instrumentId: instrument?.id ?? null,
      instrumentName: instrument?.name ?? scheme.name,
      newInstrument: !instrument,
      rows,
      unitsDisagreement: unitsDisagreement(scheme),
      newLots: schemeNew,
      invested: schemeInvested as Paise,
    });

    totalNew += schemeNew;
    invested += schemeInvested;
  }

  return {
    period: statement.period,
    schemes,
    unparsed: statement.unparsed,
    totals: { newLots: totalNew, alreadyHeld: totalHeld, invested: invested as Paise },
  };
}

export interface CasApplyResult {
  lots: number;
  sales: number;
  dividends: number;
  instruments: number;
}

/**
 * Apply a plan the household has confirmed.
 *
 * Only rows marked `new` are written, and only for schemes the caller passed
 * in `schemeIndexes` — so a statement covering four funds can be imported for
 * three of them, which matters when one has a disagreement worth resolving
 * first.
 *
 * The whole statement is one event batch, so it undoes as one action.
 */
export function applyCasPlan(
  db: DB, actor: Actor, plan: CasPlan, schemeIndexes: number[],
): CasApplyResult {
  return transact(db, () => {
    const result: CasApplyResult = { lots: 0, sales: 0, dividends: 0, instruments: 0 };

    for (const index of schemeIndexes) {
      const planned = plan.schemes[index];
      if (!planned || !planned.accountId) continue;

      let instrumentId = planned.instrumentId;
      if (!instrumentId) {
        const created = findOrCreateInstrument(db, actor, {
          name: planned.scheme.name,
          kind: "mutual-fund",
          isin: planned.scheme.isin,
          // R26.6 / §6.2: MFAPI is keyed by scheme code, which the CAS does not
          // carry. The instrument starts on manual pricing and the household
          // links it to a provider when they want live NAVs.
          provider: "manual",
        });
        instrumentId = created.id;
        result.instruments++;
      }

      // Oldest first, so FIFO lots exist before any sale consumes them.
      const rows = planned.rows
        .filter((r) => r.status === "new")
        .sort((a, b) => a.row.date.localeCompare(b.row.date));

      for (const { row, ref } of rows) {
        if (row.kind === "purchase") {
          recordPurchase(db, actor, {
            accountId: planned.accountId,
            instrumentId,
            tradeDate: row.date,
            price: row.nav,
            units: row.units,
            // FW4's budget transfer is deliberately not created here: the
            // money left a bank account months ago and is already in the
            // ledger from the statement import. Creating it again would
            // double-count the spending.
            fromAccountId: null,
            sourceRef: ref,
          });
          result.lots++;
          continue;
        }

        const holding = listHoldings(db, planned.accountId)
          .find((h) => h.instrument_id === instrumentId);
        if (!holding) continue;

        if (row.kind === "redemption") {
          recordSale(db, actor, {
            holdingId: holding.id,
            units: Math.abs(row.units),
            price: row.nav,
            date: row.date,
            toAccountId: null,
            sourceRef: ref,
          });
          result.sales++;
        } else if (row.kind === "dividend") {
          // R27.5: payouts are tracked separately and never fold into cost.
          recordDividend(db, actor, {
            holdingId: holding.id,
            amount: Math.abs(row.amount) as Paise,
            date: row.date,
            toAccountId: null,
            sourceRef: ref,
          });
          result.dividends++;
        }
      }
    }

    appendEvent(db, actor, {
      entity: "cas-import", entityId: `${plan.period?.from ?? "?"}:${plan.period?.to ?? "?"}`,
      action: "import",
      after: result,
      summary:
        `Imported a CAS: ${result.lots} ${result.lots === 1 ? "lot" : "lots"}` +
        (result.sales > 0
          ? `, ${result.sales} ${result.sales === 1 ? "redemption" : "redemptions"}` : "") +
        (result.dividends > 0
          ? `, ${result.dividends} ${result.dividends === 1 ? "payout" : "payouts"}` : "") +
        (result.instruments > 0
          ? `, ${result.instruments} new ${result.instruments === 1 ? "scheme" : "schemes"}` : "") +
        `, ${formatPaise(plan.totals.invested)} invested`,
    });

    return result;
  });
}

/**
 * Asset accounts a CAS can land in, for the import form.
 *
 * Only the two subtypes that hold units: a fixed deposit or a flat cannot
 * receive a mutual-fund lot, and offering them invites a mistake that R30
 * would not catch because it is a perfectly valid write.
 */
export function casDestinations(
  db: DB,
  /**
   * 15 · Who is importing. The picker listed every demat in the household, so
   * Priya's CAS form offered Ravi's private "Quokka Private Demat" by name —
   * an account she cannot open, offered as a place to put her statement.
   */
  viewerMemberId: string | null,
): { id: string; name: string }[] {
  return listAssetAccounts(db, { viewerMemberId })
    .filter((a) => a.subtype === "investment" || a.subtype === "retirement")
    .map((a) => ({ id: a.id, name: a.name }));
}

// ---------------------------------------------------------------------------
// Holding a plan between the review screen and the confirmation
// ---------------------------------------------------------------------------

/**
 * The review screen renders a plan; the next request confirms it. Something
 * has to hold it in between.
 *
 * It is kept in memory, never on disk, and expires. That is not laziness: the
 * plan is derived from a password-protected statement, and R35 keeps household
 * data on the server, so the one place it must not go is a hidden form field
 * round-tripping through the browser. Re-asking for the file and the password
 * would be the alternative, and it would teach the household to retype a
 * password they should type once.
 */
const PLAN_TTL_MS = 30 * 60 * 1000;
const stash = new Map<string, { plan: CasPlan; memberId: string | null; at: number }>();

export function stashPlan(token: string, plan: CasPlan, memberId: string | null): void {
  const now = Date.now();
  for (const [key, entry] of stash) {
    if (now - entry.at > PLAN_TTL_MS) stash.delete(key);
  }
  stash.set(token, { plan, memberId, at: now });
}

/** Read a stashed plan once. Wrong member, expired, or already used: null. */
export function takePlan(token: string, memberId: string | null): CasPlan | null {
  const entry = stash.get(token);
  if (!entry) return null;
  stash.delete(token);
  if (entry.memberId !== memberId) return null;
  if (Date.now() - entry.at > PLAN_TTL_MS) return null;
  return entry.plan;
}

export type { CasRow, CasScheme };
