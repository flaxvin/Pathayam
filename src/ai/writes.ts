/**
 * AIW · The changes an AI connection may make, and the suggestions it may leave.
 *
 * The household asked for an assistant that can do the filing, not only talk
 * about it. Three locks decide whether it may, all of which must be open:
 *
 *   1. the deployment allows it (`AI_WRITE`, src/config.ts) — off by default;
 *   2. the member ticked "allow changes" when connecting this app (a
 *      read-write AI token, src/auth/tokens.ts and src/auth/oauth.ts);
 *   3. the tool is one of the short list below.
 *
 * Two tiers. Filing, splitting and annotating a transaction, and proposing a
 * payee's usual envelope, are made directly in `standard` and `full`. Adding a
 * transaction, assigning money and recording a transfer move money the
 * household has not seen, so in `standard` they become suggestions waiting in
 * Review, and only `full` makes them directly. Nothing else is offered at all:
 * no delete, no loan, investment, month close, setting, member, token, import,
 * rule or schedule.
 *
 * Every change goes through the same domain function the page uses, after the
 * same visibility checks the route makes (requireVisibleCategory and friends in
 * app.ts): a member's AI can touch only what that member can see, and anything
 * else is "not found" exactly as it is to a person. Each event is attributed to
 * the member with source `ai`, names the connection, and carries one
 * idempotency key per connection per IST day, which is what "undo this AI's
 * changes today" reverses.
 */

import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { Missing, Refusal } from "../core/refusal.ts";
import { formatPaise, rupees, type Paise } from "../core/money.ts";
import {
  todayIST, nowIST, isMonthKey, monthOf, parseDate, formatDate, formatMonth, type IsoDate, type MonthKey,
} from "../core/dates.ts";
import type { Features } from "../features.ts";
import type { AiWriteMode } from "../config.ts";
import { listAccounts, DERIVED_VALUE_SUBTYPES, type Account } from "../domain/accounts.ts";
import { listCategories, getCategory, setAssigned } from "../domain/budget.ts";
import {
  getTransaction, updateTransaction, createTransaction, createTransfer, resolveCategoryLines,
  outgoingLacksEnvelope, listPayees, getPayee, DELETED_TRANSACTION, type Transaction,
} from "../domain/transactions.ts";
import { memberScope } from "../domain/member-scope.ts";
import { withForwardRecompute } from "../engine/recompute.ts";
import { proposePayeeDefault, proposeCategoryRules, learningEnabled } from "../import/learning.ts";

/** At most this many changes and suggestions per connection per IST day. */
export const AI_DAILY_WRITE_CAP = 100;
/** At most this many suggestions waiting in Review per connection. */
export const AI_PENDING_CAP = 50;

/** Made directly whenever writing is allowed. */
export const DIRECT_WRITE_TOOLS = ["set_envelope", "split_transaction", "set_memo", "set_payee_default"] as const;
/** Suggestions in `standard`, direct in `full`. */
export const SUGGESTED_WRITE_TOOLS = ["add_transaction", "assign_to_envelope", "transfer"] as const;
export const WRITE_TOOLS: readonly string[] = [...DIRECT_WRITE_TOOLS, ...SUGGESTED_WRITE_TOOLS];
export type SuggestedTool = (typeof SUGGESTED_WRITE_TOOLS)[number];

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.includes(name);
}

export interface AiConnection {
  /** The OAuth grant, or the token made on Connect an AI (aiConnectionId). */
  id: string;
  /** The token's name, shown in Activity and Review. */
  name: string;
  /** The access token this call came with. */
  tokenId: string;
}

export interface AiWriteContext {
  db: DB;
  memberId: string;
  mode: Exclude<AiWriteMode, "off">;
  connection: AiConnection;
  features: Features;
}

/** "Everything this AI did today": one key per connection per IST day. */
export function aiIdempotencyKey(connectionId: string, day: IsoDate = todayIST()): string {
  return `ai:${connectionId}:${day}`;
}

