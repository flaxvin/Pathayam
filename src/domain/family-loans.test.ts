import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { historyFor, undoEvent } from "../core/events.ts";
import { createAccount, getAccount } from "./accounts.ts";
import { accountBalances } from "../engine/repository.ts";
import { createGroup, createCategory, setAssigned } from "./budget.ts";
import { buildBudgetView } from "../web/viewmodel.ts";
import { netWorthStatement } from "./networth.ts";
import {
  createFamilyLoan, recordAdvance, recordRepayment, viewFamilyLoan,
  writeOffFamilyLoan, closeFamilyLoan, listFamilyLoans, familyLoanNetWorth,
} from "./family-loans.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());

  const bank = createAccount(db, actor, {
    name: "HDFC Savings", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(200_000),
  });
  const group = createGroup(db, actor, "Flexible");
  const eatingOut = createCategory(db, actor, { groupId: group.id, name: "Eating Out" });
  const gifts = createCategory(db, actor, { groupId: group.id, name: "Family & gifts" });

  return { db, bank, eatingOut, gifts };
}

describe("10 §3.5 · F2.10 · private lending within the family (B54 · one ledger)", () => {
  test("FL2 · the balance is derived from what moved, and points to who owes whom", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu" });

    recordAdvance(db, actor, {
      loanId: loan.id, amount: rupees(50_000), date: "2026-08-05", fromAccountId: bank.id,
    });
    recordRepayment(db, actor, {
      loanId: loan.id, amount: rupees(20_000), date: "2026-08-20", accountId: bank.id,
    });

    const view = viewFamilyLoan(db, loan.id, "2026-08-28")!;
    assert.equal(view.balance, rupees(30_000), "they owe you the net");
    assert.equal(view.outstanding, rupees(30_000));
    assert.equal(view.owedToYou, true);
    assert.equal(view.paidOut, rupees(50_000));
    assert.equal(view.paidIn, rupees(20_000));

    // There is nowhere to type a balance: the table has no column for one.
    const columns = db.prepare(`PRAGMA table_info(family_loans)`).all() as { name: string }[];
    assert.ok(!columns.some((c) => c.name === "balance" || c.name === "outstanding"));
    db.close();
  });

  test("money out reduces what you have to assign; money in raises it", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu" });

    const before = buildBudgetView(db, "2026-08").monthState.readyToAssign;
    recordAdvance(db, actor, {
      loanId: loan.id, amount: rupees(50_000), date: "2026-08-05", fromAccountId: bank.id,
    });
    // R1: money in someone else's hands is not money you have.
    assert.equal(buildBudgetView(db, "2026-08").monthState.readyToAssign, before - rupees(50_000));

    // They pay you back — it returns to the budget.
    recordRepayment(db, actor, {
      loanId: loan.id, amount: rupees(50_000), date: "2026-08-20", accountId: bank.id,
    });
    assert.equal(buildBudgetView(db, "2026-08").monthState.readyToAssign, before);
    db.close();
  });

  test("you can owe them: money in first, then paying it back", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Appa" });

    const before = buildBudgetView(db, "2026-08").monthState.readyToAssign;
    // They give you money — it lands in the bank and is assignable, but it is a
    // liability, not income.
    recordRepayment(db, actor, {
      loanId: loan.id, amount: rupees(30_000), date: "2026-08-05", accountId: bank.id,
    });
    assert.equal(buildBudgetView(db, "2026-08").monthState.readyToAssign, before + rupees(30_000));

    let view = viewFamilyLoan(db, loan.id, "2026-08-28")!;
    assert.equal(view.owedByYou, true);
    assert.equal(view.balance, -rupees(30_000));
    assert.equal(view.outstanding, rupees(30_000));

    // You pay some back.
    recordAdvance(db, actor, {
      loanId: loan.id, amount: rupees(10_000), date: "2026-08-25", fromAccountId: bank.id,
    });
    view = viewFamilyLoan(db, loan.id, "2026-08-28")!;
    assert.equal(view.outstanding, rupees(20_000));
    assert.equal(view.owedByYou, true);
    db.close();
  });

  test("FL4 · neither leg is spending or income", () => {
    const { db, bank, eatingOut } = setup();
    setAssigned(db, actor, "2026-08", eatingOut.id, rupees(8_000));
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu" });
    recordAdvance(db, actor, { loanId: loan.id, amount: rupees(50_000), date: "2026-08-05", fromAccountId: bank.id });
    recordRepayment(db, actor, { loanId: loan.id, amount: rupees(50_000), date: "2026-08-20", accountId: bank.id });

    const view = buildBudgetView(db, "2026-08");
    const spent = [...view.categories.values()].reduce((sum, c) => sum + c.state.activity, 0);
    assert.equal(spent, 0, "both legs are transfers");
    db.close();
  });

  test("B54 · being repaid more than was lent does not break — the balance just flips", () => {
    const { db, bank, gifts } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu" });
    recordAdvance(db, actor, { loanId: loan.id, amount: rupees(50_000), date: "2026-06-10", fromAccountId: bank.id });
    // They overpay — they gave back ₹60,000 against ₹50,000 lent.
    recordRepayment(db, actor, { loanId: loan.id, amount: rupees(60_000), date: "2026-07-10", accountId: bank.id });

    const view = viewFamilyLoan(db, loan.id, "2026-08-28")!;
    assert.equal(view.balance, -rupees(10_000), "now you owe them the ₹10,000 overpaid");
    assert.equal(view.outstanding, rupees(10_000));
    assert.equal(view.owedByYou, true);
    assert.equal(view.settled, false);

    // The write-off used to break here (outstanding was forced positive and
    // booked as an expense). Now it records the ₹10,000 as income and closes.
    setAssigned(db, actor, "2026-08", gifts.id, 0);
    const amount = writeOffFamilyLoan(db, actor, { loanId: loan.id, categoryId: gifts.id, date: "2026-08-15" });
    assert.equal(amount, rupees(10_000));
    const budget = buildBudgetView(db, "2026-08");
    assert.equal(budget.categories.get(gifts.id)!.state.activity, rupees(10_000), "income, not an expense");
    assert.equal(viewFamilyLoan(db, loan.id, "2026-08-28")!.outstanding, 0);
    db.close();
  });

  test("FL6 · what is outstanding, since when, and what last moved", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu" });
    recordAdvance(db, actor, { loanId: loan.id, amount: rupees(50_000), date: "2026-06-10", fromAccountId: bank.id });
    recordAdvance(db, actor, { loanId: loan.id, amount: rupees(10_000), date: "2026-07-01", fromAccountId: bank.id });
    recordRepayment(db, actor, { loanId: loan.id, amount: rupees(15_000), date: "2026-08-02", accountId: bank.id });

    const view = viewFamilyLoan(db, loan.id, "2026-08-28")!;
    assert.equal(view.firstMovement, "2026-06-10", "since when — the first, not the latest");
    assert.deepEqual(view.lastMovement, { date: "2026-08-02", amount: rupees(15_000), incoming: true });
    assert.equal(view.daysOutstanding, 79);
    assert.equal(view.outstanding, rupees(45_000));
    db.close();
  });

  test("a settled arrangement says so, and stops counting days", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu" });
    recordAdvance(db, actor, { loanId: loan.id, amount: rupees(5_000), date: "2026-06-10", fromAccountId: bank.id });
    recordRepayment(db, actor, { loanId: loan.id, amount: rupees(5_000), date: "2026-08-02", accountId: bank.id });

    const view = viewFamilyLoan(db, loan.id, "2026-08-28")!;
    assert.equal(view.settled, true);
    assert.equal(view.outstanding, 0);
    assert.equal(view.daysOutstanding, null);
    db.close();
  });

  test("FL5 · an agreed total, not a rate", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu", agreedTotal: rupees(55_000) });
    recordAdvance(db, actor, { loanId: loan.id, amount: rupees(50_000), date: "2026-06-10", fromAccountId: bank.id });
    recordRepayment(db, actor, { loanId: loan.id, amount: rupees(20_000), date: "2026-08-02", accountId: bank.id });

    const view = viewFamilyLoan(db, loan.id, "2026-08-28")!;
    assert.equal(view.outstanding, rupees(30_000));
    assert.equal(view.agreedOutstanding, rupees(35_000));

    const columns = db.prepare(`PRAGMA table_info(family_loans)`).all() as { name: string }[];
    for (const absent of ["rate", "interest_rate", "tenure_months", "emi"]) {
      assert.ok(!columns.some((c) => c.name === absent), `${absent} must not exist`);
    }
    db.close();
  });

  test("FL7 · writing off a debt owed to you is an expense, and keeps the history", () => {
    const { db, bank, gifts } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu" });
    recordAdvance(db, actor, { loanId: loan.id, amount: rupees(50_000), date: "2026-06-10", fromAccountId: bank.id });
    recordRepayment(db, actor, { loanId: loan.id, amount: rupees(20_000), date: "2026-07-02", accountId: bank.id });
    setAssigned(db, actor, "2026-08", gifts.id, rupees(30_000));

    const written = writeOffFamilyLoan(db, actor, { loanId: loan.id, categoryId: gifts.id, date: "2026-08-15" });
    assert.equal(written, rupees(30_000));

    const view = buildBudgetView(db, "2026-08");
    assert.equal(view.categories.get(gifts.id)!.state.activity, -rupees(30_000), "the write-off is the one expense");

    const after = viewFamilyLoan(db, loan.id, "2026-08-28")!;
    assert.equal(after.paidOut, rupees(50_000), "P4: the movements are still there");
    assert.equal(after.paidIn, rupees(20_000));
    assert.equal(after.outstanding, 0);
    assert.equal(after.writtenOff, true);
    db.close();
  });

  test("a debt you owed, forgiven, is recorded as income", () => {
    const { db, bank, gifts } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Appa" });
    // They gave you ₹30,000; you now owe them.
    recordRepayment(db, actor, { loanId: loan.id, amount: rupees(30_000), date: "2026-06-10", accountId: bank.id });

    const written = writeOffFamilyLoan(db, actor, { loanId: loan.id, categoryId: gifts.id, date: "2026-08-15" });
    assert.equal(written, rupees(30_000));
    assert.equal(buildBudgetView(db, "2026-08").categories.get(gifts.id)!.state.activity, rupees(30_000), "income");
    db.close();
  });

  test("R37 · a write-off undoes", () => {
    const { db, bank, gifts } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu" });
    recordAdvance(db, actor, { loanId: loan.id, amount: rupees(50_000), date: "2026-06-10", fromAccountId: bank.id });
    writeOffFamilyLoan(db, actor, { loanId: loan.id, categoryId: gifts.id, date: "2026-08-15" });

    const event = historyFor(db, "family-loan", loan.id).find((e) => e.action === "write-off")!;
    undoEvent(db, event.id, actor);

    const view = viewFamilyLoan(db, loan.id, "2026-08-28")!;
    assert.equal(view.writtenOff, false);
    assert.equal(view.outstanding, rupees(50_000), "the balance comes back");
    assert.equal(buildBudgetView(db, "2026-08").categories.get(gifts.id)!.state.activity, 0);
    db.close();
  });

  test("FL8 · it counts in net worth, on the side the balance points", () => {
    const { db, bank } = setup();
    const theyOwe = createFamilyLoan(db, actor, { counterparty: "Ammu" });
    const youOwe = createFamilyLoan(db, actor, { counterparty: "Appa" });

    recordAdvance(db, actor, { loanId: theyOwe.id, amount: rupees(50_000), date: "2026-08-05", fromAccountId: bank.id });
    recordRepayment(db, actor, { loanId: youOwe.id, amount: rupees(30_000), date: "2026-08-06", accountId: bank.id });

    const split = familyLoanNetWorth(db);
    assert.equal(split.lent[0]!.value, rupees(50_000));
    assert.equal(split.borrowed[0]!.value, rupees(30_000));

    const statement = netWorthStatement(db, "2026-08-28");
    const assets = statement.assetGroups.flatMap((g) => g.lines);
    const liabilities = statement.liabilityGroups.flatMap((g) => g.lines);
    assert.ok(assets.some((l) => l.label === "Ammu owes you" && l.value === rupees(50_000)));
    assert.ok(liabilities.some((l) => l.label === "You owe Appa" && l.value === rupees(30_000)));
    db.close();
  });

  test("FW3 · it never appears on the budget screen", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu" });
    recordAdvance(db, actor, { loanId: loan.id, amount: rupees(50_000), date: "2026-08-05", fromAccountId: bank.id });
    const view = buildBudgetView(db, "2026-08");
    assert.ok(![...view.categories.values()].some((c) => c.name.includes("Ammu")));
    db.close();
  });

  test("a settled arrangement can be closed, keeping every transaction", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu" });
    recordAdvance(db, actor, { loanId: loan.id, amount: rupees(5_000), date: "2026-06-10", fromAccountId: bank.id });
    recordRepayment(db, actor, { loanId: loan.id, amount: rupees(5_000), date: "2026-08-02", accountId: bank.id });

    closeFamilyLoan(db, actor, loan.id);
    assert.equal(listFamilyLoans(db).length, 0);
    assert.equal(listFamilyLoans(db, { includeClosed: true }).length, 1);
    assert.equal(viewFamilyLoan(db, loan.id, "2026-08-28")!.paidOut, rupees(5_000), "history survives closing");
    db.close();
  });

  test("an amount must be a real amount", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu" });
    assert.throws(
      () => recordAdvance(db, actor, { loanId: loan.id, amount: 0, fromAccountId: bank.id }),
      /greater than zero/,
    );
    db.close();
  });

  test("there is nothing to write off when the balance is zero", () => {
    const { db, bank, gifts } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu" });
    recordAdvance(db, actor, { loanId: loan.id, amount: rupees(5_000), date: "2026-06-10", fromAccountId: bank.id });
    recordRepayment(db, actor, { loanId: loan.id, amount: rupees(5_000), date: "2026-07-10", accountId: bank.id });
    assert.throws(
      () => writeOffFamilyLoan(db, actor, { loanId: loan.id, categoryId: gifts.id }),
      /Nothing is outstanding/,
    );
    db.close();
  });
});

