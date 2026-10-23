/**
 * DEBUG-ENGINE-12 · Undoing a month's reopen closes it again.
 *
 * The undo handler answered "Nothing to undo." for a reopen and marked the
 * event undone, so Activity said the reopen had been reversed while the month
 * stayed open with its close record — the figures and the note — gone. And
 * undoing a second close of an already-closed month deleted the record
 * outright, losing the first close too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne } from "../db/db.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createTransaction } from "./transactions.ts";
import { closeMonth, reopenMonth, isClosed } from "./month-close.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "ravi@example.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2026-07-01",
  });
  createTransaction(db, actor, { accountId: bank.id, amount: rupees(5_000) as Paise, date: "2026-07-02" });
  return db;
}

const latest = (db: ReturnType<typeof setup>, action: string) =>
  queryOne<{ id: string }>(db,
    `SELECT id FROM events WHERE entity = 'month-close' AND action = ? ORDER BY seq DESC LIMIT 1`, action)!.id;

const note = (db: ReturnType<typeof setup>) =>
  queryOne<{ note: string | null }>(db, `SELECT note FROM month_closes WHERE month = '2026-07'`)?.note;

test("undoing a reopen puts the close back, note and all", () => {
  const db = setup();
  closeMonth(db, actor, "2026-07", "Diwali month");
  reopenMonth(db, actor, "2026-07");
  assert.equal(isClosed(db, "2026-07"), false);

  const result = undoEvent(db, latest(db, "reopen"), actor, { force: true });
  assert.equal(result.ok, true);
  assert.equal(isClosed(db, "2026-07"), true, "the month is closed again");
  assert.equal(note(db), "Diwali month");
  db.close();
});

test("undoing a second close keeps the first", () => {
  const db = setup();
  closeMonth(db, actor, "2026-07", "first look");
  closeMonth(db, actor, "2026-07", "second look");
  undoEvent(db, latest(db, "close"), actor, { force: true });
  assert.equal(isClosed(db, "2026-07"), true, "still closed, by the first close");
  assert.equal(note(db), "first look");
  db.close();
});

/*
 * DEBUG-ENGINE-14 · "September is over and not closed yet" is about this
 * budget's September. It counted every budget's transactions, so Ravi's own
 * budget — nothing in it all month — was nagged to close a month the
 * household had used, and a close he did made a record of ₹0 in, ₹0 out.
 */
test("only nudges a budget about a month that budget used", async () => {
  const db = setup();
  const { ensurePersonalBudget, householdBudgetId } = await import("./budgets.ts");
  const { monthAwaitingClose } = await import("./month-close.ts");
  const his = ensurePersonalBudget(db, "m", "Ravi");
  assert.equal(monthAwaitingClose(db, "2026-08-10", householdBudgetId(db)), "2026-07");
  assert.equal(monthAwaitingClose(db, "2026-08-10", his.id), null);
  db.close();
});
