import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import {
  createAccount, recordCardStatement, lastCardStatement, creditedSinceStatement,
} from "./accounts.ts";
import { createTransaction } from "./transactions.ts";
import type { Paise } from "../core/money.ts";

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

/**
 * B127 · A statement that has been paid is not overdue.
 *
 * The Cards screen called a statement late on its due date and every day after,
 * for ever, whether or not it had been paid — so a household that paid in full
 * on the day still read "9 days overdue" a week later. A warning that is wrong
 * when you have done the right thing is worse than no warning: it teaches
 * somebody to stop reading it, which is exactly when the real one slips past.
 *
 * There is no `paid_at` on a statement and there should not be. The ledger
 * already knows.
 */
describe("B127 · what has come off the card since the statement", () => {
  function withStatement(): { db: DB; card: string; bank: string } {
    const fixture = setup();
    createTransaction(fixture.db, actor, {
      accountId: fixture.card, amount: -rupees(9_110) as Paise, date: "2026-08-10",
      payeeName: "Croma", cleared: true,
    });
    recordCardStatement(fixture.db, actor, {
      accountId: fixture.card, statementDate: "2026-08-18", dueDate: "2026-09-05",
      amount: rupees(9_110),
    });
    return fixture;
  }

  test("nothing yet", () => {
    const { db, card } = withStatement();
    assert.equal(creditedSinceStatement(db, card, "2026-08-18"), 0);
  });

  test("a payment on the due date settles it", () => {
    const { db, card } = withStatement();
    createTransaction(db, actor, {
      accountId: card, amount: rupees(9_110) as Paise, date: "2026-09-05",
      memo: "Card payment", cleared: true,
    });
    assert.equal(creditedSinceStatement(db, card, "2026-08-18"), rupees(9_110));
  });

  test("a refund counts too, because the card does not care which it was", () => {
    const { db, card } = withStatement();
    createTransaction(db, actor, {
      accountId: card, amount: rupees(2_000) as Paise, date: "2026-08-25",
      payeeName: "Croma refund", cleared: true,
    });
    assert.equal(creditedSinceStatement(db, card, "2026-08-18"), rupees(2_000));
  });

  test("spending after the statement is not counted against it", () => {
    const { db, card } = withStatement();
    createTransaction(db, actor, {
      accountId: card, amount: -rupees(5_000) as Paise, date: "2026-09-02",
      payeeName: "Swiggy", cleared: true,
    });
    assert.equal(
      creditedSinceStatement(db, card, "2026-08-18"), 0,
      "next month's spending is next month's problem",
    );
  });

  test("nor does a payment made before it was issued", () => {
    const { db, card } = withStatement();
    createTransaction(db, actor, {
      accountId: card, amount: rupees(9_110) as Paise, date: "2026-08-01",
      memo: "Earlier payment", cleared: true,
    });
    assert.equal(creditedSinceStatement(db, card, "2026-08-18"), 0);
  });
});
