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
import { daysBetween, todayIST, type IsoDate } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";
import { ingest } from "../import/pipeline.ts";
import type { RawRecord } from "../import/csv.ts";
import { accountsByLast4For, cardsByLast4For } from "../domain/accounts.ts";
import { hiddenAccountSql } from "../domain/member-scope.ts";
import { ALERT_PROFILES, parseAlert, looksLikeUnreadAlert } from "../import/email-alerts.ts";
import {
  senderFor, parseStatementPdf, WrongPassword, STATEMENT_SENDERS, bankForInstitution, SAFEGOLD_DISTRIBUTOR_BALANCE,
} from "../import/pdf-statements.ts";
import { passwordCandidates, missingDetailFor, cardDigitsNeeded } from "../import/statement-passwords.ts";
import { cardNumberDigits } from "../domain/card-digits.ts";
import { getIdentity } from "../import/identity.ts";
import { getConnection, markFetched, type GmailConnection } from "./connection.ts";
import { refreshAccessToken } from "./oauth.ts";
import {
  listMessageIds, getMessage, getAttachment, header, plainTextBody, pdfAttachments,
  type GmailClientOptions,
} from "./client.ts";
import { Refusal } from "../core/refusal.ts";
import { newId } from "../db/db.ts";
import { isSafeGoldText, parseSafeGoldText, type SafeGoldStatement } from "../import/safegold.ts";
import { planSafeGoldImport, stashSafeGoldPlan } from "../import/safegold-plan.ts";

export interface FetchResult {
  scanned: number;
  /** `unread`: from an alert sender, read like a transaction, but no profile could read it. */
  alerts: { parsed: number; staged: number; unmatched: number; unread: number };
  statements: { read: number; staged: number; locked: number; unmatched: number };
  /**
   * IMPORT-15 · Of the locked statements, the detail each bank's rule needs and
   * the app does not have, one sentence per kind ("…the card's last four…").
   * Names the field, never a value.
   */
  missingDetails: string[];
  /**
   * IMP-20 · The card accounts whose statement stayed locked for want of the
   * card's digits, and how many the bank's rule needs: what the fetch notice
   * offers a form for. Names and ids only, never a digit.
   */
  cardDigitsNeeded: { accountId: string; name: string; digits: 4 | 6 }[];
  /** Of the staged rows, those a rule approved straight into the ledger, so not in Review. */
  autoApproved: number;
  /**
   * IMP-33 · SafeGold statements read, as one plan awaiting confirmation:
   * `token` opens its review (`/portfolio/safegold/review`) for half an hour.
   */
  gold: { statements: number; newEntries: number; token: string | null };
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
  // Statement senders — from the sender map itself, so every sender it
  // recognises is one the fetch asks for. A hand-kept copy here had drifted.
  for (const s of STATEMENT_SENDERS) for (const a of s.query) senders.add(a);
  // Alert senders come from the profiles themselves, kept in one place.
  // Spelled out per profile: a pattern covering an old and a new domain has
  // no single address to strip it down to.
  for (const p of ALERT_PROFILES) for (const a of p.query) senders.add(a);

  const from = [...senders].map((s) => (s.startsWith("@") ? s.slice(1) : s)).join(" OR ");
  return `from:(${from}) newer_than:${sinceDays}d`;
}

/** The most messages one fetch reads. */
const MESSAGE_CAP = 200;

/**
 * Fetch and ingest. Returns a summary; every transaction lands in Review.
 */
