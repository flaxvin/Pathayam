/**
 * OFFLINE-1 · The server half of the write-only queue (`10` §3.7).
 *
 * The client keeps an Add-form entry that could not reach the server and
 * sends it again later with the key it was first sent with. Everything that
 * makes that safe is on this side: a replay with the same key must be
 * answered with the original result and never become a second transaction,
 * and a refusal must come back as an answer the client can show and keep.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { queryOne } from "../db/db.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { freshHousehold, RAVI } from "../engine/identity.test-data.ts";
import { startTestApp } from "./harness.test-data.ts";
import { page } from "./layout.ts";
import { raw } from "../http/html.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

function household() {
  const db = freshHousehold();
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 1_000_000,
  }).id;
  const food = createCategory(db, actor, { groupId: createGroup(db, actor, "Everyday").id, name: "Food" }).id;
  return { db, bank, food };
}

const count = (db: ReturnType<typeof household>["db"]) =>
  queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM transactions WHERE deleted_at IS NULL`)!.n;

/** Exactly what the client's replay sends: JSON wanted, the original key. */
const replay = (key: string) => ({
  headers: { "Idempotency-Key": key, Accept: "application/json" },
});

describe("OFFLINE-1 · a queued entry sent again", () => {
  test("the same key twice makes one transaction, and both answers say saved", async () => {
    const { db, bank, food } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    const form = {
      amount: "450", direction: "out", payee: "Chai stall", split_category_0: food,
      account_id: bank, date: "2026-10-20", memo: "", tags: "",
    };
    try {
      // The first attempt landed but its answer was lost on the way back —
      // the client saw a rejected fetch and kept the entry.
      const first = await app.post("/add", form, replay("k-offline-1"));
      assert.equal(first.status, 200);
      const firstBody = await first.json();
      assert.equal(count(db), 1);

      // On reconnect the queue sends it again, unchanged, with the same key.
      const again = await app.post("/add", form, replay("k-offline-1"));
      assert.equal(again.status, 200);
      assert.match(again.headers.get("content-type") ?? "", /application\/json/,
        "the client only counts a JSON answer as confirmed");
      assert.deepEqual(await again.json(), firstBody, "the original result, not a second save");
      assert.equal(count(db), 1, "a replay must never duplicate the spend");
      assert.equal(
        queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM events WHERE entity = 'transaction' AND action = 'create'`)!.n,
        1,
      );
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });

  test("a different key is a different spend — the queue never invents keys", async () => {
    const { db, bank, food } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    const form = { amount: "120", direction: "out", split_category_0: food, account_id: bank, date: "2026-10-20" };
    try {
      await app.post("/add", form, replay("k-a"));
      await app.post("/add", form, replay("k-b"));
      assert.equal(count(db), 2);
    } finally { await app.close(); }
  });

  test("a refusal comes back as words the client keeps and shows", async () => {
    const { db, bank } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    // Money out with no envelope: B99 refuses it, and resending will not help.
    const form = { amount: "80", direction: "out", account_id: bank, date: "2026-10-20", split_category_0: "" };
    try {
      const res = await app.post("/add", form, replay("k-refused"));
      assert.ok(res.status >= 400 && res.status < 500 && ![401, 408, 409, 429].includes(res.status),
        `a refusal, not a retry signal (got ${res.status})`);
      const body = await res.json();
      assert.match(body.error, /envelope/i);
      assert.equal(count(db), 0);
    } finally { await app.close(); }
  });

  test("an ended session answers 401 in JSON, so the queue waits for sign-in", async () => {
    const { db, bank, food } = household();
    const app = await startTestApp(db, { memberId: null });
    try {
      const res = await app.post("/add",
        { amount: "10", direction: "out", split_category_0: food, account_id: bank, date: "2026-10-20" },
        replay("k-expired"));
      assert.equal(res.status, 401);
      assert.equal(count(db), 0);
    } finally { await app.close(); }
  });
});

describe("OFFLINE-1 · what the page gives the client", () => {
  test("the Add form opts in, and the page names its member and nothing more", async () => {
    const { db } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const markup = await (await app.get("/add")).text();
      assert.match(markup, /<form method="post" action="\/add" class="card" data-outbox>/);
      assert.match(markup, new RegExp(`<body [^>]*data-member="${RAVI}"`));
      // Other forms are not queued.
      const transfer = await (await app.get("/transfer")).text();
      assert.doesNotMatch(transfer, /data-outbox/);
    } finally { await app.close(); }
  });

  test("a bare or anonymous page carries no member, so the queue is left alone", () => {
    const bare = page({ title: "Sign in", theme: "system", bare: true, memberId: "m-1" }, raw("<p>x</p>"));
    assert.doesNotMatch(bare, /data-member/);
    const anonymous = page({ title: "Budget", theme: "system" }, raw("<p>x</p>"));
    assert.doesNotMatch(anonymous, /data-member/);
  });

  test("signing out tells the browser to clear what the queue kept (R35.5 as amended)", async () => {
    const { db } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const res = await app.post("/signout");
      assert.equal(res.headers.get("clear-site-data"), '"storage"');
    } finally { await app.close(); }
  });
});
