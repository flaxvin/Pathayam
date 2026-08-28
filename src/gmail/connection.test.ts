import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { historyFor } from "../core/events.ts";
import { exportEverything } from "../ops/backup.ts";
import {
  saveConnection, getConnection, connectionView, deleteConnection, markFetched,
} from "./connection.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  db.prepare("INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)")
    .run(RAVI, "ravi@example.com", "Ravi", nowIST());
  return db;
}

const TOKEN = "1//refresh-token-SECRET-value";

describe("04 §3.4 · the Gmail connection is a stored secret", () => {
  test("it round-trips", () => {
    const db = setup();
    saveConnection(db, actor, { email: "ravi@example.com", refreshToken: TOKEN, scope: "s" });
    assert.equal(getConnection(db, RAVI)!.refresh_token, TOKEN);
    db.close();
  });

  test("the token never appears in an export", () => {
    const db = setup();
    saveConnection(db, actor, { email: "ravi@example.com", refreshToken: TOKEN, scope: "s" });
    const exported = JSON.stringify(exportEverything(db));
    assert.ok(!exported.includes(TOKEN), "the refresh token must not travel");
    assert.ok(!exported.includes("gmail_connections"));
    db.close();
  });

  test("the token never appears in the event log", () => {
    const db = setup();
    saveConnection(db, actor, { email: "ravi@example.com", refreshToken: TOKEN, scope: "s" });
    const events = JSON.stringify(historyFor(db, "gmail", RAVI));
    assert.ok(!events.includes(TOKEN));
    assert.match(events, /Connected Gmail/);
    db.close();
  });

  test("a screen sees the address, never the token", () => {
    const db = setup();
    saveConnection(db, actor, { email: "ravi@example.com", refreshToken: TOKEN, scope: "s" });
    const view = connectionView(db, RAVI)!;
    assert.equal(view.email, "ravi@example.com");
    assert.ok(!JSON.stringify(view).includes(TOKEN));
    db.close();
  });

  test("disconnecting deletes the token", () => {
    const db = setup();
    saveConnection(db, actor, { email: "ravi@example.com", refreshToken: TOKEN, scope: "s" });
    deleteConnection(db, actor);
    assert.equal(getConnection(db, RAVI), null);
    db.close();
  });

  test("a fetch marks where it got to, so the next reads only what is new", () => {
    const db = setup();
    saveConnection(db, actor, { email: "ravi@example.com", refreshToken: TOKEN, scope: "s" });
    assert.equal(getConnection(db, RAVI)!.last_fetched_at, null);
    markFetched(db, RAVI, "12345");
    assert.ok(getConnection(db, RAVI)!.last_fetched_at);
    db.close();
  });
});
