/**
 * R37 · The event log — append-only, immutable, ordered, attributed.
 *
 * Every mutation in this app goes through `appendEvent`. Nothing writes to a
 * table without one (N20). The log is built first because it cannot be
 * retrofitted: adding it in month six means touching every mutation path
 * (`08` §1), and it pays for four features that each cost more separately —
 * universal undo, "explain this number", as-of-date views, and deterministic
 * test fixtures (`08` §5.1).
 *
 * Reads are never logged (R37.7). This is an audit trail, not surveillance of
 * a spouse.
 */

import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne } from "../db/db.ts";
import { nowIST, addDays, todayIST } from "./dates.ts";

export type EventSource = "ui" | "import" | "rule" | "schedule" | "api" | "job" | "system";

/**
 * Who is acting, and how. Threaded through every mutation so attribution is
 * impossible to forget rather than merely required.
 */
export interface Actor {
  /** The member the action is attributed to. */
  memberId: string | null;
  /**
   * The member actually at the keyboard, when it differs — i.e. during
   * impersonation (R38.9). The trail must never lose who really did it.
   */
  realMemberId?: string | null;
  source: EventSource;
  /** Names the rule or job responsible for an automated write (R37.6). */
  sourceDetail?: string | null;
  idempotencyKey?: string | null;
}

export interface AppendEventInput {
  entity: string;
  entityId?: string | null;
  action: string;
  before?: unknown;
  after?: unknown;
  /** A plain-language line for "explain this number" and the history pane. */
  summary?: string;
  undoOfEventId?: string | null;
}

export interface LoggedEvent {
  seq: number;
  id: string;
  at: string;
  actorMemberId: string | null;
  realMemberId: string | null;
  source: EventSource;
  sourceDetail: string | null;
  entity: string;
  entityId: string | null;
  action: string;
  before: unknown;
  after: unknown;
  summary: string | null;
  idempotencyKey: string | null;
  undoOfEventId: string | null;
  undoneByEventId: string | null;
}

