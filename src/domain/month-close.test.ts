import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned } from "./budget.ts";
import { createTransaction, createTransfer } from "./transactions.ts";
import { undoEvent, historyFor } from "../core/events.ts";
import {
  monthCloseView, closeMonth, reopenMonth, closedMonths, monthAwaitingClose, isClosed,
} from "./month-close.ts";
import { digestFor, setMutedKinds, mutedKinds } from "./digest.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());

  const bank = createAccount(db, actor, {
    name: "HDFC Savings", kind: "budget", subtype: "savings",
    openingDate: "2026-07-01", openingBalance: rupees(0),
  });
  const group = createGroup(db, actor, "Flexible");
  const eatingOut = createCategory(db, actor, { groupId: group.id, name: "Eating Out" });
  const rent = createCategory(db, actor, { groupId: group.id, name: "Rent" });

  return { db, bank, group, eatingOut, rent };
}

function july(db: DB, bank: string, eatingOut: string, rent: string) {
  createTransaction(db, actor, {
    accountId: bank, amount: rupees(145_000), date: "2026-07-01", cleared: true,
  });
  setAssigned(db, actor, "2026-07", eatingOut, rupees(8_000));
  setAssigned(db, actor, "2026-07", rent, rupees(45_000));
  createTransaction(db, actor, {
    accountId: bank, amount: rupees(-6_500), date: "2026-07-10",
    categoryId: eatingOut, cleared: true,
  });
  createTransaction(db, actor, {
    accountId: bank, amount: rupees(-45_000), date: "2026-07-05",
    categoryId: rent, cleared: true,
  });
}

