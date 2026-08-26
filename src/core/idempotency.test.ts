import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type DB } from "../db/db.ts";
import {
  withIdempotency,
  IdempotencyConflict,
  canonicalise,
  hashRequest,
  pruneIdempotencyKeys,
} from "./idempotency.ts";
import { addDays, todayIST } from "./dates.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";

function setup(): DB {
  return openDatabase({ path: ":memory:", verbose: false });
}

function post<T>(db: DB, key: string | null, memberId: string, payload: unknown, fn: () => T) {
  return withIdempotency<T>(
    db,
    { key, memberId, method: "POST", path: "/transactions", payload },
    () => ({ statusCode: 201, body: fn() }),
  );
}

describe("canonicalise", () => {
  test("is stable across key order", () => {
    assert.equal(canonicalise({ a: 1, b: 2 }), canonicalise({ b: 2, a: 1 }));
    assert.equal(
      hashRequest("POST", "/t", { amount: 1, payee: "x" }),
      hashRequest("POST", "/t", { payee: "x", amount: 1 }),
    );
  });

  test("distinguishes genuinely different payloads", () => {
    assert.notEqual(canonicalise({ a: 1 }), canonicalise({ a: 2 }));
    assert.notEqual(canonicalise({ a: [1, 2] }), canonicalise({ a: [2, 1] }));
  });

  test("sorts nested keys too", () => {
    assert.equal(canonicalise({ x: { b: 1, a: 2 } }), '{"x":{"a":2,"b":1}}');
  });
});

describe("withIdempotency — R36.2", () => {
  test("performs the work once and replays the original result", () => {
    const db = setup();
    let calls = 0;
    const payload = { amount: -45000, payee: "Swiggy" };

    const first = post(db, "k1", RAVI, payload, () => {
      calls++;
      return { id: "t-created" };
    });
    const second = post(db, "k1", RAVI, payload, () => {
      calls++;
      return { id: "t-different" };
    });

    assert.equal(calls, 1, "the retry must not create a second transaction");
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.deepEqual(second.body, { id: "t-created" });
    assert.equal(second.statusCode, 201);
    db.close();
  });

  test("scopes keys per member so two members cannot collide (R36.4)", () => {
    const db = setup();
    let calls = 0;
    post(db, "same-key", RAVI, { a: 1 }, () => ({ n: ++calls }));
    post(db, "same-key", PRIYA, { a: 1 }, () => ({ n: ++calls }));
    assert.equal(calls, 2, "Priya's write must not be swallowed by Ravi's key");
    db.close();
  });

  test("rejects a reused key carrying a different payload", () => {
    const db = setup();
    post(db, "k1", RAVI, { amount: 100 }, () => ({ ok: true }));
    assert.throws(
      () => post(db, "k1", RAVI, { amount: 999 }, () => ({ ok: true })),
      (err: unknown) =>
        err instanceof IdempotencyConflict && err.statusCode === 422,
    );
    db.close();
  });

  test("frees the key when the work throws, so a real retry can proceed", () => {
    const db = setup();
    assert.throws(() =>
      post(db, "k1", RAVI, { a: 1 }, () => {
        throw new Error("database was busy");
      }),
    );

    // N5: the user's entry must not be lost. The same key now works.
    const retry = post(db, "k1", RAVI, { a: 1 }, () => ({ id: "t1" }));
    assert.equal(retry.replayed, false);
    assert.deepEqual(retry.body, { id: "t1" });
    db.close();
  });

  test("reports 409 while a first attempt is still in flight", () => {
    const db = setup();
    // Simulate a concurrent request that has claimed the key but not finished.
    db.prepare(
      `INSERT INTO idempotency_keys (key, member_id, request_hash, status, created_at)
       VALUES (?,?,?,'in-progress',?)`,
    ).run("k1", RAVI, hashRequest("POST", "/transactions", { a: 1 }), "2026-08-26T10:00:00+05:30");

    assert.throws(
      () => post(db, "k1", RAVI, { a: 1 }, () => ({ ok: true })),
      (err: unknown) => err instanceof IdempotencyConflict && err.statusCode === 409,
    );
    db.close();
  });

  test("runs every time when no key is supplied, for internal callers", () => {
    const db = setup();
    let calls = 0;
    post(db, null, RAVI, { a: 1 }, () => ({ n: ++calls }));
    post(db, null, RAVI, { a: 1 }, () => ({ n: ++calls }));
    assert.equal(calls, 2);
    db.close();
  });

  test("stores a null body without breaking the replay", () => {
    const db = setup();
    const first = withIdempotency<null>(
      db,
      { key: "k1", memberId: RAVI, method: "DELETE", path: "/t/1", payload: {} },
      () => ({ statusCode: 204, body: null }),
    );
    const second = withIdempotency<null>(
      db,
      { key: "k1", memberId: RAVI, method: "DELETE", path: "/t/1", payload: {} },
      () => ({ statusCode: 204, body: null }),
    );
    assert.equal(first.statusCode, 204);
    assert.equal(second.replayed, true);
    assert.equal(second.body, null);
    db.close();
  });
});

describe("pruneIdempotencyKeys — R36.3", () => {
  test("keeps keys inside the retention window", () => {
    const db = setup();
    post(db, "recent", RAVI, { a: 1 }, () => ({ ok: true }));
    assert.equal(pruneIdempotencyKeys(db), 0);
    db.close();
  });

  test("drops expired keys, so a much later repeat is a new operation", () => {
    const db = setup();
    post(db, "old", RAVI, { a: 1 }, () => ({ id: "first" }));
    db.prepare("UPDATE idempotency_keys SET created_at = ?").run(addDays(todayIST(), -8));

    assert.equal(pruneIdempotencyKeys(db), 1);

    const after = post(db, "old", RAVI, { a: 1 }, () => ({ id: "second" }));
    assert.equal(after.replayed, false);
    assert.deepEqual(after.body, { id: "second" });
    db.close();
  });
});
