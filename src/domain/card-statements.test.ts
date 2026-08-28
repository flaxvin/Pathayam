import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount, recordCardStatement, lastCardStatement } from "./accounts.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup(): { db: DB; card: string; bank: string } {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  const card = createAccount(db, actor, {
    name: "Axis Atlas", kind: "credit", subtype: "credit-card", openingDate: "2026-01-01",
  }).id;
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(5_00_000),
  }).id;
  return { db, card, bank };
}

describe("F2.3 · credit-card statements", () => {
  test("a statement records and reads back as the latest", () => {
    const { db, card } = setup();
    recordCardStatement(db, actor, {
      accountId: card, statementDate: "2026-08-05", dueDate: "2026-08-25",
      amount: rupees(42_000), minimumDue: rupees(2_100),
    });
    const last = lastCardStatement(db, card);
    assert.ok(last);
    assert.equal(last!.amount, rupees(42_000));
    assert.equal(last!.due_date, "2026-08-25");
    assert.equal(last!.minimum_due, rupees(2_100));
  });

  test("the most recent statement date wins", () => {
    const { db, card } = setup();
    recordCardStatement(db, actor, { accountId: card, statementDate: "2026-07-05", dueDate: "2026-07-25", amount: rupees(10_000) });
    recordCardStatement(db, actor, { accountId: card, statementDate: "2026-08-05", dueDate: "2026-08-25", amount: rupees(20_000) });
    assert.equal(lastCardStatement(db, card)!.amount, rupees(20_000));
  });

  test("only a credit card has a statement", () => {
    const { db, bank } = setup();
    assert.throws(
      () => recordCardStatement(db, actor, { accountId: bank, statementDate: "2026-08-05", dueDate: "2026-08-25", amount: rupees(1000) }),
      /credit card/,
    );
  });

  test("a card with no statement reads back null", () => {
    const { db, card } = setup();
    assert.equal(lastCardStatement(db, card), null);
  });
});