function aiActor(ctx: AiWriteContext): Actor {
  return {
    memberId: ctx.memberId,
    source: "ai",
    sourceDetail: ctx.connection.name,
    idempotencyKey: aiIdempotencyKey(ctx.connection.id),
  };
}

// ---------------------------------------------------------------------------
// What the member can see — the route guards, restated for a member id
// ---------------------------------------------------------------------------

function visibleCategory(db: DB, memberId: string, id: string): { id: string; name: string } {
  const found = listCategories(db, { includeHidden: true, viewerMemberId: memberId }).find((c) => c.id === id);
  if (!found) throw new Missing(`Envelope "${id}" was not found. Use an id from budget_month.`);
  return { id: found.id, name: found.name };
}

function visibleAccount(db: DB, memberId: string, id: string): Account {
  const found = listAccounts(db, { viewerMemberId: memberId, includeClosed: true }).find((a) => a.id === id);
  if (!found) throw new Missing(`Account "${id}" was not found. Use an id from accounts.`);
  return found;
}

function liveTransaction(db: DB, memberId: string, id: string): Transaction {
  const t = getTransaction(db, id);
  const missing = new Missing(`Transaction "${id}" was not found. Use an id from transactions.`);
  if (!t) throw missing;
  if (!listAccounts(db, { viewerMemberId: memberId, includeClosed: true }).some((a) => a.id === t.account_id)) throw missing;
  if (memberScope(db, memberId).transactions.has(t.id)) throw missing;
  if (t.deleted_at) throw new Refusal(DELETED_TRANSACTION);
  return t;
}

function accountName(a: Account): string {
  return a.nickname || a.name;
}

// ---------------------------------------------------------------------------
// Argument readers: rupees in, paise out, and strict dates
// ---------------------------------------------------------------------------

function amountArg(value: unknown, what: string): Paise {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Refusal(`"${what}" must be a number of rupees above zero.`);
  }
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    throw new Refusal(`"${what}" has more than two decimal places; rupees go to paise and no further.`);
  }
  return rupees(value) as Paise;
}

function dateArg(value: unknown): IsoDate {
  if (value === undefined || value === null || value === "") return todayIST();
  if (typeof value !== "string" || parseDate(value) !== value) {
    throw new Refusal(`"${String(value)}" is not a date. Use YYYY-MM-DD.`);
  }
  return value as IsoDate;
}