describe("08 S5 · the month-close ritual", () => {
  test("reports what the month did", () => {
    const { db, bank, eatingOut, rent } = setup();
    july(db, bank.id, eatingOut.id, rent.id);

    const view = monthCloseView(db, "2026-07", "2026-08-15");

    assert.equal(view.outcome.income, rupees(145_000));
    assert.equal(view.outcome.spending, rupees(51_500));
    assert.equal(view.outcome.net, rupees(93_500));
    assert.equal(view.outcome.assigned, rupees(53_000));
    assert.equal(view.outcome.transactionCount, 3);
    assert.equal(Math.round(view.outcome.savingsRate! * 100), 64);

    assert.deepEqual(
      view.outcome.biggestCategories.map((c) => [c.name, c.amount]),
      [["Rent", rupees(45_000)], ["Eating Out", rupees(6_500)]],
    );
    db.close();
  });

  test("a transfer is neither income nor spending", () => {
    const { db, bank, eatingOut, rent } = setup();
    july(db, bank.id, eatingOut.id, rent.id);

    const savings = createAccount(db, actor, {
      name: "Savings", kind: "budget", subtype: "savings", openingDate: "2026-07-01",
    });
    // Moving money between your own accounts must not read as ₹50,000 of
    // income and ₹50,000 of spending — it would make every month look wrong.
    createTransfer(db, actor, {
      fromAccountId: bank.id, toAccountId: savings.id,
      amount: rupees(50_000), date: "2026-07-20",
    });

    const view = monthCloseView(db, "2026-07", "2026-08-15");
    assert.equal(view.outcome.income, rupees(145_000));
    assert.equal(view.outcome.spending, rupees(51_500));
    assert.equal(view.outcome.transactionCount, 3);
    db.close();
  });

  test("no income means no savings rate, rather than a rate against zero", () => {
    const { db, bank, eatingOut } = setup();
    createTransaction(db, actor, {
      accountId: bank.id, amount: rupees(-500), date: "2026-07-10",
      categoryId: eatingOut.id, cleared: true,
    });
    assert.equal(monthCloseView(db, "2026-07", "2026-08-15").outcome.savingsRate, null);
    db.close();
  });

  test("closing changes nothing about the month", () => {
    const { db, bank, eatingOut, rent } = setup();
    july(db, bank.id, eatingOut.id, rent.id);

    const before = monthCloseView(db, "2026-07", "2026-08-15");
    closeMonth(db, actor, "2026-07");
    const after = monthCloseView(db, "2026-07", "2026-08-15");

    // R13's rollover is derived arithmetic, not a job, so a close has nothing
    // to advance. It records attention; it does not change a figure.
    assert.deepEqual(after.outcome, before.outcome);
    assert.deepEqual(after.next, before.next);
    assert.ok(after.closedAt);
    assert.equal(after.closedBy, "Ravi");
    db.close();
  });

  test("R7.g · a past month stays editable after it is closed", () => {
    const { db, bank, eatingOut, rent } = setup();
    july(db, bank.id, eatingOut.id, rent.id);
    closeMonth(db, actor, "2026-07");

    createTransaction(db, actor, {
      accountId: bank.id, amount: rupees(-1_000), date: "2026-07-25",
      categoryId: eatingOut.id, cleared: true,
    });

    // Closing is a statement about attention, not a lock. The receipt that
    // turns up a week later still goes in.
    const view = monthCloseView(db, "2026-07", "2026-08-15");
    assert.equal(view.outcome.spending, rupees(52_500));
    assert.ok(view.closedAt, "and it is still closed");
    db.close();
  });

  test("closing twice is harmless", () => {
    const { db, bank, eatingOut, rent } = setup();
    july(db, bank.id, eatingOut.id, rent.id);

    closeMonth(db, actor, "2026-07");
    closeMonth(db, actor, "2026-07", "second time");

    assert.equal(closedMonths(db).length, 1);
    assert.equal(
      queryOne<{ note: string }>(db, `SELECT note FROM month_closes WHERE month = ?`, "2026-07")!.note,
      "second time",
    );
    db.close();
  });

  test("reopening clears the record", () => {
    const { db, bank, eatingOut, rent } = setup();
    july(db, bank.id, eatingOut.id, rent.id);

    closeMonth(db, actor, "2026-07");
    assert.equal(isClosed(db, "2026-07"), true);

    reopenMonth(db, actor, "2026-07");
    assert.equal(isClosed(db, "2026-07"), false);
    db.close();
  });

  test("R37 · a close undoes like anything else", () => {
    const { db, bank, eatingOut, rent } = setup();
    july(db, bank.id, eatingOut.id, rent.id);
    closeMonth(db, actor, "2026-07");

    const event = historyFor(db, "month-close", "2026-07")[0]!;
    undoEvent(db, event.id, actor);

    assert.equal(isClosed(db, "2026-07"), false);
    db.close();
  });

  test("only nudges about a month that was actually used", () => {
    const { db, bank, eatingOut, rent } = setup();

    // A fresh install must not open on "you have not closed July".
    assert.equal(monthAwaitingClose(db, "2026-08-15"), null);

    july(db, bank.id, eatingOut.id, rent.id);
    assert.equal(monthAwaitingClose(db, "2026-08-15"), "2026-07");

    closeMonth(db, actor, "2026-07");
    assert.equal(monthAwaitingClose(db, "2026-08-15"), null);
    db.close();
  });

  test("says whether the new month is funded", () => {
    const { db, bank, eatingOut, rent } = setup();
    july(db, bank.id, eatingOut.id, rent.id);

    const view = monthCloseView(db, "2026-07", "2026-08-15");
    assert.equal(view.next.month, "2026-08");

    // ₹1,45,000 came in and ₹53,000 was assigned, so ₹92,000 was never given a
    // job and carries forward (R4). Deliberately *not* ₹93,500: the ₹1,500
    // Eating Out did not spend stays in Eating Out, and does not come back to
    // Ready to Assign — that is the whole point of an envelope.
    assert.equal(view.next.readyToAssign, rupees(92_000));
    db.close();
  });

  test("a month still running says so", () => {
    const { db, bank, eatingOut, rent } = setup();
    july(db, bank.id, eatingOut.id, rent.id);

    assert.equal(monthCloseView(db, "2026-07", "2026-07-15").stillRunning, true);
    assert.equal(monthCloseView(db, "2026-07", "2026-08-15").stillRunning, false);
    db.close();
  });

  test("works with no assets configured at all", () => {
    // A ritual that fails because there is no portfolio is a ritual nobody
    // performs.
    const { db, bank, eatingOut, rent } = setup();
    july(db, bank.id, eatingOut.id, rent.id);

    const view = monthCloseView(db, "2026-07", "2026-08-15");
    assert.equal(view.netWorth, null);
    assert.doesNotThrow(() => closeMonth(db, actor, "2026-07"));
    db.close();
  });
});