export async function fetchGmail(
  db: DB, actor: Actor, deps: FetchDeps,
): Promise<FetchResult> {
  const memberId = actor.memberId;
  if (!memberId) throw new Error("Fetching needs a member.");

  const connection = getConnection(db, memberId);
  if (!connection) throw new Refusal("Gmail is not connected.");

  const { accessToken } = await refreshAccessToken({
    clientId: deps.clientId,
    clientSecret: deps.clientSecret,
    refreshToken: connection.refresh_token,
    fetchImpl: deps.fetchImpl,
  });

  const client: GmailClientOptions = { accessToken, fetchImpl: deps.fetchImpl };
  const result: FetchResult = {
    scanned: 0,
    alerts: { parsed: 0, staged: 0, unmatched: 0, unread: 0 },
    statements: { read: 0, staged: 0, locked: 0, unmatched: 0 },
    missingDetails: [],
    cardDigitsNeeded: [],
    autoApproved: 0,
    gold: { statements: 0, newEntries: 0, token: null },
    notes: [],
  };
  const gold: SafeGoldStatement[] = [];

  // A first fetch reaches back 90 days; later fetches only need a short window,
  // but the content-hash dedupe makes a wider window harmless.
  //
  // The short window still has to reach the last fetch. A fixed 14 days meant
  // a fetch 40 days after the previous one never read the 26 days between,
  // and no later fetch would either.
  const today = todayIST(deps.now);
  const sinceDays = connection.last_fetched_at
    ? Math.max(14, daysBetween(connection.last_fetched_at.slice(0, 10), today) + 2)
    : 90;
  // One more than is read, to know whether the cap cut anything. Gmail lists
  // newest first, so what a cap drops is the oldest of the window — and the
  // next fetch's window starts after it. Said, not swallowed (IL3).
  const listed = await listMessageIds(buildQuery(sinceDays), client, MESSAGE_CAP + 1);
  const ids = listed.slice(0, MESSAGE_CAP);
  if (listed.length > MESSAGE_CAP) {
    result.notes.push(
      `More than ${MESSAGE_CAP} bank emails arrived in the last ${sinceDays} days; only the newest ` +
      `${MESSAGE_CAP} were read. Upload the statement for the earlier part of that period so nothing is missed`,
    );
  }

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
      await handleStatement(db, actor, deps, client, memberId, id, pdfs, statementSender, result, gold);
      continue;
    }

    // Otherwise, a transaction alert.
    const body = plainTextBody(message);
    const parsed = parseAlert(sender, subject, body, received);
    if (!parsed) {
      // Not every message from a bank is a transaction, but one that reads
      // like one and could not be read is said, not silently dropped.
      if (looksLikeUnreadAlert(sender, body)) {
        result.alerts.unread++;
        result.notes.push(
          `An alert from ${sender}${received ? ` on ${received}` : ""} could not be read, ` +
          "so nothing was imported from it — add that transaction by hand",
        );
      }
      continue;
    }
    result.alerts.parsed++;

    const routed = routeAlert(db, memberId, parsed.record);
    if (!routed) { result.alerts.unmatched++; result.notes.push(`No account matches ${sender}`); continue; }
    if ("ambiguous" in routed) {
      result.alerts.unmatched++;
      result.notes.push(`More than one of your accounts ends in ${routed.ambiguous}; left an alert from ${sender} alone`);
      continue;
    }

    const bucket = alertRecords.get(routed.accountId) ?? { records: [], adapter: `email:${parsed.bank}` };
    bucket.records.push(routed.record);
    alertRecords.set(routed.accountId, bucket);
  }

  for (const [accountId, bucket] of alertRecords) {
    const outcome = ingest(db, actor, {
      accountId, source: "email", adapter: bucket.adapter, records: bucket.records,
    });
    result.alerts.staged += outcome.staged;
    result.autoApproved += outcome.autoApproved;
  }

  /*
   * IMP-33 · Gold is proposed, never written by a fetch (`04` I2): the
   * statements become one plan — a few months of them, or one mailed twice,
   * matched row by row — that the person confirms on its review.
   */
  if (gold.length > 0) {
    const plan = planSafeGoldImport(db, gold, memberId);
    const token = newId();
    stashSafeGoldPlan(token, plan, memberId);
    result.gold = { statements: gold.length, newEntries: plan.totals.newEntries, token };
  }

  markFetched(db, memberId, latestHistoryId(connection));
  return result;
}

// ---------------------------------------------------------------------------
// Routing a parsed alert to an account
// ---------------------------------------------------------------------------