function textArg(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function whyArg(value: unknown): string {
  const why = textArg(value);
  if (!why) throw new Refusal(`"why" is required: one sentence the member will read in Review.`);
  return why.slice(0, 500);
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

function refuseOverCaps(ctx: AiWriteContext, suggesting: boolean): void {
  const today = todayIST();
  const written = queryOne<{ n: number }>(
    ctx.db,
    `SELECT COUNT(*) AS n FROM ai_access_log WHERE connection_id = ? AND wrote = 1 AND at >= ?`,
    ctx.connection.id, today,
  )!.n;
  const suggested = queryOne<{ n: number }>(
    ctx.db,
    `SELECT COUNT(*) AS n FROM ai_suggestions WHERE connection_id = ? AND created_at >= ?`,
    ctx.connection.id, today,
  )!.n;
  // A suggestion leaves a line in the log too; counted once.
  if (Math.max(written, suggested) >= AI_DAILY_WRITE_CAP) {
    throw new Refusal(
      `This connection has made ${AI_DAILY_WRITE_CAP} changes today, which is as many as a day allows. ` +
      "Nothing more was changed. Tell the member; they can make further changes in the app, and the limit resets at midnight IST.",
    );
  }
  if (suggesting) {
    const pending = pendingSuggestionCount(ctx.db, ctx.connection.id);
    if (pending >= AI_PENDING_CAP) {
      throw new Refusal(
        `${pending} suggestions from this connection are already waiting in Review. ` +
        "Nothing was suggested. Ask the member to approve or reject those first.",
      );
    }
  }
}

export function pendingSuggestionCount(db: DB, connectionId: string): number {
  return queryOne<{ n: number }>(
    db, `SELECT COUNT(*) AS n FROM ai_suggestions WHERE connection_id = ? AND status = 'pending'`, connectionId,
  )!.n;
}

/** The event ids a write left, found by the sequence they were written after. */
function eventsSince(db: DB, seq: number, key: string | null | undefined): string[] {
  return queryAll<{ id: string }>(
    db, `SELECT id FROM events WHERE seq > ? AND idempotency_key IS ? ORDER BY seq`, seq, key ?? null,
  ).map((r) => r.id);
}

function lastSeq(db: DB): number {
  return queryOne<{ s: number | null }>(db, `SELECT MAX(seq) AS s FROM events`)!.s ?? 0;
}

function changed(db: DB, actor: Actor, before: number, what: string): Record<string, unknown> {
  const ids = eventsSince(db, before, actor.idempotencyKey);
  return {
    changed: what,
    event_id: ids[0] ?? null,
    ...(ids.length > 1 ? { event_ids: ids } : {}),
    ...(ids.length === 0 ? { note: "It was already that way, so nothing was written." } : {}),
    undo: "The member can undo this in Activity, or every change this connection made today from Connect an AI.",
  };
}

// ---------------------------------------------------------------------------
// Direct changes
// ---------------------------------------------------------------------------

export function aiSetEnvelope(ctx: AiWriteContext, args: Record<string, unknown>): unknown {
  const { db, memberId } = ctx;
  refuseOverCaps(ctx, false);
  const t = liveTransaction(db, memberId, String(args.transaction_id));
  const category = visibleCategory(db, memberId, String(args.category_id));
  const actor = aiActor(ctx);
  const before = lastSeq(db);
  return transact(db, () => {
    // As POST /transaction/:id/categorise: one envelope, a split folded into it.
    updateTransaction(db, actor, t.id, t.is_split === 1 ? { splits: null, categoryId: category.id } : { categoryId: category.id });
    // B100 · Filing is the signal for learning, wherever it happened.
    if (learningEnabled(db) && ctx.features.rules) proposeCategoryRules(db, actor);
    return changed(db, actor, before, `Filed the ${formatPaise(Math.abs(t.amount) as Paise)} transaction of ${formatDate(t.date)} under ${category.name}.`);
  });
}

export function aiSplitTransaction(ctx: AiWriteContext, args: Record<string, unknown>): unknown {
  const { db, memberId } = ctx;
  refuseOverCaps(ctx, false);
  const t = liveTransaction(db, memberId, String(args.transaction_id));
  if (t.transfer_pair_id) {
    throw new Refusal("That is one side of a transfer, so it has no envelope to split between.");
  }
  const raw = Array.isArray(args.lines) ? args.lines : [];
  if (raw.length < 2 || raw.length > 25) {
    throw new Refusal(`"lines" takes 2 to 25 envelope lines; for one envelope use set_envelope.`);
  }
  const sign = t.amount < 0 ? -1 : 1;
  const lines = raw.map((l, i) => {
    if (typeof l !== "object" || l === null || Array.isArray(l)) throw new Refusal(`Line ${i + 1} must be an object with category_id and amount.`);
    const line = l as Record<string, unknown>;
    if (typeof line.category_id !== "string") throw new Refusal(`Line ${i + 1} has no category_id.`);
    const category = visibleCategory(db, memberId, line.category_id);
    return { categoryId: category.id, amount: (sign * amountArg(line.amount, `lines[${i}].amount`)) as Paise };
  });
  const total = lines.reduce((s, l) => s + l.amount, 0);
  if (total !== t.amount) {
    throw new Refusal(
      `The lines come to ${formatPaise(Math.abs(total) as Paise)}, but the transaction is ` +
      `${formatPaise(Math.abs(t.amount) as Paise)}. They have to add up to it exactly.`,
    );
  }
  // The page's own reader of envelope lines, so every refusal it makes is made here.
  const filed = resolveCategoryLines(t.amount, [{ categoryId: lines[0]!.categoryId, amount: null }, ...lines.slice(1)]);
  if (outgoingLacksEnvelope(t.amount, filed)) throw new Refusal("Every line of spending needs an envelope.");
  const actor = aiActor(ctx);
  const before = lastSeq(db);
  return transact(db, () => {
    withForwardRecompute(db, actor, { month: monthOf(t.date), cause: "Split a transaction" }, () =>
      updateTransaction(db, actor, t.id, filed.splits ? { splits: filed.splits } : { splits: null, categoryId: filed.categoryId }));
    return changed(db, actor, before, `Split the ${formatPaise(Math.abs(t.amount) as Paise)} transaction of ${formatDate(t.date)} into ${lines.length} envelopes.`);
  });
}

export function aiSetMemo(ctx: AiWriteContext, args: Record<string, unknown>): unknown {
  const { db, memberId } = ctx;
  refuseOverCaps(ctx, false);
  const t = liveTransaction(db, memberId, String(args.transaction_id));
  const memo = textArg(args.memo);
  const actor = aiActor(ctx);
  const before = lastSeq(db);
  return transact(db, () => {
    updateTransaction(db, actor, t.id, { memo });
    return changed(db, actor, before, memo
      ? `Set the memo of the ${formatPaise(Math.abs(t.amount) as Paise)} transaction of ${formatDate(t.date)}.`
      : `Cleared the memo of the ${formatPaise(Math.abs(t.amount) as Paise)} transaction of ${formatDate(t.date)}.`);
  });
}

export function aiSetPayeeDefault(ctx: AiWriteContext, args: Record<string, unknown>): unknown {
  const { db, memberId } = ctx;
  refuseOverCaps(ctx, false);
  const asked = String(args.payee ?? "").trim();
  // A payee only ever seen on somebody else's private account is not listed,
  // so it is not found — the same as one that does not exist.
  const payee = listPayees(db, memberId).find((p) => p.id === asked || p.name.toLowerCase() === asked.toLowerCase());
  if (!payee) throw new Missing(`Payee "${asked}" was not found. Use a payee name from transactions.`);
  const category = visibleCategory(db, memberId, String(args.category_id));
  const why = textArg(args.why);
  const actor = aiActor(ctx);
  const before = lastSeq(db);
  return transact(db, () => {
    const proposal = proposePayeeDefault(db, actor, {
      payee: getPayee(db, payee.id)!.name, categoryId: category.id, categoryName: category.name,
      because: `${ctx.connection.name} suggested it${why ? `: ${why}` : "."}`,
    });
    return {
      ...changed(db, actor, before, `Proposed filing ${payee.name} under ${category.name} from now on.`),
      rule_id: proposal.id,
      status: "waiting for the member to confirm it in Review, under Proposed rules. A rule nobody confirmed files nothing.",
    };
  });
}

// ---------------------------------------------------------------------------
// The three that move money: suggestions in standard, direct in full
// ---------------------------------------------------------------------------

interface Plan {
  /** What the app says this would do, in its own words. */
  summary: string;
  /** Makes the change as `actor`. Throws a Refusal if it no longer can. */
  apply(actor: Actor): void;
}

/** Validated against `memberId`'s view of the budget; nothing is written. */
function planFor(db: DB, memberId: string, tool: SuggestedTool, args: Record<string, unknown>): Plan {
  switch (tool) {
    case "add_transaction": {
      const account = visibleAccount(db, memberId, String(args.account_id));
      if (DERIVED_VALUE_SUBTYPES.has(account.subtype)) {
        throw new Refusal(`${accountName(account)} is valued on its own screen; transactions are not added to it directly.`);
      }
      const magnitude = amountArg(args.amount, "amount");
      const direction = args.direction === "in" ? "in" : "out";
      const signed = (direction === "in" ? magnitude : -magnitude) as Paise;
      const date = dateArg(args.date);
      const category = typeof args.category_id === "string" && args.category_id
        ? visibleCategory(db, memberId, args.category_id) : null;
      const filed = resolveCategoryLines(signed, [{ categoryId: category?.id ?? null, amount: null }]);
      if (outgoingLacksEnvelope(signed, filed)) {
        throw new Refusal("Money going out needs an envelope: pass category_id. Money coming in does not.");
      }
      const payee = textArg(args.payee);
      const memo = textArg(args.memo);
      return {
        summary:
          `${direction === "in" ? "Record" : "Record spending of"} ${formatPaise(magnitude)}` +
          `${direction === "in" ? " received into" : " from"} ${accountName(account)}` +
          `${payee ? (direction === "in" ? ` from ${payee}` : ` at ${payee}`) : ""} on ${formatDate(date)}` +
          `${category ? `, filed under ${category.name}` : ", into Ready to Assign"}`,
        apply: (actor) => {
          createTransaction(db, actor, {
            accountId: account.id, amount: signed, date, payeeName: payee, categoryId: category?.id ?? null,
            memo, cleared: false,
          });
        },
      };
    }
    case "assign_to_envelope": {
      const category = visibleCategory(db, memberId, String(args.category_id));
      const month = typeof args.month === "string" && args.month ? args.month : monthOf(todayIST());
      if (!isMonthKey(month)) throw new Refusal(`"${month}" is not a month. Use YYYY-MM.`);
      const amount = args.amount === 0 ? 0 as Paise : amountArg(args.amount, "amount");
      return {
        summary: `Set what is assigned to ${category.name} for ${formatMonth(month as MonthKey)} to ${formatPaise(amount)}`,
        apply: (actor) => {
          withForwardRecompute(db, actor, { month: month as MonthKey, cause: `Changed what ${category.name} was assigned` },
            () => setAssigned(db, actor, month as MonthKey, category.id, amount));
        },
      };
    }
    case "transfer": {
      const from = visibleAccount(db, memberId, String(args.from_account_id));
      const to = visibleAccount(db, memberId, String(args.to_account_id));
      if (from.id === to.id) throw new Refusal("A transfer needs two different accounts.");
      const amount = amountArg(args.amount, "amount");
      const date = dateArg(args.date);
      const memo = textArg(args.memo);
      return {
        summary: `Move ${formatPaise(amount)} from ${accountName(from)} to ${accountName(to)} on ${formatDate(date)}`,
        apply: (actor) => {
          createTransfer(db, actor, { fromAccountId: from.id, toAccountId: to.id, amount, date, memo, fee: null });
        },
      };
    }
  }
}

/** Run `fn` and take everything it wrote back, keeping only whether it threw. */
function dryRun(db: DB, fn: () => void): void {
  class RolledBack extends Error {}
  try {
    transact(db, () => {
      fn();
      throw new RolledBack();
    });
  } catch (err) {
    if (!(err instanceof RolledBack)) throw err;
  }
}

export function aiSuggestedWrite(ctx: AiWriteContext, tool: SuggestedTool, args: Record<string, unknown>): unknown {
  const { db, memberId } = ctx;
  const suggesting = ctx.mode === "standard";
  refuseOverCaps(ctx, suggesting);
  const why = whyArg(args.why);
  const plan = planFor(db, memberId, tool, args);
  const actor = aiActor(ctx);

  if (!suggesting) {
    const before = lastSeq(db);
    return transact(db, () => {
      plan.apply(actor);
      return changed(db, actor, before, `${plan.summary}.`);
    });
  }

  // Tried and taken back first, so a suggestion the domain would refuse is
  // refused now, while the model can still correct it, not when the member
  // presses Approve.
  dryRun(db, () => plan.apply(actor));
  const id = newId();
  execute(
    db,
    `INSERT INTO ai_suggestions
       (id, member_id, connection_id, token_id, token_name, tool, arguments, summary, why, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`,
    id, memberId, ctx.connection.id, ctx.connection.tokenId, ctx.connection.name, tool,
    JSON.stringify(args), plan.summary, why, nowIST(),
  );
  return {
    suggestion_id: id,
    status: "pending",
    suggested: `${plan.summary}.`,
    message: "Nothing has changed yet: this is waiting for approval in Review. Tell the member it is there.",
  };
}

// ---------------------------------------------------------------------------
// Review · deciding on a suggestion
// ---------------------------------------------------------------------------

export interface AiSuggestionRow {
  id: string;
  member_id: string;
  connection_id: string;
  token_id: string;
  token_name: string;
  tool: SuggestedTool;
  arguments: string;
  summary: string;
  why: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  result_event_id: string | null;
}

/**
 * The suggestions waiting for this member: only their own connections'. The
 * reason is written by the model from that member's own conversation, which
 * may say things about their private budget; and approving is acting on that
 * conversation, which is theirs to judge. See docs/ai.md.
 */
export function pendingSuggestions(db: DB, memberId: string | null): AiSuggestionRow[] {
  if (!memberId) return [];
  return queryAll<AiSuggestionRow>(
    db,
    `SELECT * FROM ai_suggestions WHERE member_id = ? AND status = 'pending' ORDER BY created_at, id`,
    memberId,
  );
}

function ownSuggestion(db: DB, memberId: string, id: string): AiSuggestionRow {
  const row = queryOne<AiSuggestionRow>(db, `SELECT * FROM ai_suggestions WHERE id = ?`, id);
  if (!row || row.member_id !== memberId) throw new Missing("That suggestion does not exist.");
  if (row.status !== "pending") throw new Refusal(`That suggestion was already ${row.status}.`);
  return row;
}

/**
 * Approve: the same change the direct path makes, as the approving member,
 * with source `ai` and a detail that says it was a suggestion. Its own
 * idempotency key, so "undo this AI's changes today" leaves alone what a
 * member looked at and approved; Activity undoes it like any other change.
 * Checked again against what the member can see now, not when it was made.
 */
export function approveSuggestion(db: DB, memberId: string, id: string): { summary: string; eventId: string | null } {
  return transact(db, () => {
    const row = ownSuggestion(db, memberId, id);
    const plan = planFor(db, memberId, row.tool, JSON.parse(row.arguments) as Record<string, unknown>);
    const actor: Actor = {
      memberId, source: "ai", sourceDetail: `${row.token_name}, suggestion approved`,
      idempotencyKey: `ai-suggestion:${row.id}`,
    };
    const before = lastSeq(db);
    plan.apply(actor);
    const eventId = eventsSince(db, before, actor.idempotencyKey)[0] ?? null;
    execute(
      db,
      `UPDATE ai_suggestions SET status = 'approved', decided_at = ?, decided_by = ?, result_event_id = ? WHERE id = ?`,
      nowIST(), memberId, eventId, row.id,
    );
    return { summary: plan.summary, eventId };
  });
}

export function rejectSuggestion(db: DB, memberId: string, id: string): void {
  const row = ownSuggestion(db, memberId, id);
  execute(
    db, `UPDATE ai_suggestions SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ?`,
    nowIST(), memberId, row.id,
  );
}

/** Kept tidy: decided suggestions go after 90 days, like the access log. */
export function pruneSuggestions(db: DB, now: Date = new Date()): void {
  const cutoff = nowIST(new Date(now.getTime() - 90 * 86_400_000));
  execute(db, `DELETE FROM ai_suggestions WHERE status <> 'pending' AND decided_at < ?`, cutoff);
}

/** For the Review page: a category's name, if this member may see it. */
export function suggestionCategoryName(db: DB, id: string): string | null {
  return getCategory(db, id)?.name ?? null;
}