describe("02 F14 · the digest", () => {
  test("F14.5 · nothing to act on means nothing is shown", () => {
    const { db } = setup();
    // No streaks, no encouragement, no "you have not opened the app in a week".
    assert.deepEqual(digestFor(db, RAVI, "2026-08-15"), []);
    db.close();
  });

  test("an unfunded card balance is raised, and marked urgent", () => {
    const { db, bank } = setup();
    const card = createAccount(db, actor, {
      name: "HDFC Regalia", kind: "credit", subtype: "credit-card",
      openingDate: "2026-08-01", openingBalance: rupees(-12_000),
    });
    void bank;

    const items = digestFor(db, RAVI, "2026-08-15");
    const cardItem = items.find((i) => i.kind === "card-due");
    assert.ok(cardItem, "an unfunded card is the thing most worth saying");
    assert.match(cardItem!.text, /HDFC Regalia/);
    assert.equal(cardItem!.urgent, true);
    assert.equal(cardItem!.href, `/accounts/${card.id}`);
    db.close();
  });

  test("a month waiting to be closed appears", () => {
    const { db, bank, eatingOut, rent } = setup();
    july(db, bank.id, eatingOut.id, rent.id);

    const items = digestFor(db, RAVI, "2026-08-15");
    const close = items.find((i) => i.kind === "month-close");
    assert.ok(close);
    assert.match(close!.text, /July 2026/);
    db.close();
  });

  test("F14.2 · a muted kind disappears, and the default is on", () => {
    const { db, bank, eatingOut, rent } = setup();
    july(db, bank.id, eatingOut.id, rent.id);

    assert.equal(mutedKinds(db, RAVI).size, 0, "a member who never opened settings gets everything");
    assert.ok(digestFor(db, RAVI, "2026-08-15").some((i) => i.kind === "month-close"));

    setMutedKinds(db, actor, ["month-close"]);
    assert.ok(!digestFor(db, RAVI, "2026-08-15").some((i) => i.kind === "month-close"));

    // And it is per member: nobody else's choice is affected.
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
      "m-priya", "priya@example.com", "Priya", nowIST());
    assert.ok(digestFor(db, "m-priya", "2026-08-15").some((i) => i.kind === "month-close"));
    db.close();
  });

  test("unmuting is possible", () => {
    const { db, bank, eatingOut, rent } = setup();
    july(db, bank.id, eatingOut.id, rent.id);

    setMutedKinds(db, actor, ["month-close"]);
    setMutedKinds(db, actor, []);
    assert.ok(digestFor(db, RAVI, "2026-08-15").some((i) => i.kind === "month-close"));
    db.close();
  });

  test("a review queue that turns over daily is not nagged about", () => {
    const { db, bank } = setup();
    execute(
      db,
      `INSERT INTO import_batches (id,source,adapter,account_id,created_at,rows_read)
       VALUES ('b1','csv','csv',?,?,1)`,
      bank.id, nowIST(),
    );
    execute(
      db,
      `INSERT INTO staged_transactions
         (id,batch_id,account_id,date,amount,raw_narration,status,created_at)
       VALUES (?,?,?,?,?,?,'pending',?)`,
      "s1", "b1", bank.id, "2026-08-14", rupees(-450), "SWIGGY", "2026-08-14T10:00:00+05:30",
    );

    // One day old: being used, not ignored.
    assert.ok(!digestFor(db, RAVI, "2026-08-15").some((i) => i.kind === "review-waiting"));
    // Five days old: worth mentioning.
    assert.ok(digestFor(db, RAVI, "2026-08-19").some((i) => i.kind === "review-waiting"));
    db.close();
  });
});
