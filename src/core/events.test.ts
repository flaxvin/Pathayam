import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, type DB } from "../db/db.ts";
import {
  appendEvent,
  queryEvents,
  historyFor,
  getEvent,
  registerUndoHandler,
  checkUndo,
  undoEvent,
  undoByIdempotencyKey,
  type Actor,
} from "./events.ts";
import { addDays, todayIST } from "./dates.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";

const ui = (memberId: string, key?: string): Actor => ({
  memberId,
  source: "ui",
  idempotencyKey: key ?? null,
});

function setup(): DB {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  const insert = db.prepare("INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)");
  insert.run(RAVI, "ravi@example.com", "Ravi", "2026-08-01T00:00:00+05:30");
  insert.run(PRIYA, "priya@example.com", "Priya", "2026-08-01T00:00:00+05:30");
  return db;
}

describe("appendEvent — R37.1", () => {
  test("records what changed, who did it, when and from where", () => {
    const db = setup();
    const e = appendEvent(db, { memberId: RAVI, source: "ui", idempotencyKey: "k1" }, {
      entity: "assignment",
      entityId: "2026-08:groceries",
      action: "assign",
      before: { amount: 0 },
      after: { amount: 1_200_000 },
      summary: "Assigned ₹12,000 to Groceries",
    });

    assert.equal(e.actorMemberId, RAVI);
    assert.equal(e.source, "ui");
    assert.equal(e.idempotencyKey, "k1");
    assert.deepEqual(e.before, { amount: 0 });
    assert.deepEqual(e.after, { amount: 1_200_000 });
    assert.match(e.at, /\+05:30$/);
    db.close();
  });

  test("keeps the real member behind an impersonation (R38.9)", () => {
    const db = setup();
    const e = appendEvent(
      db,
      { memberId: PRIYA, realMemberId: RAVI, source: "ui" },
      { entity: "transaction", entityId: "t1", action: "create" },
    );
    assert.equal(e.actorMemberId, PRIYA);
    assert.equal(e.realMemberId, RAVI);
    db.close();
  });

  test("names the rule or job behind an automated write (R37.6)", () => {
    const db = setup();
    const e = appendEvent(
      db,
      { memberId: null, source: "rule", sourceDetail: "Contains DMART → Groceries" },
      { entity: "transaction", entityId: "t1", action: "categorise" },
    );
    assert.equal(e.source, "rule");
    assert.equal(e.sourceDetail, "Contains DMART → Groceries");
    db.close();
  });

  test("orders events by an increasing sequence", () => {
    const db = setup();
    const a = appendEvent(db, ui(RAVI), { entity: "x", entityId: "1", action: "create" });
    const b = appendEvent(db, ui(RAVI), { entity: "x", entityId: "1", action: "update" });
    assert.ok(b.seq > a.seq);
    db.close();
  });
});

describe("queryEvents — R37.4", () => {
  test("filters by record, actor and source", () => {
    const db = setup();
    appendEvent(db, ui(RAVI), { entity: "transaction", entityId: "t1", action: "create" });
    appendEvent(db, ui(PRIYA), { entity: "transaction", entityId: "t2", action: "create" });
    appendEvent(db, { memberId: null, source: "import" }, {
      entity: "transaction", entityId: "t3", action: "create",
    });

    assert.equal(queryEvents(db, { entity: "transaction" }).length, 3);
    assert.equal(queryEvents(db, { entityId: "t1" }).length, 1);
    assert.equal(queryEvents(db, { actorMemberId: PRIYA }).length, 1);
    assert.equal(queryEvents(db, { source: "import" }).length, 1);
    db.close();
  });

  test("returns a record's history oldest first, which is what J22 reads", () => {
    const db = setup();
    appendEvent(db, ui(RAVI), { entity: "category", entityId: "groceries", action: "assign", summary: "Assigned ₹12,000 on 01-08 by Ravi" });
    appendEvent(db, ui(PRIYA), { entity: "category", entityId: "groceries", action: "move-out", summary: "₹1,850 moved out to Eating Out on 14-08 by Priya" });
    appendEvent(db, { memberId: null, source: "rule", sourceDetail: "Contains DMART → Groceries" }, {
      entity: "category", entityId: "groceries", action: "activity", summary: "₹2,150 spent on 18-08",
    });

    const history = historyFor(db, "category", "groceries");
    assert.equal(history.length, 3);
    assert.match(history[0]!.summary!, /Assigned ₹12,000/);
    assert.match(history[2]!.summary!, /₹2,150 spent/);
    // Three events, three actors, one answer.
    assert.deepEqual(history.map((e) => e.source), ["ui", "ui", "rule"]);
    db.close();
  });
});