describe("H2 / H2.2 · whose arrangement it is", () => {
  /**
   * `14` §6.2 put private assets and loans in the cheap 80%, and the domain has
   * carried holderMemberId and visibility ever since — but the form never asked,
   * so money lent to *your* cousin was always the household's and visible to
   * everyone. Assets and loans both offered it; this was the one that did not.
   */
  test("an arrangement can be one member's, and private to them", () => {
    const { db } = setup();
    const mine = createFamilyLoan(db, actor, {
      counterparty: "Cousin — Arun",
      holderMemberId: RAVI, visibility: "private",
    });

    const view = viewFamilyLoan(db, mine.id)!;
    assert.equal(view.holderMemberId, RAVI);
    assert.equal(view.isPrivate, true);
  });

  test("and defaults to the household's, visible to everyone", () => {
    const { db } = setup();
    const shared = createFamilyLoan(db, actor, { counterparty: "Neighbour" });
    const view = viewFamilyLoan(db, shared.id)!;
    assert.equal(view.holderMemberId, null);
    assert.equal(view.isPrivate, false);
  });
});

/*
 * WEALTH-29 / MONEY-CORE-4 / MONEY-CORE-25 · Undoing lending moves the money back.
 *
 * Advances and repayments answered "Nothing to undo." and were then marked
 * undone — the log said ₹50,000 to a cousin was reversed while the bank stayed
 * down and the cousin still owed it. Undoing a close reopened the arrangement
 * but left its account closed, off /accounts while advances kept landing in it.
 */
