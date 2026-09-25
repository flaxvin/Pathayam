/**
 * F15 / 15 · The export a member downloads, which is not the operator's backup.
 *
 * There are two ways the household's data leaves the database, and they had
 * been one function:
 *
 * - **The operator's backup** (`createBackup`, `exportEverything`,
 *   `writeExport`, `restore.ts`) — the whole household, every member's private
 *   budget included, because a backup that silently left out somebody's
 *   accounts would restore a household missing its money. It runs on the
 *   server, from the scheduled job or the command line, and never through a
 *   member's browser.
 * - **A member's export** (`/export.json`, `/export.csv`) — what one signed-in
 *   person can carry off. It called `exportEverything(db)` too, so Priya's
 *   download held Ravi's private ₹3,00,000 savings account, his personal
 *   budget's envelopes, all four of his therapy-clinic payments, his private
 *   subscription, goal and demat — and control totals over the whole household,
 *   so even with the rows removed his balance fell out by subtraction.
 *
 * This is the second, and only the second: the same file shape, filtered to
 * what the member could read on screen, with control totals recomputed over
 * what is actually in the file. The backup is untouched.
 */

import type { DB } from "../db/db.ts";
import { exportEverything, exportTransactionsCsv } from "./backup.ts";
import { memberScope, type MemberScope } from "../domain/member-scope.ts";
import { eventVisibility } from "../domain/event-visibility.ts";
import { visiblePayeeIds } from "../domain/transactions.ts";
import { getEvent } from "../core/events.ts";

type Row = Record<string, unknown>;

/*
 * References that are incidental to a row the member may otherwise see. A
 * household loan repaid from a private account is still the household's loan,
 * and a household payee whose default account is somebody's private one is
 * still the household's DMart — so the reference is blanked rather than the
 * row dropped. Every other reference to something hidden drops the row.
 */
const REDACT: Record<string, string[]> = {
  payees: ["default_account_id"],
  loans: ["repayment_account_id"],
  loan_disbursements: ["destination_account_id"],
  even_calls: ["giving_category_id", "giving_budget_id"],
  categories: ["commits_to_budget_id"],
  reconciliations: ["adjustment_transaction_id"],
};

/** Rows that belong to one member, whatever they reference. */
const PER_MEMBER: Record<string, string> = {
  tax_declarations: "member_id",
  digest_mutes: "member_id",
  review_dismissals: "member_id",
};

export function exportForMember(db: DB, memberId: string): Record<string, unknown> {
  const full = exportEverything(db) as Record<string, unknown> & { data: Record<string, Row[]> };
  const scope = memberScope(db, memberId);
  const canSeeEvent = eventVisibility(db, memberId);
  const payees = visiblePayeeIds(db, memberId);

  const data: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(full.data)) {
    data[table] = rows.filter((row) => keep(db, table, row, scope, memberId, payees, canSeeEvent))
      .map((row) => redact(table, row, scope));
  }

  return {
    ...full,
    scope: {
      member: memberId,
      note:
        "One member's export: the household's shared budget and this member's own. " +
        "Other members' private accounts and budgets are not in it, and the control " +
        "totals are over what is in this file. The operator's backup is the complete copy.",
    },
    controlTotals: totalsOf(data),
    data,
  };
}

function keep(
  db: DB, table: string, row: Row, scope: MemberScope, memberId: string,
  payees: Set<string>, canSeeEvent: (e: NonNullable<ReturnType<typeof getEvent>>) => boolean,
): boolean {
  const owner = PER_MEMBER[table];
  if (owner) return row[owner] === null || row[owner] === memberId;
  if (table === "settings_kv" && typeof row.key === "string" && row.key.startsWith("budget.last.")) {
    return row.key === `budget.last.${memberId}`;
  }
  if (table === "events") {
    const event = getEvent(db, String(row.id));
    return event !== null && canSeeEvent(event);
  }
  if (table === "payees") {
    // A merged-away name travels with the payee it was merged into.
    if (!payees.has(String(row.merged_into_id ?? row.id))) return false;
  }
  if (table === "payee_aliases" && !payees.has(String(row.payee_id))) return false;

  const blanked = new Set(REDACT[table] ?? []);
  for (const [column, value] of Object.entries(row)) {
    if (blanked.has(column)) continue;
    if (column.endsWith("_json") && typeof value === "string") {
      try {
        if (scope.mentionsHidden(JSON.parse(value))) return false;
      } catch { /* not JSON after all; judged as a plain string below */ }
    }
    if (typeof value === "string" && scope.hides(value)) return false;
  }
  return true;
}

function redact(table: string, row: Row, scope: MemberScope): Row {
  const columns = REDACT[table];
  if (!columns) return row;
  const out = { ...row };
  for (const column of columns) {
    if (typeof out[column] === "string" && scope.hides(out[column] as string)) out[column] = null;
  }
  return out;
}

/** The same totals `controlTotals` reports, over the rows in this file only. */
function totalsOf(data: Record<string, Row[]>): Record<string, unknown> {
  const sum = (table: string, column: string): number =>
    (data[table] ?? []).reduce((n, r) => n + (typeof r[column] === "number" ? r[column] as number : 0), 0);
  const counts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(data)) counts[table] = rows.length;
  const events = data.events ?? [];
  return {
    counts,
    transactionTotal: sum("transactions", "amount"),
    assignmentTotal: sum("assignments", "amount"),
    splitTotal: sum("transaction_splits", "amount"),
    accountOpeningTotal: sum("accounts", "opening_balance"),
    lotUnitsTotal: sum("lots", "units"),
    lotCostTotal: sum("lots", "cost"),
    loanDisbursedTotal: sum("loan_disbursements", "amount"),
    netWorthSnapshotTotal: sum("net_worth_snapshots", "net_worth"),
    attachmentBytesTotal: sum("attachments", "size"),
    eventCount: events.length,
    maxEventSeq: events.reduce((n, e) => Math.max(n, Number(e.seq ?? 0)), 0),
  };
}

/** F15.3 · The transactions CSV, holding only what the member can see. */
export function exportTransactionsCsvForMember(db: DB, memberId: string): string {
  const hidden = memberScope(db, memberId).transactions;
  return exportTransactionsCsv(db, (id) => !hidden.has(id));
}