function routeAlert(
  db: DB, memberId: string, record: import("../import/email-alerts.ts").AlertRecord,
): { accountId: string; record: RawRecord } | { ambiguous: string } | null {
  // A card last-four resolves to the card and its Credit account; an account
  // last-four to the account. R6.e: the add-on holder is carried through as the
  // proposed owner, defaulted from the greeting.
  //
  // Only among what the fetching member may see: the alert came from their
  // mailbox. Of those, the ones they hold come first, and when that still
  // leaves two the alert is left alone with a note rather than guessed.
  let accountId: string | null = null;
  let cardId: string | null = null;

  if (record.cardLast4) {
    const card = onlyOne(cardsByLast4For(db, record.cardLast4, memberId),
      (c) => (c.holder_member_id ?? c.account_holder) === memberId);
    if (card === AMBIGUOUS) return { ambiguous: record.cardLast4 };
    if (card) { accountId = card.account_id; cardId = card.id; }
  }
  if (!accountId && record.accountLast4) {
    const account = onlyOne(accountsByLast4For(db, record.accountLast4, memberId),
      (a) => a.holder_member_id === memberId);
    if (account === AMBIGUOUS) return { ambiguous: record.accountLast4 };
    if (account) accountId = account.id;
  }
  if (!accountId) return null;

  const raw: RawRecord = {
    rowNumber: 0,
    date: record.date,
    amount: record.amount,
    narration: record.narration,
    reference: record.reference,
    // P4 / I1: raw is what the alert said, verbatim. It used to be the ISO
    // date and the computed signed rupees ("-600" for "INR 600.00"), and the
    // narration carried a "[card of …]" tag the bank never wrote. The card is
    // now carried as cardId, so the tag has nothing left to do.
    raw: {
      date: record.when,
      amount: record.rawAmount,
      narration: record.narration,
    },
    // R6.e · The card the alert named. It was resolved here and then dropped
    // (`void cardId`), so ingest looked for a last four in the merchant name,
    // found none, and every add-on alert posted on the primary card — owned
    // by the primary holder rather than the add-on's.
    cardId,
  };
  return { accountId, record: raw };
}

const AMBIGUOUS = Symbol("ambiguous");