describe("WEALTH-29 · undoing lending reverses it, or refuses", () => {
  const working = (db: ReturnType<typeof setup>["db"], id: string) =>
    accountBalances(db).get(id)?.working ?? 0;
  const eventFor = (db: ReturnType<typeof setup>["db"], loanId: string, action: string) =>
    historyFor(db, "family-loan", loanId).find((e) => e.action === action)!;

  test("an advance undone puts the money back in the bank and nothing is owed", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Cousin Fictional" });
    recordAdvance(db, actor, { loanId: loan.id, amount: rupees(50_000), date: "2026-08-05", fromAccountId: bank.id });
    assert.equal(working(db, bank.id), rupees(150_000));

    const result = undoEvent(db, eventFor(db, loan.id, "advance").id, actor);
    assert.ok(result.ok, result.reason);
    assert.equal(working(db, bank.id), rupees(200_000), "the bank is whole again");
    assert.equal(viewFamilyLoan(db, loan.id, "2026-08-28")!.outstanding, 0, "and nothing is owed");
    db.close();
  });

  test("a repayment undone takes the money back out of the bank", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Cousin Fictional" });
    recordAdvance(db, actor, { loanId: loan.id, amount: rupees(50_000), date: "2026-08-05", fromAccountId: bank.id });
    recordRepayment(db, actor, { loanId: loan.id, amount: rupees(20_000), date: "2026-08-20", accountId: bank.id });

    const result = undoEvent(db, eventFor(db, loan.id, "repayment").id, actor, { force: true });
    assert.ok(result.ok, result.reason);
    assert.equal(working(db, bank.id), rupees(150_000));
    assert.equal(viewFamilyLoan(db, loan.id, "2026-08-28")!.outstanding, rupees(50_000));
    db.close();
  });

  test("an advance from before the event carried its legs is refused, not marked undone", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Cousin Fictional" });
    recordAdvance(db, actor, { loanId: loan.id, amount: rupees(50_000), date: "2026-08-05", fromAccountId: bank.id });
    const event = eventFor(db, loan.id, "advance");
    execute(db, `UPDATE events SET after_json = ? WHERE id = ?`, JSON.stringify({ amount: rupees(50_000) }), event.id);

    assert.throws(() => undoEvent(db, event.id, actor), /recorded before undo could reverse it/);
    assert.equal(eventFor(db, loan.id, "advance").undoneByEventId ?? null, null);
    assert.equal(working(db, bank.id), rupees(150_000));
    db.close();
  });

  test("undoing a close reopens the arrangement and its account", () => {
    const { db } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Cousin Fictional" });
    closeFamilyLoan(db, actor, loan.id);
    const result = undoEvent(db, eventFor(db, loan.id, "close").id, actor);
    assert.ok(result.ok, result.reason);
    assert.equal(listFamilyLoans(db).find((l) => l.id === loan.id)!.closed_at, null);
    assert.equal(getAccount(db, loan.account_id)!.closed_at, null, "the account stayed closed");
    db.close();
  });

  test("undoing the start removes an empty arrangement, and refuses one with money behind it", () => {
    const { db, bank } = setup();
    const empty = createFamilyLoan(db, actor, { counterparty: "Cousin Fictional" });
    assert.ok(undoEvent(db, eventFor(db, empty.id, "create").id, actor).ok);
    assert.equal(getAccount(db, empty.account_id), null);

    const used = createFamilyLoan(db, actor, { counterparty: "Aunt Fictional" });
    recordAdvance(db, actor, { loanId: used.id, amount: rupees(10_000), date: "2026-08-05", fromAccountId: bank.id });
    assert.throws(
      () => undoEvent(db, eventFor(db, used.id, "create").id, actor, { force: true }),
      /already has money recorded against it/,
    );
    assert.ok(getAccount(db, used.account_id));
    db.close();
  });
});

describe("WEALTH-30 · an arrangement closes only when nothing is owed", () => {
  test("closing while the cousin owes ₹50,000 is refused, and it stays in net worth", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Cousin Fictional" });
    recordAdvance(db, actor, { loanId: loan.id, amount: rupees(50_000), date: "2026-08-05", fromAccountId: bank.id });
    const worth = netWorthStatement(db, "2026-08-28").netWorth;

    assert.throws(() => closeFamilyLoan(db, actor, loan.id), /still owes ₹50,000/);
    assert.equal(listFamilyLoans(db).length, 1, "still open");
    assert.equal(netWorthStatement(db, "2026-08-28").netWorth, worth);
    db.close();
  });

  test("and the other way: while the household owes them", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Aunt Fictional" });
    recordRepayment(db, actor, { loanId: loan.id, amount: rupees(20_000), date: "2026-08-05", accountId: bank.id });
    assert.throws(() => closeFamilyLoan(db, actor, loan.id), /You still owe Aunt Fictional ₹20,000/);
    db.close();
  });
});
