import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { historyFor, undoEvent } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned } from "./budget.ts";
import { createTransaction } from "./transactions.ts";
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

describe("10 §3.5 · F2.10 · private lending within the family", () => {
  test("FL2 · the outstanding balance is derived, never typed", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu", direction: "lent" });

    recordAdvance(db, actor, {
      loanId: loan.id, amount: rupees(50_000), date: "2026-08-05", fromAccountId: bank.id,
    });
    recordRepayment(db, actor, {
      loanId: loan.id, amount: rupees(20_000), date: "2026-08-20", accountId: bank.id,
    });

    const view = viewFamilyLoan(db, loan.id, "2026-08-28")!;
    assert.equal(view.outstanding, rupees(30_000));
    assert.equal(view.advanced, rupees(50_000));
    assert.equal(view.repaid, rupees(20_000));

    // There is nowhere to type a balance: the table has no column for one.
    const columns = db.prepare(`PRAGMA table_info(family_loans)`).all() as { name: string }[];
    assert.ok(!columns.some((c) => c.name === "balance" || c.name === "outstanding"));
    db.close();
  });

  test("FL3 · lending really does reduce what you have to assign", () => {
    const { db, bank } = setup();
    const before = buildBudgetView(db, "2026-08").monthState.readyToAssign;

    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu", direction: "lent" });
    recordAdvance(db, actor, {
      loanId: loan.id, amount: rupees(50_000), date: "2026-08-05", fromAccountId: bank.id,
    });

    // R1: Ready to Assign is money you have. Money in someone else's hands is
    // not money you have.
    const after = buildBudgetView(db, "2026-08").monthState.readyToAssign;
    assert.equal(after, before - rupees(50_000));
    db.close();
  });

  test("FL4 · lending is not spending, and repayment is not income", () => {
    const { db, bank, eatingOut } = setup();
    setAssigned(db, actor, "2026-08", eatingOut.id, rupees(8_000));

    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu", direction: "lent" });
    recordAdvance(db, actor, {
      loanId: loan.id, amount: rupees(50_000), date: "2026-08-05", fromAccountId: bank.id,
    });
    recordRepayment(db, actor, {
      loanId: loan.id, amount: rupees(50_000), date: "2026-08-20", accountId: bank.id,
    });

    const view = buildBudgetView(db, "2026-08");

    // No envelope was consumed on the way out...
    const category = view.categories.get(eatingOut.id)!;
    assert.equal(category.state.activity, 0);

    // ...and nothing was earned on the way back. Both legs are transfers, so
    // the month's income and spending are untouched.
    const spent = [...view.categories.values()].reduce((sum, c) => sum + c.state.activity, 0);
    assert.equal(spent, 0);
    db.close();
  });

  test("borrowing works in the other direction", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Appa", direction: "borrowed" });

    const before = buildBudgetView(db, "2026-08").monthState.readyToAssign;
    recordAdvance(db, actor, {
      loanId: loan.id, amount: rupees(30_000), date: "2026-08-05", fromAccountId: bank.id,
    });

    // Money borrowed arrives in the bank and is assignable — but it is a
    // liability, not income.
    assert.equal(buildBudgetView(db, "2026-08").monthState.readyToAssign, before + rupees(30_000));

    const view = viewFamilyLoan(db, loan.id, "2026-08-28")!;
    assert.equal(view.outstanding, rupees(30_000));
    assert.equal(view.advanced, rupees(30_000));

    recordRepayment(db, actor, {
      loanId: loan.id, amount: rupees(10_000), date: "2026-08-25", accountId: bank.id,
    });
    assert.equal(viewFamilyLoan(db, loan.id, "2026-08-28")!.outstanding, rupees(20_000));
    db.close();
  });

  test("FL6 · what is outstanding, since when, and what was last repaid", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu", direction: "lent" });

    recordAdvance(db, actor, {
      loanId: loan.id, amount: rupees(50_000), date: "2026-06-10", fromAccountId: bank.id,
    });
    recordAdvance(db, actor, {
      loanId: loan.id, amount: rupees(10_000), date: "2026-07-01", fromAccountId: bank.id,
    });
    recordRepayment(db, actor, {
      loanId: loan.id, amount: rupees(15_000), date: "2026-08-02", accountId: bank.id,
    });

    const view = viewFamilyLoan(db, loan.id, "2026-08-28")!;
    assert.equal(view.firstAdvance, "2026-06-10", "since when — the first, not the latest");
    assert.deepEqual(view.lastRepayment, { date: "2026-08-02", amount: rupees(15_000) });
    assert.equal(view.daysOutstanding, 79);
    assert.equal(view.outstanding, rupees(45_000));
    db.close();
  });

  test("a settled arrangement says so, and stops counting days", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu", direction: "lent" });

    recordAdvance(db, actor, {
      loanId: loan.id, amount: rupees(5_000), date: "2026-06-10", fromAccountId: bank.id,
    });
    recordRepayment(db, actor, {
      loanId: loan.id, amount: rupees(5_000), date: "2026-08-02", accountId: bank.id,
    });

    const view = viewFamilyLoan(db, loan.id, "2026-08-28")!;
    assert.equal(view.settled, true);
    assert.equal(view.outstanding, 0);
    // N18: nothing has been outstanding for 79 days, because nothing is.
    assert.equal(view.daysOutstanding, null);
    db.close();
  });

  test("FL5 · an agreed total, not a rate", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, {
      counterparty: "Ammu", direction: "lent", agreedTotal: rupees(55_000),
    });

    recordAdvance(db, actor, {
      loanId: loan.id, amount: rupees(50_000), date: "2026-06-10", fromAccountId: bank.id,
    });
    recordRepayment(db, actor, {
      loanId: loan.id, amount: rupees(20_000), date: "2026-08-02", accountId: bank.id,
    });

    const view = viewFamilyLoan(db, loan.id, "2026-08-28")!;
    // The cash outstanding and what is owed under the agreement differ, and
    // both are shown rather than one being derived away.
    assert.equal(view.outstanding, rupees(30_000));
    assert.equal(view.agreedOutstanding, rupees(35_000));

    // There is nowhere to put a rate or a tenure — 06's machinery does not
    // apply, and offering it would be a lie.
    const columns = db.prepare(`PRAGMA table_info(family_loans)`).all() as { name: string }[];
    for (const absent of ["rate", "interest_rate", "tenure_months", "emi"]) {
      assert.ok(!columns.some((c) => c.name === absent), `${absent} must not exist`);
    }
    db.close();
  });

  test("FL7 · a write-off is an expense, and keeps the history", () => {
    const { db, bank, gifts } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu", direction: "lent" });

    recordAdvance(db, actor, {
      loanId: loan.id, amount: rupees(50_000), date: "2026-06-10", fromAccountId: bank.id,
    });
    recordRepayment(db, actor, {
      loanId: loan.id, amount: rupees(20_000), date: "2026-07-02", accountId: bank.id,
    });
    setAssigned(db, actor, "2026-08", gifts.id, rupees(30_000));

    const written = writeOffFamilyLoan(db, actor, {
      loanId: loan.id, categoryId: gifts.id, date: "2026-08-15",
    });
    assert.equal(written, rupees(30_000));

    // This is FL4's one exception: the write-off *is* an expense.
    const view = buildBudgetView(db, "2026-08");
    assert.equal(view.categories.get(gifts.id)!.state.activity, -rupees(30_000));

    // P4: both advances are still there.
    const after = viewFamilyLoan(db, loan.id, "2026-08-28")!;
    assert.equal(after.advanced, rupees(50_000));
    assert.equal(after.repaid, rupees(20_000));
    assert.equal(after.outstanding, 0);
    assert.equal(after.writtenOff, true);
    db.close();
  });

  test("a forgiven debt you owed is not an expense, and says so", () => {
    const { db, bank, gifts } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Appa", direction: "borrowed" });
    recordAdvance(db, actor, {
      loanId: loan.id, amount: rupees(30_000), date: "2026-06-10", fromAccountId: bank.id,
    });

    assert.throws(
      () => writeOffFamilyLoan(db, actor, { loanId: loan.id, categoryId: gifts.id }),
      /record it as income/,
    );
    db.close();
  });

  test("R37 · a write-off undoes", () => {
    const { db, bank, gifts } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu", direction: "lent" });
    recordAdvance(db, actor, {
      loanId: loan.id, amount: rupees(50_000), date: "2026-06-10", fromAccountId: bank.id,
    });
    writeOffFamilyLoan(db, actor, { loanId: loan.id, categoryId: gifts.id, date: "2026-08-15" });

    const event = historyFor(db, "family-loan", loan.id)
      .find((e) => e.action === "write-off")!;
    undoEvent(db, event.id, actor);

    const view = viewFamilyLoan(db, loan.id, "2026-08-28")!;
    assert.equal(view.writtenOff, false);
    assert.equal(view.outstanding, rupees(50_000), "the balance comes back");
    assert.equal(buildBudgetView(db, "2026-08").categories.get(gifts.id)!.state.activity, 0);
    db.close();
  });

  test("FL8 · it counts in net worth, on the correct side", () => {
    const { db, bank } = setup();
    const lent = createFamilyLoan(db, actor, { counterparty: "Ammu", direction: "lent" });
    const borrowed = createFamilyLoan(db, actor, { counterparty: "Appa", direction: "borrowed" });

    recordAdvance(db, actor, {
      loanId: lent.id, amount: rupees(50_000), date: "2026-08-05", fromAccountId: bank.id,
    });
    recordAdvance(db, actor, {
      loanId: borrowed.id, amount: rupees(30_000), date: "2026-08-06", fromAccountId: bank.id,
    });

    const split = familyLoanNetWorth(db);
    assert.equal(split.lent[0]!.value, rupees(50_000));
    assert.equal(split.borrowed[0]!.value, rupees(30_000));

    const statement = netWorthStatement(db, "2026-08-28");
    const assets = statement.assetGroups.flatMap((g) => g.lines);
    const liabilities = statement.liabilityGroups.flatMap((g) => g.lines);

    assert.ok(assets.some((l) => l.label === "Lent to Ammu" && l.value === rupees(50_000)));
    assert.ok(liabilities.some((l) => l.label === "Borrowed from Appa" && l.value === rupees(30_000)));
    db.close();
  });

  test("FW3 · it never appears on the budget screen", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu", direction: "lent" });
    recordAdvance(db, actor, {
      loanId: loan.id, amount: rupees(50_000), date: "2026-08-05", fromAccountId: bank.id,
    });

    // It is a Tracking account, so FW1 already forbids it funding anything.
    // This asserts the weaker, more visible claim: it is not a category.
    const view = buildBudgetView(db, "2026-08");
    assert.ok(![...view.categories.values()].some((c) => c.name.includes("Ammu")));
    db.close();
  });

  test("a settled arrangement can be closed, keeping every transaction", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu", direction: "lent" });
    recordAdvance(db, actor, {
      loanId: loan.id, amount: rupees(5_000), date: "2026-06-10", fromAccountId: bank.id,
    });
    recordRepayment(db, actor, {
      loanId: loan.id, amount: rupees(5_000), date: "2026-08-02", accountId: bank.id,
    });

    closeFamilyLoan(db, actor, loan.id);
    assert.equal(listFamilyLoans(db).length, 0);
    assert.equal(listFamilyLoans(db, { includeClosed: true }).length, 1);

    // The history survives closing.
    assert.equal(viewFamilyLoan(db, loan.id, "2026-08-28")!.advanced, rupees(5_000));
    db.close();
  });

  test("an advance must be a real amount", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Ammu", direction: "lent" });
    assert.throws(
      () => recordAdvance(db, actor, { loanId: loan.id, amount: 0, fromAccountId: bank.id }),
      /greater than zero/,
    );
    db.close();
  });
});