/** The one row, preferring those `held` picks; AMBIGUOUS when that still leaves more than one. */
function onlyOne<T>(rows: T[], held: (row: T) => boolean): T | typeof AMBIGUOUS | null {
  const mine = rows.filter(held);
  const pool = mine.length > 0 ? mine : rows;
  if (pool.length > 1) return AMBIGUOUS;
  return pool[0] ?? null;
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
  gold: SafeGoldStatement[],
): Promise<void> {
  const identity = getIdentity(db, memberId);

  for (const pdf of pdfs) {
    const bytes = await getAttachment(messageId, pdf.attachmentId, client);
    if (bytes.length === 0) continue;

    // A statement account cannot be known without a last-four to match; a CAS
    // is handled by the portfolio importer, not here. So this path covers the
    // bank statements whose destination account the app can resolve.
    //
    // D9a · SBI Card, Canara and HSBC lock statements with the card's digits.
    // The upload path hands passwordCandidates the account's last four; this
    // path handed it nothing, so the same file that opened when uploaded was
    // "could not open" when mailed. The digits are only ever candidates tried
    // in memory, never logged or stored.
    const cardDigits = statementCardDigits(db, memberId, statementSender);
    const candidates = identity
      ? passwordCandidates(identity, statementSender.bank, { cardDigits })
      : [""];
    let parsed;
    // Any other failure — a certificate-protected or damaged file — is this
    // attachment's alone. Thrown, it lost every alert read so far and left the
    // fetch unmarked, so the same file failed every fetch in its window.
    let unreadable: string | null = null;
    for (const candidate of candidates) {
      try { parsed = parseStatementPdf(bytes, candidate); break; }
      catch (e) {
        if (e instanceof WrongPassword) continue;
        unreadable = (e as Error).message;
        break;
      }
    }
    if (!parsed) {
      result.statements.locked++;
      result.notes.push(`Could not open ${pdf.filename}${unreadable ? `: ${unreadable}` : ""}`);
      // IMPORT-15 · As the upload says it: when the bank's rule needs a digit
      // the app does not have (SBI Card's or Canara's last four, HSBC's last
      // six), name that field rather than leave "could not open" a dead end.
      const missing = !unreadable && identity
        ? missingDetailFor(statementSender.bank, identity, cardDigits)
        : null;
      if (missing && !result.missingDetails.includes(missing)) result.missingDetails.push(missing);
      if (!unreadable && identity) {
        for (const card of cardsLackingDigits(db, memberId, statementSender, identity, cardDigits)) {
          if (!result.cardDigitsNeeded.some((c) => c.accountId === card.accountId)) {
            result.cardDigitsNeeded.push(card);
          }
        }
      }
      continue;
    }
    result.statements.read++;

    // IMP-33 · Digital gold has no bank account to land in; it is a holding.
    if (isSafeGoldText(parsed.text)) { gold.push(parseSafeGoldText(parsed.text)); continue; }
    // IMP-35 · Gold held through a partner bank's app: a balance, no rows, no account.
    if (parsed.notAStatement === SAFEGOLD_DISTRIBUTOR_BALANCE) {
      result.notes.push(`${pdf.filename}: ${SAFEGOLD_DISTRIBUTOR_BALANCE}, with no transactions — nothing to import`);
      continue;
    }

    // Resolve the account from the statement's own header — the parser does not
    // expose an account number, so fall back to the single account for that
    // bank if there is exactly one. Left to Review otherwise.
    const accountId = resolveStatementAccount(db, memberId, statementSender);
    if (!accountId) { result.statements.unmatched++; result.notes.push(`${pdf.filename}: no matching account`); continue; }

    const outcome = ingest(db, actor, {
      accountId, source: "pdf", adapter: parsed.bank?.id ?? "pdf",
      fileName: pdf.filename, records: parsed.records, errors: parsed.errors,
      rowsRead: parsed.rowsRead,
    });
    result.statements.staged += outcome.staged;
    result.autoApproved += outcome.autoApproved;
  }
}

type StatementSenderRef = { bank: import("../import/pdf-statements.ts").BankId | null; what: string };

/**
 * IMP-20 · The card accounts a locked statement could be for, when the card's
 * digits are what its bank's rule needs: the open credit accounts at that bank
 * the fetching member can see, each still short of that many digits. An
 * account statement (SBI's wants the mobile) asks for none.
 */
function cardsLackingDigits(
  db: DB, memberId: string, sender: StatementSenderRef,
  identity: import("../import/statement-passwords.ts").StatementIdentity, cardDigits: string[],
): { accountId: string; name: string; digits: 4 | 6 }[] {
  const needed = cardDigitsNeeded(sender.bank, identity, cardDigits);
  if (!needed || statementKind(sender.what) === "bank") return [];
  const cards = accountsAtBank(db, memberId, sender.bank).filter((a) => a.kind === "credit");
  return cards
    .filter((a) => (cardNumberDigits(db, a.id) ?? "").length < needed)
    .map((a) => ({ accountId: a.id, name: a.name, digits: needed }));
}

function resolveStatementAccount(db: DB, memberId: string, sender: StatementSenderRef): string | null {
  const rows = statementAccounts(db, memberId, sender);
  return rows.length === 1 ? rows[0]!.id : null;
}

/**
 * IMP-9 · Which kind of account a sender's statement is for, from its entry's
 * `what`: a card statement goes to a credit account, an account statement to
 * a bank account. Null when the entry does not say ("Axis statement").
 */
function statementKind(what: string): "credit" | "bank" | null {
  if (/\bcard\b/i.test(what)) return "credit";
  if (/\baccount statement\b/i.test(what)) return "bank";
  return null;
}