describe("undo — R37.8, R37.9", () => {
  // A minimal entity to exercise the undo machinery end to end.
  function withCounterEntity(db: DB) {
    db.exec("CREATE TABLE counters (id TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    registerUndoHandler("counter", (database, event) => {
      const before = event.before as { value: number } | undefined;
      if (before === undefined) {
        database.prepare("DELETE FROM counters WHERE id = ?").run(event.entityId!);
        return `Removed counter ${event.entityId}`;
      }
      database
        .prepare("INSERT INTO counters (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value = ?")
        .run(event.entityId!, before.value, before.value);
      return `Restored counter ${event.entityId} to ${before.value}`;
    });
  }

  function setValue(db: DB, actor: Actor, id: string, value: number) {
    const before = db.prepare("SELECT value FROM counters WHERE id = ?").get(id) as
      | { value: number }
      | undefined;
    db.prepare("INSERT INTO counters (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value = ?")
      .run(id, value, value);
    return appendEvent(db, actor, {
      entity: "counter",
      entityId: id,
      action: before ? "update" : "create",
      before: before ? { value: before.value } : undefined,
      after: { value },
    });
  }

  let db: DB;
  beforeEach(() => {
    db = setup();
    withCounterEntity(db);
  });

  test("reverses a change by applying its inverse as a new event", () => {
    setValue(db, ui(RAVI), "c1", 10);
    const second = setValue(db, ui(RAVI), "c1", 99);

    const result = undoEvent(db, second.id, ui(RAVI));
    assert.ok(result.ok);

    const { value } = db.prepare("SELECT value FROM counters WHERE id = 'c1'").get() as {
      value: number;
    };
    assert.equal(value, 10);
  });

  test("never edits or deletes the original event (R37.2)", () => {
    const e = setValue(db, ui(RAVI), "c1", 10);
    undoEvent(db, e.id, ui(RAVI));

    const original = getEvent(db, e.id)!;
    assert.deepEqual(original.after, { value: 10 });
    assert.ok(original.undoneByEventId, "the original is linked to its undo, not removed");

    const undo = getEvent(db, original.undoneByEventId!)!;
    assert.equal(undo.undoOfEventId, e.id);
    assert.equal(undo.action, "undo");
  });

  test("refuses to undo the same change twice", () => {
    const e = setValue(db, ui(RAVI), "c1", 10);
    assert.ok(undoEvent(db, e.id, ui(RAVI)).ok);
    const second = undoEvent(db, e.id, ui(RAVI));
    assert.equal(second.ok, false);
    assert.match(second.reason!, /already been undone/);
  });

  test("warns rather than silently conflicting when later changes exist (R37.9)", () => {
    const first = setValue(db, ui(RAVI), "c1", 10);
    setValue(db, ui(PRIYA), "c1", 50);

    const attempt = undoEvent(db, first.id, ui(RAVI));
    assert.equal(attempt.ok, false);
    assert.equal(attempt.supersededBy.length, 1);
    assert.match(attempt.reason!, /discard those later changes/);

    // The value is untouched until the user says go ahead.
    const { value } = db.prepare("SELECT value FROM counters WHERE id = 'c1'").get() as {
      value: number;
    };
    assert.equal(value, 50);

    assert.ok(undoEvent(db, first.id, ui(RAVI), { force: true }).ok);
  });

  test("refuses outside the 30-day window (Q25)", () => {
    const e = setValue(db, ui(RAVI), "c1", 10);
    const long = addDays(todayIST(), 31);
    const check = checkUndo(db, e.id, 30, long);
    assert.equal(check.ok, false);
    assert.match(check.reason!, /outside the undo window/);
  });

  test("refuses an entity with no registered inverse", () => {
    const e = appendEvent(db, ui(RAVI), { entity: "mystery", entityId: "x", action: "create" });
    const result = undoEvent(db, e.id, ui(RAVI));
    assert.equal(result.ok, false);
    assert.match(result.reason!, /cannot be undone/);
  });

  test("undoes a whole batch by its idempotency key (IL2)", () => {
    const batch = ui(RAVI, "import-batch-1");
    setValue(db, batch, "c1", 1);
    setValue(db, batch, "c2", 2);
    setValue(db, ui(RAVI, "unrelated"), "c3", 3);

    const results = undoByIdempotencyKey(db, "import-batch-1", ui(RAVI));
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.ok));

    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM counters").get<{ n: number }>()!.n, 1);
    assert.ok(db.prepare("SELECT value FROM counters WHERE id = 'c3'").get());
  });

  test("logs the undo itself, attributed to whoever pressed it", () => {
    const e = setValue(db, ui(RAVI), "c1", 10);
    undoEvent(db, e.id, ui(PRIYA));
    const undos = queryEvents(db, { action: "undo" });
    assert.equal(undos.length, 1);
    assert.equal(undos[0]!.actorMemberId, PRIYA);
  });
});
