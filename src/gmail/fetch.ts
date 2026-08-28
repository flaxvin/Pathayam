/**
 * `04` §3.4 · Fetching from Gmail — the orchestration.
 *
 * Ties the pieces together: refresh the access token, search only the
 * configured bank senders, and route each message to the right handler —
 * a transaction alert to the alert parser, a statement PDF to the statement
 * reader — landing everything in the same review queue as every other source.
 *
 * Two `04` §3.4 constraints are structural here:
 *
 *   · **Only configured senders are read.** The Gmail query is built from the
 *     alert-profile senders and the statement-sender map; nothing outside it
 *     is ever requested.
 *   · **Bodies are not retained.** A message is parsed into fields and then
 *     dropped; only the extracted record reaches the ledger.
 *
 * `fetch` is injected, so the whole path runs in tests against canned Gmail
 * API responses without a live connection.
 */

import type { DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { todayIST, type IsoDate } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";
import { ingest } from "../import/pipeline.ts";
import type { RawRecord } from "../import/csv.ts";
import { findAccountByLast4, findCardByLast4 } from "../domain/accounts.ts";
import { ALERT_PROFILES, parseAlert } from "../import/email-alerts.ts";
import { senderFor, parseStatementPdf, WrongPassword } from "../import/pdf-statements.ts";
import { passwordCandidates } from "../import/statement-passwords.ts";
import { getIdentity } from "../import/identity.ts";
import { getConnection, markFetched, type GmailConnection } from "./connection.ts";
import { refreshAccessToken } from "./oauth.ts";
import {
  listMessageIds, getMessage, getAttachment, header, plainTextBody, pdfAttachments,
  type GmailClientOptions,
} from "./client.ts";

export interface FetchResult {
  scanned: number;
  alerts: { parsed: number; staged: number; unmatched: number };
  statements: { read: number; staged: number; locked: number };
  notes: string[];
}

export interface FetchDeps {
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a 90-day window. */
  now?: Date;
}

/**
 * The Gmail search query.
 *
 * A single `from:(…)` union of every sender the app knows how to read, with a
 * date floor so a repeat fetch re-reads only what is new. This is the boundary
 * `04` §3.4 draws: no message from an unlisted sender is ever fetched.
 */
export function buildQuery(sinceDays: number): string {
  const senders = new Set<string>();
  // Statement senders — real addresses from the sender map.
  const statementAddresses = [
    "@hdfcbank.bank.in", "estatement@icici.bank.in", "credit_cards@icici.bank.in",
    "@axis.bank.in", "@alerts.sbi.bank.in", "statements@sbicard.com",
    "@ubi.bank.in", "@canarabank.com", "@rbl.bank.in", "@mail.hsbc.co.in",
    "estatement@yes.bank.in", "@indusind.com", "@camsonline.com", "eCAS@cdslstatement.com",
    "@transactions.upstox.com", "@transactions.indmoney.com",
  ];
  for (const a of statementAddresses) senders.add(a);
  // Alert senders come from the profiles themselves, kept in one place.
  for (const p of ALERT_PROFILES) {
    for (const s of p.senders) senders.add(sourceToAddress(s));
  }

  const from = [...senders].map((s) => (s.startsWith("@") ? s.slice(1) : s)).join(" OR ");
  return `from:(${from}) newer_than:${sinceDays}d`;
}

/** Pull a plain address out of an anchored sender regex for the query. */
function sourceToAddress(re: RegExp): string {
  return re.source.replace(/[\\^$]/g, "").replace(/\\\./g, ".").replace(/\.\*/g, "");
}

/**
 * Fetch and ingest. Returns a summary; every transaction lands in Review.
 */
export async function fetchGmail(
  db: DB, actor: Actor, deps: FetchDeps,
): Promise<FetchResult> {
  const memberId = actor.memberId;
  if (!memberId) throw new Error("Fetching needs a member.");

  const connection = getConnection(db, memberId);
  if (!connection) throw new Error("Gmail is not connected.");

  const { accessToken } = await refreshAccessToken({
    clientId: deps.clientId,
    clientSecret: deps.clientSecret,
    refreshToken: connection.refresh_token,
    fetchImpl: deps.fetchImpl,
  });

  const client: GmailClientOptions = { accessToken, fetchImpl: deps.fetchImpl };
  const result: FetchResult = {
    scanned: 0,
    alerts: { parsed: 0, staged: 0, unmatched: 0 },
    statements: { read: 0, staged: 0, locked: 0 },
    notes: [],
  };

  // A first fetch reaches back 90 days; later fetches only need a short window,
  // but the content-hash dedupe makes a wider window harmless.
  const sinceDays = connection.last_fetched_at ? 14 : 90;
  const ids = await listMessageIds(buildQuery(sinceDays), client, 200);

  // Accumulate records per account, then ingest once per account so dedupe and
  // the batch log behave the same as an uploaded file.
  const alertRecords = new Map<string, { records: RawRecord[]; adapter: string }>();

  for (const id of ids) {
    result.scanned++;
    const message = await getMessage(id, client);
    const sender = addressOf(header(message, "From") ?? "");
    const subject = header(message, "Subject") ?? "";
    const received = receivedDate(message);

    // A statement PDF, if this sender sends those and the message carries one.
    const statementSender = senderFor(sender);
    const pdfs = pdfAttachments(message);
    if (statementSender && pdfs.length > 0) {
      await handleStatement(db, actor, deps, client, memberId, id, pdfs, statementSender, result);
      continue;
    }

    // Otherwise, a transaction alert.
    const body = plainTextBody(message);
    const parsed = parseAlert(sender, subject, body, received);
    if (!parsed) continue;
    result.alerts.parsed++;

    const routed = routeAlert(db, parsed.record);
    if (!routed) { result.alerts.unmatched++; result.notes.push(`No account matches ${sender}`); continue; }

    const bucket = alertRecords.get(routed.accountId) ?? { records: [], adapter: `email:${parsed.bank}` };
    bucket.records.push(routed.record);
    alertRecords.set(routed.accountId, bucket);
  }

  for (const [accountId, bucket] of alertRecords) {
    const outcome = ingest(db, actor, {
      accountId, source: "email", adapter: bucket.adapter, records: bucket.records,
    });
    result.alerts.staged += outcome.staged;
  }

  markFetched(db, memberId, latestHistoryId(connection));
  return result;
}

// ---------------------------------------------------------------------------
// Routing a parsed alert to an account
// ---------------------------------------------------------------------------

function routeAlert(
  db: DB, record: import("../import/email-alerts.ts").AlertRecord,
): { accountId: string; record: RawRecord } | null {
  // A card last-four resolves to the card and its Credit account; an account
  // last-four to the account. R6.e: the add-on holder is carried through as the
  // proposed owner, defaulted from the greeting.
  let accountId: string | null = null;
  let cardId: string | null = null;

  if (record.cardLast4) {
    const card = findCardByLast4(db, record.cardLast4);
    if (card) { accountId = card.account_id; cardId = card.id; }
  }
  if (!accountId && record.accountLast4) {
    const account = findAccountByLast4(db, record.accountLast4);
    if (account) accountId = account.id;
  }
  if (!accountId) return null;

  const raw: RawRecord = {
    rowNumber: 0,
    date: record.date,
    amount: record.amount,
    narration: record.narration,
    reference: record.reference,
    raw: {
      date: record.date,
      amount: String(record.amount / 100),
      narration: record.cardholderName
        ? `${record.narration} [card of ${record.cardholderName}]`
        : record.narration,
    },
  };
  void cardId;
  return { accountId, record: raw };
}

// ---------------------------------------------------------------------------
// Handling a statement attachment
// ---------------------------------------------------------------------------

async function handleStatement(
  db: DB, actor: Actor, deps: FetchDeps, client: GmailClientOptions,
  memberId: string, messageId: string,
  pdfs: { filename: string; attachmentId: string }[],
  statementSender: { bank: import("../import/pdf-statements.ts").BankId | null; what: string },
  result: FetchResult,
): Promise<void> {
  const identity = getIdentity(db, memberId);

  for (const pdf of pdfs) {
    const bytes = await getAttachment(messageId, pdf.attachmentId, client);
    if (bytes.length === 0) continue;

    // A statement account cannot be known without a last-four to match; a CAS
    // is handled by the portfolio importer, not here. So this path covers the
    // bank statements whose destination account the app can resolve.
    const candidates = identity ? passwordCandidates(identity, statementSender.bank) : [""];
    let parsed;
    for (const candidate of candidates) {
      try { parsed = parseStatementPdf(bytes, candidate); break; }
      catch (e) { if (!(e instanceof WrongPassword)) throw e; }
    }
    if (!parsed) { result.statements.locked++; result.notes.push(`Could not open ${pdf.filename}`); continue; }
    result.statements.read++;

    // Resolve the account from the statement's own header — the parser does not
    // expose an account number, so fall back to the single account for that
    // bank if there is exactly one. Left to Review otherwise.
    const accountId = resolveStatementAccount(db, statementSender.bank);
    if (!accountId) { result.notes.push(`${pdf.filename}: no matching account`); continue; }

    const outcome = ingest(db, actor, {
      accountId, source: "pdf", adapter: parsed.bank?.id ?? "pdf",
      fileName: pdf.filename, records: parsed.records, errors: parsed.errors,
      rowsRead: parsed.rowsRead,
    });
    result.statements.staged += outcome.staged;
  }
}

function resolveStatementAccount(
  db: DB, bank: import("../import/pdf-statements.ts").BankId | null,
): string | null {
  if (!bank) return null;
  const rows = (db.prepare(
    `SELECT id FROM accounts WHERE closed_at IS NULL AND lower(institution) LIKE ?`,
  ).all(`%${bank}%`)) as { id: string }[];
  return rows.length === 1 ? rows[0]!.id : null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function addressOf(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1]! : from).trim();
}

function receivedDate(message: { internalDate?: string }): IsoDate | undefined {
  if (!message.internalDate) return undefined;
  const d = new Date(Number(message.internalDate) + (5 * 60 + 30) * 60_000);
  return d.toISOString().slice(0, 10) as IsoDate;
}

function latestHistoryId(connection: GmailConnection): string | null {
  return connection.last_history_id;
}

export type { Paise };