/**
 * Open accounts at the sender's bank the fetching member can see.
 *
 * IMP-9 · A savings account and a card at the same bank were two candidates,
 * so neither got the statement. Where the sender says which kind it sends,
 * the accounts of that kind are preferred; when there are none of that kind,
 * every account at the bank stays a candidate, as before.
 */
function statementAccounts(db: DB, memberId: string, sender: StatementSenderRef): { id: string }[] {
  const atBank = accountsAtBank(db, memberId, sender.bank);
  const kind = statementKind(sender.what);
  if (!kind) return atBank.map((a) => ({ id: a.id }));
  const ofKind = atBank.filter((a) => (a.kind === "credit") === (kind === "credit"));
  return (ofKind.length > 0 ? ofKind : atBank).map((a) => ({ id: a.id }));
}

function accountsAtBank(
  db: DB, memberId: string, bank: import("../import/pdf-statements.ts").BankId | null,
): { id: string; kind: string; name: string }[] {
  if (!bank) return [];
  // Among the fetching member's own view, as for alerts: another member's
  // private account at the same bank is neither a candidate nor a rival.
  //
  // IMP-4 · The bank as the upload path recognises it — its name or its
  // signatures ("State Bank of India", "Standard Chartered") — or its id as a
  // word of its own ("SBI Card", "HDFC"). A substring match on the id missed
  // the first two and took "Scotiabank" for "sc".
  const hidden = hiddenAccountSql("a", memberId);
  const word = new RegExp(`\\b${bank}\\b`, "i");
  return (db.prepare(
    `SELECT a.id, a.kind, a.institution, COALESCE(a.nickname, a.name) AS name FROM accounts a
      WHERE a.closed_at IS NULL AND a.institution IS NOT NULL AND NOT ${hidden.sql}`,
  ).all(...hidden.params) as { id: string; kind: string; institution: string; name: string }[])
    .filter((a) => bankForInstitution(a.institution) === bank || word.test(a.institution))
    .map((a) => ({ id: a.id, kind: a.kind, name: a.name }));
}

/**
 * D9a · The card/account digits a mailed statement's password might use.
 *
 * The statement routes to the one account at its bank when there is exactly
 * one, so that account's last four and its cards' are the digits — what the
 * upload path uses, plus the add-on cards a household records on the card
 * rather than the account, and (IMP-18) the up-to-eight trailing digits a
 * card account may hold for HSBC's last six. When the route is unknown (no account at that
 * bank, or several), every visible account's and card's digits are offered:
 * trying a handful of extra candidates against a local file costs nothing,
 * and a statement that opens but has nowhere to go is then said as such
 * rather than as "could not open". Another member's private accounts are not
 * offered, as for routing.
 */
function statementCardDigits(
  db: DB, memberId: string, sender: StatementSenderRef,
): string[] {
  const atBank = statementAccounts(db, memberId, sender);
  const hidden = hiddenAccountSql("a", memberId);
  const scope = atBank.length === 1
    ? { sql: "a.id = ?", params: [atBank[0]!.id] as string[] }
    : { sql: "1 = 1", params: [] as string[] };
  const rows = db.prepare(
    `SELECT a.last4 AS digits FROM accounts a
      WHERE a.closed_at IS NULL AND a.last4 IS NOT NULL AND ${scope.sql} AND NOT ${hidden.sql}
     UNION
     SELECT c.last4 AS digits FROM cards c JOIN accounts a ON a.id = c.account_id
      WHERE c.closed_at IS NULL AND a.closed_at IS NULL AND c.last4 IS NOT NULL
        AND ${scope.sql} AND NOT ${hidden.sql}
     UNION
     SELECT d.digits AS digits FROM card_number_digits d JOIN accounts a ON a.id = d.account_id
      WHERE a.closed_at IS NULL AND substr(d.digits, -4) = a.last4
        AND ${scope.sql} AND NOT ${hidden.sql}`,
  ).all(
    ...scope.params, ...hidden.params, ...scope.params, ...hidden.params, ...scope.params, ...hidden.params,
  ) as { digits: string }[];
  return rows.map((r) => r.digits);
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