export function appendEvent(db: DB, actor: Actor, input: AppendEventInput): LoggedEvent {
  const id = newId();
  const at = nowIST();

  db.prepare(
    `INSERT INTO events
       (id, at, actor_member_id, real_member_id, source, source_detail,
        entity, entity_id, action, before_json, after_json, summary,
        idempotency_key, undo_of_event_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    at,
    actor.memberId,
    actor.realMemberId ?? null,
    actor.source,
    actor.sourceDetail ?? null,
    input.entity,
    input.entityId ?? null,
    input.action,
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after),
    input.summary ?? null,
    actor.idempotencyKey ?? null,
    input.undoOfEventId ?? null,
  );

  return hydrate(queryOne<EventRow>(db, "SELECT * FROM events WHERE id = ?", id)!);
}

interface EventRow {
  seq: number;
  id: string;
  at: string;
  actor_member_id: string | null;
  real_member_id: string | null;
  source: string;
  source_detail: string | null;
  entity: string;
  entity_id: string | null;
  action: string;
  before_json: string | null;
  after_json: string | null;
  summary: string | null;
  idempotency_key: string | null;
  undo_of_event_id: string | null;
  undone_by_event_id: string | null;
}

function hydrate(row: EventRow): LoggedEvent {
  return {
    seq: row.seq,
    id: row.id,
    at: row.at,
    actorMemberId: row.actor_member_id,
    realMemberId: row.real_member_id,
    source: row.source as EventSource,
    sourceDetail: row.source_detail,
    entity: row.entity,
    entityId: row.entity_id,
    action: row.action,
    before: row.before_json === null ? undefined : JSON.parse(row.before_json),
    after: row.after_json === null ? undefined : JSON.parse(row.after_json),
    summary: row.summary,
    idempotencyKey: row.idempotency_key,
    undoOfEventId: row.undo_of_event_id,
    undoneByEventId: row.undone_by_event_id,
  };
}

// ---------------------------------------------------------------------------
// Querying — R37.4: by record, by actor, by time range, by source
// ---------------------------------------------------------------------------

export interface EventQuery {
  entity?: string;
  entityId?: string;
  actorMemberId?: string;
  source?: EventSource;
  action?: string;
  /** Inclusive ISO date bounds on the event timestamp. */
  from?: string;
  to?: string;
  limit?: number;
  /** Newest first. Default true. */
  descending?: boolean;
}

export function queryEvents(db: DB, q: EventQuery = {}): LoggedEvent[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (q.entity) { where.push("entity = ?"); params.push(q.entity); }
  if (q.entityId) { where.push("entity_id = ?"); params.push(q.entityId); }
  if (q.actorMemberId) { where.push("actor_member_id = ?"); params.push(q.actorMemberId); }
  if (q.source) { where.push("source = ?"); params.push(q.source); }
  if (q.action) { where.push("action = ?"); params.push(q.action); }
  if (q.from) { where.push("at >= ?"); params.push(q.from); }
  // `to` is an inclusive date bound, so compare against the end of that day.
  if (q.to) { where.push("at <= ?"); params.push(`${q.to}T23:59:59.999+05:30`); }

  const sql =
    `SELECT * FROM events` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY seq ${q.descending === false ? "ASC" : "DESC"}` +
    ` LIMIT ?`;
  params.push(q.limit ?? 200);

  return queryAll<EventRow>(db, sql, ...params).map(hydrate);
}

/** F25.12: every event that touched one record, oldest first. */
export function historyFor(db: DB, entity: string, entityId: string): LoggedEvent[] {
  return queryEvents(db, { entity, entityId, descending: false, limit: 1000 });
}

export function getEvent(db: DB, id: string): LoggedEvent | null {
  const row = queryOne<EventRow>(db, "SELECT * FROM events WHERE id = ?", id);
  return row ? hydrate(row) : null;
}

// ---------------------------------------------------------------------------
// R37.8 · Undo
// ---------------------------------------------------------------------------

/**
 * How to reverse one entity's events. Registered rather than hard-coded so a
 * new feature supplies its own inverse alongside its mutations, and undo stays
 * one mechanism rather than a per-feature reimplementation (`08` §5.1).
 */
export type UndoHandler = (db: DB, event: LoggedEvent, actor: Actor) => string;

const undoHandlers = new Map<string, UndoHandler>();

export function registerUndoHandler(entity: string, handler: UndoHandler): void {
  undoHandlers.set(entity, handler);
}

export const DEFAULT_UNDO_WINDOW_DAYS = 30; // Q25

export interface UndoCheck {
  ok: boolean;
  reason?: string;
  /**
   * R37.9: events that have since touched the same record. Undoing over them
   * must warn and show what would change, never silently conflict.
   */
  supersededBy: LoggedEvent[];
}

export function checkUndo(
  db: DB,
  eventId: string,
  windowDays = DEFAULT_UNDO_WINDOW_DAYS,
  today = todayIST(),
): UndoCheck {
  const event = getEvent(db, eventId);
  if (!event) return { ok: false, reason: "That change is not in the log.", supersededBy: [] };

  if (event.undoneByEventId) {
    return { ok: false, reason: "That change has already been undone.", supersededBy: [] };
  }
  if (event.undoOfEventId) {
    return { ok: false, reason: "That entry is itself an undo — undo the original instead.", supersededBy: [] };
  }
  if (!undoHandlers.has(event.entity)) {
    return { ok: false, reason: `Changes to ${event.entity} cannot be undone.`, supersededBy: [] };
  }

  const cutoff = addDays(today, -windowDays);
  if (event.at.slice(0, 10) < cutoff) {
    return {
      ok: false,
      reason: `That change is older than ${windowDays} days and is outside the undo window.`,
      supersededBy: [],
    };
  }

  const superseded = event.entityId
    ? queryAll<EventRow>(
        db,
        `SELECT * FROM events
          WHERE entity = ? AND entity_id = ? AND seq > ? AND undo_of_event_id IS NULL
          ORDER BY seq ASC LIMIT 20`,
        event.entity,
        event.entityId,
        event.seq,
      ).map(hydrate)
    : [];

  return { ok: true, supersededBy: superseded };
}

export interface UndoResult {
  ok: boolean;
  reason?: string;
  supersededBy: LoggedEvent[];
  undoEvent?: LoggedEvent;
}

/**
 * Reverse an event by applying its inverse as a new event (R37.2) — the
 * original is never edited or deleted. The undo is itself logged (R37.8).
 *
 * Refuses when later events have touched the same record unless `force` is
 * set, so the caller shows the user what would change first (R37.9).
 */
export function undoEvent(
  db: DB,
  eventId: string,
  actor: Actor,
  opts: { force?: boolean; windowDays?: number; today?: string } = {},
): UndoResult {
  const check = checkUndo(db, eventId, opts.windowDays ?? DEFAULT_UNDO_WINDOW_DAYS, opts.today);
  if (!check.ok) return { ok: false, reason: check.reason, supersededBy: check.supersededBy };

  if (check.supersededBy.length > 0 && !opts.force) {
    return {
      ok: false,
      reason:
        `That change has been altered ${check.supersededBy.length} time(s) since. ` +
        `Undoing it will discard those later changes.`,
      supersededBy: check.supersededBy,
    };
  }

  const event = getEvent(db, eventId)!;
  const handler = undoHandlers.get(event.entity)!;

  return transact(db, () => {
    const summary = handler(db, event, actor);
    const undo = appendEvent(db, actor, {
      entity: event.entity,
      entityId: event.entityId,
      action: "undo",
      before: event.after,
      after: event.before,
      summary,
      undoOfEventId: event.id,
    });
    db.prepare("UPDATE events SET undone_by_event_id = ? WHERE id = ?").run(undo.id, event.id);
    return { ok: true, supersededBy: check.supersededBy, undoEvent: undo };
  });
}

/**
 * R36.8 / IL2: reverse every event that shared one idempotency key, newest
 * first. This is how a bulk edit or a whole import batch undoes in one action.
 */
export function undoByIdempotencyKey(
  db: DB,
  key: string,
  actor: Actor,
  opts: { force?: boolean } = {},
): UndoResult[] {
  const events = queryAll<EventRow>(
    db,
    "SELECT * FROM events WHERE idempotency_key = ? AND undo_of_event_id IS NULL ORDER BY seq DESC",
    key,
  ).map(hydrate);

  return transact(db, () => events.map((e) => undoEvent(db, e.id, actor, opts)));
}
