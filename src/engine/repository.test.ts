/**
 * Integration: real rows through the repository must produce the same numbers
 * the pure-engine suite proves against the worked examples.
 *
 * These two paths can drift — the scenario builder and the SQL aggregation are
 * separate implementations of the same definitions — so the worked examples are
 * re-run here end to end rather than trusted once.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount, paymentCategoryFor, createCard } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned, moveMoney, setHeld } from "../domain/budget.ts";
import { createTransaction, createTransfer } from "../domain/transactions.ts";
import {
  loadEngineInput,
  monthRange,
  accountBalances,
  averageDailySpend,
  creditOutstanding,
} from "./repository.ts";
import { computeBudget, identityResidual, cardFunding } from "./engine.ts";

const AUG = "2026-08";
const SEP = "2026-09";
const RAVI = "m-ravi";
const PRIYA = "m-priya";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup(): DB {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  const insert = db.prepare("INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)");
  insert.run(RAVI, "ravi@example.com", "Ravi", "2026-08-01T00:00:00+05:30");
  insert.run(PRIYA, "priya@example.com", "Priya", "2026-08-01T00:00:00+05:30");
  return db;
}

function compute(db: DB, month = AUG) {
  const input = loadEngineInput(db, { through: month });
  const state = computeBudget(input);
  for (const [m, s] of state) {
    assert.equal(identityResidual(s), 0, `identity broken in ${m}`);
  }
  return { input, state, month: state.get(month)! };
}

function balanceOf(state: ReturnType<typeof compute>["month"], categoryId: string) {
  const c = state.categories.get(categoryId);
  assert.ok(c, "category missing from engine output");
  return c.balance;
}

describe("repository → engine", () => {
  test("an opening balance arrives in Ready to Assign as income (F2.5)", () => {
    const db = setup();
    createAccount(db, actor, {
      name: "HDFC Savings", kind: "budget", subtype: "savings",
      openingBalance: rupees(120_000), openingDate: "2026-08-01",
    });

    const { month } = compute(db);
    assert.equal(month.readyToAssign, rupees(120_000));
    assert.equal(month.budgetAccountBalance, rupees(120_000));
    db.close();
  });

  test("reproduces R6's worked example through real rows", () => {
    const db = setup();
    const savings = createAccount(db, actor, {
      name: "HDFC Savings", kind: "budget", subtype: "savings",
      openingBalance: rupees(50_000), openingDate: "2026-08-01",
    });
    const card = createAccount(db, actor, {
      name: "HDFC Card", kind: "credit", subtype: "credit-card", openingDate: "2026-08-01",
    });
    const group = createGroup(db, actor, "Flexible");
    const groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" });

    setAssigned(db, actor, AUG, groceries.id, rupees(12_000));
    createTransaction(db, actor, {
      accountId: card.id, amount: rupees(-1_800), date: "2026-08-14",
      categoryId: groceries.id, payeeName: "DMart",
    });

    const { month } = compute(db);
    const payCategory = paymentCategoryFor(db, card.id)!;

    assert.equal(balanceOf(month, groceries.id), rupees(10_200), "Groceries → ₹10,200");
    assert.equal(balanceOf(month, payCategory.id), rupees(1_800), "HDFC Payments → +₹1,800");
    assert.equal(accountBalances(db).get(card.id)!.working, rupees(-1_800), "card → −₹1,800");
    assert.equal(month.readyToAssign, rupees(38_000), "no cash was created");
    void savings;
    db.close();
  });

  test("reproduces J5 — a card month, statement and payment", () => {
    const db = setup();
    const savings = createAccount(db, actor, {
      name: "HDFC Savings", kind: "budget", subtype: "savings",
      openingBalance: rupees(60_000), openingDate: "2026-08-01",
    });
    const card = createAccount(db, actor, {
      name: "HDFC Card", kind: "credit", subtype: "credit-card", openingDate: "2026-08-01",
    });
    const group = createGroup(db, actor, "Flexible");
    const eatingOut = createCategory(db, actor, { groupId: group.id, name: "Eating Out" });
    const payCategory = paymentCategoryFor(db, card.id)!;

    setAssigned(db, actor, AUG, eatingOut.id, rupees(5_000));
    createTransaction(db, actor, {
      accountId: card.id, amount: rupees(-2_400), date: "2026-08-12",
      categoryId: eatingOut.id, payeeName: "Toit",
    });
    setAssigned(db, actor, AUG, payCategory.id, rupees(16_000));
    createTransfer(db, actor, {
      fromAccountId: savings.id, toAccountId: card.id,
      amount: rupees(18_400), date: "2026-08-20",
    });

    const { month } = compute(db);
    assert.equal(balanceOf(month, eatingOut.id), rupees(2_600), "no spending category is touched");
    assert.equal(balanceOf(month, payCategory.id), 0);
    assert.equal(accountBalances(db).get(savings.id)!.working, rupees(41_600));
    db.close();
  });

  test("reproduces R4 — a cash overspend reduces next month's RTA", () => {
    const db = setup();
    createAccount(db, actor, {
      name: "HDFC Savings", kind: "budget", subtype: "savings",
      openingBalance: rupees(50_000), openingDate: "2026-08-01",
    });
    const group = createGroup(db, actor, "Flexible");
    const groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" });
    const savingsId = accountBalances(db).keys().next().value as string;

    setAssigned(db, actor, AUG, groceries.id, rupees(12_000));
    createTransaction(db, actor, {
      accountId: savingsId, amount: rupees(-13_400), date: "2026-08-20", categoryId: groceries.id,
    });

    const aug = compute(db, AUG).month;
    assert.equal(balanceOf(aug, groceries.id), rupees(-1_400));

    const sep = compute(db, SEP).state.get(SEP)!;
    assert.equal(sep.categories.get(groceries.id)!.opening, 0);
    assert.equal(sep.cashOverspendCarriedIn, rupees(1_400));
    assert.equal(sep.readyToAssign, rupees(36_600));
    db.close();
  });

  test("a split transaction lands in each of its categories", () => {
    const db = setup();
    const savings = createAccount(db, actor, {
      name: "HDFC Savings", kind: "budget", subtype: "savings",
      openingBalance: rupees(50_000), openingDate: "2026-08-01",
    });
    const group = createGroup(db, actor, "Flexible");
    const groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" });
    const household = createCategory(db, actor, { groupId: group.id, name: "Household" });

    setAssigned(db, actor, AUG, groceries.id, rupees(5_000));
    setAssigned(db, actor, AUG, household.id, rupees(3_000));
    createTransaction(db, actor, {
      accountId: savings.id, amount: rupees(-2_400), date: "2026-08-10", payeeName: "DMart",
      splits: [
        { categoryId: groceries.id, amount: rupees(-1_800) },
        { categoryId: household.id, amount: rupees(-600) },
      ],
    });

    const { month } = compute(db);
    assert.equal(balanceOf(month, groceries.id), rupees(3_200));
    assert.equal(balanceOf(month, household.id), rupees(2_400));
    db.close();
  });

  test("rejects splits that do not sum to the total (F4.3)", () => {
    const db = setup();
    const savings = createAccount(db, actor, {
      name: "HDFC", kind: "budget", subtype: "savings", openingDate: "2026-08-01",
    });
    const group = createGroup(db, actor, "Flexible");
    const c = createCategory(db, actor, { groupId: group.id, name: "Groceries" });

    assert.throws(
      () =>
        createTransaction(db, actor, {
          accountId: savings.id, amount: rupees(-2_400), date: "2026-08-10",
          splits: [{ categoryId: c.id, amount: rupees(-1_800) }],
        }),
      /add up to -₹1,800, but the transaction is -₹2,400/,
    );
    db.close();
  });

  test("a transfer between budget accounts is invisible to the budget", () => {
    const db = setup();
    const savings = createAccount(db, actor, {
      name: "HDFC", kind: "budget", subtype: "savings",
      openingBalance: rupees(50_000), openingDate: "2026-08-01",
    });
    const cash = createAccount(db, actor, {
      name: "Cash", kind: "budget", subtype: "cash", openingDate: "2026-08-01",
    });

    const before = compute(db).month.readyToAssign;
    // L8/Q7: an ATM withdrawal is a transfer into the Cash account.
    createTransfer(db, actor, {
      fromAccountId: savings.id, toAccountId: cash.id, amount: rupees(5_000), date: "2026-08-05",
    });
    const after = compute(db).month;

    assert.equal(after.readyToAssign, before, "moving your own money changes nothing");
    assert.equal(accountBalances(db).get(cash.id)!.working, rupees(5_000));
    db.close();
  });

  test("moving money between categories leaves RTA unchanged (R5)", () => {
    const db = setup();
    createAccount(db, actor, {
      name: "HDFC", kind: "budget", subtype: "savings",
      openingBalance: rupees(50_000), openingDate: "2026-08-01",
    });
    const group = createGroup(db, actor, "Flexible");
    const a = createCategory(db, actor, { groupId: group.id, name: "Entertainment" });
    const b = createCategory(db, actor, { groupId: group.id, name: "Eating Out" });

    setAssigned(db, actor, AUG, a.id, rupees(5_000));
    setAssigned(db, actor, AUG, b.id, rupees(2_000));
    const before = compute(db).month.readyToAssign;

    moveMoney(db, actor, { month: AUG, fromCategoryId: a.id, toCategoryId: b.id, amount: rupees(1_850) });
    const after = compute(db).month;

    assert.equal(after.readyToAssign, before);
    assert.equal(balanceOf(after, a.id), rupees(3_150));
    assert.equal(balanceOf(after, b.id), rupees(3_850));
    db.close();
  });

  test("holding income moves it to the next month (R11)", () => {
    const db = setup();
    createAccount(db, actor, {
      name: "HDFC", kind: "budget", subtype: "savings",
      openingBalance: rupees(80_000), openingDate: "2026-08-01",
    });
    setHeld(db, actor, AUG, rupees(40_000));

    assert.equal(compute(db, AUG).month.readyToAssign, rupees(40_000));
    assert.equal(compute(db, SEP).state.get(SEP)!.readyToAssign, rupees(80_000));
    db.close();
  });

  test("add-on card spending shares the account's one payment envelope (R6.b)", () => {
    const db = setup();
    createAccount(db, actor, {
      name: "HDFC", kind: "budget", subtype: "savings",
      openingBalance: rupees(50_000), openingDate: "2026-08-01",
    });
    const axis = createAccount(db, actor, {
      name: "Axis Atlas", kind: "credit", subtype: "credit-card",
      last4: "3150", openingDate: "2026-08-01",
    });
    // 09 §4: Priya's 3162 is an add-on on Ravi's account, not its own card.
    const addOn = createCard(db, actor, {
      accountId: axis.id, label: "Axis — Priya", last4: "3162", holderMemberId: PRIYA,
    });

    const group = createGroup(db, actor, "Flexible");
    const groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" });
    setAssigned(db, actor, AUG, groceries.id, rupees(10_000));

    createTransaction(db, actor, {
      accountId: axis.id, cardId: addOn.id, amount: rupees(-2_000),
      date: "2026-08-11", categoryId: groceries.id,
    });
    createTransaction(db, actor, {
      accountId: axis.id, amount: rupees(-1_500), date: "2026-08-12", categoryId: groceries.id,
    });

    const { month } = compute(db);
    const payCategory = paymentCategoryFor(db, axis.id)!;
    assert.equal(balanceOf(month, payCategory.id), rupees(3_500), "one envelope, both cards");

    // R6.c: the add-on's spending is attributed to its holder, not the primary.
    const rows = db
      .prepare(`SELECT owner_member_id, card_id FROM transactions WHERE account_id = ? ORDER BY date`)
      .all(axis.id) as { owner_member_id: string; card_id: string }[];
    assert.equal(rows[0]!.owner_member_id, PRIYA, "add-on spending belongs to Priya");
    assert.equal(rows[1]!.owner_member_id, RAVI);
    db.close();
  });

  test("reports the unfunded portion of a card balance", () => {
    const db = setup();
    createAccount(db, actor, {
      name: "HDFC", kind: "budget", subtype: "savings",
      openingBalance: rupees(50_000), openingDate: "2026-08-01",
    });
    // F2.6: an existing balance is recorded as a negative opening balance.
    const card = createAccount(db, actor, {
      name: "ICICI Amazon Pay", kind: "credit", subtype: "credit-card",
      openingBalance: rupees(-24_000), openingDate: "2026-08-01",
    });
    const payCategory = paymentCategoryFor(db, card.id)!;
    setAssigned(db, actor, AUG, payCategory.id, rupees(20_800));

    const { month } = compute(db);
    const funding = cardFunding(
      card.id,
      creditOutstanding(db).get(card.id)!,
      month.categories.get(payCategory.id)!.balance,
    );
    assert.equal(funding.unfunded, rupees(3_200));
    db.close();
  });
});

describe("transfers out of the budget", () => {
  /**
   * The case the derivation's §3 did not name: a transfer whose other side is
   * a *tracking* account. Budget↔budget nets to zero and budget↔credit is a
   * card payment, but this one is money genuinely leaving the budget.
   */
  function lendOut(db: DB) {
    const bank = createAccount(db, actor, {
      name: "HDFC", kind: "budget", subtype: "savings",
      openingDate: "2026-08-01", openingBalance: rupees(200_000),
    });
    // A fixed deposit: tracking, and worth its balance. (A family loan was
    // used here once, but that is a derived account — createTransfer refuses
    // a plain transfer into one, because its value is kept by the lending
    // code, not by the transfer.)
    const tracked = createAccount(db, actor, {
      name: "Sweep FD", kind: "tracking", subtype: "fixed-deposit",
      openingDate: "2026-08-01",
    });
    createTransfer(db, actor, {
      fromAccountId: bank.id, toAccountId: tracked.id,
      amount: rupees(50_000), date: "2026-08-05",
    });
    return { bank, tracked };
  }

  test("money moved to a tracking account leaves Ready to Assign", () => {
    const db = setup();
    lendOut(db);

    // R1: Ready to Assign is money you have. Money in someone else's hands,
    // or in an asset, is not money you have.
    const state = computeBudget(loadEngineInput(db, { through: AUG })).get(AUG)!;
    assert.equal(state.readyToAssign, rupees(150_000));
    db.close();
  });

  test("and the identity still holds", () => {
    const db = setup();
    lendOut(db);

    // This is the assertion that would have caught it: excluding the leg made
    // the budget balance drop while RTA and every category stayed put, leaving
    // a residual of exactly the amount transferred.
    for (const [, state] of computeBudget(loadEngineInput(db, { through: AUG }))) {
      assert.equal(identityResidual(state), 0);
    }
    db.close();
  });

  test("a categorised transfer out is absorbed by its envelope instead", () => {
    const db = setup();
    const { bank, tracked } = lendOut(db);
    const group = createGroup(db, actor, "Saving");
    const investing = createCategory(db, actor, { groupId: group.id, name: "Investing" });
    setAssigned(db, actor, AUG, investing.id, rupees(20_000));

    const [out] = createTransfer(db, actor, {
      fromAccountId: bank.id, toAccountId: tracked.id,
      amount: rupees(20_000), date: "2026-08-10",
    });
    execute(db, `UPDATE transactions SET category_id = ? WHERE id = ?`, investing.id, out.id);

    // FW4's shape: the envelope records it, so RTA is untouched by this one.
    const state = computeBudget(loadEngineInput(db, { through: AUG })).get(AUG)!;
    assert.equal(state.readyToAssign, rupees(130_000));
    assert.equal(state.categories.get(investing.id)!.balance, 0);
    assert.equal(identityResidual(state), 0);
    db.close();
  });

  test("a budget-to-budget transfer still nets to nothing", () => {
    const db = setup();
    const a = createAccount(db, actor, {
      name: "HDFC", kind: "budget", subtype: "savings",
      openingDate: "2026-08-01", openingBalance: rupees(200_000),
    });
    const b = createAccount(db, actor, {
      name: "ICICI", kind: "budget", subtype: "savings", openingDate: "2026-08-01",
    });
    createTransfer(db, actor, {
      fromAccountId: a.id, toAccountId: b.id, amount: rupees(50_000), date: "2026-08-05",
    });

    const state = computeBudget(loadEngineInput(db, { through: AUG })).get(AUG)!;
    assert.equal(state.readyToAssign, rupees(200_000));
    assert.equal(identityResidual(state), 0);
    db.close();
  });
});

describe("balances and derived figures", () => {
  test("separates cleared from uncleared (F2.8)", () => {
    const db = setup();
    const a = createAccount(db, actor, {
      name: "HDFC", kind: "budget", subtype: "savings",
      openingBalance: rupees(10_000), openingDate: "2026-08-01",
    });
    createTransaction(db, actor, { accountId: a.id, amount: rupees(-1_000), date: "2026-08-05", cleared: true });
    createTransaction(db, actor, { accountId: a.id, amount: rupees(-500), date: "2026-08-06" });

    const b = accountBalances(db).get(a.id)!;
    assert.equal(b.cleared, rupees(9_000));
    assert.equal(b.uncleared, rupees(-500));
    assert.equal(b.working, rupees(8_500));
    db.close();
  });

  test("excludes a deleted transaction from every figure (F4.8)", () => {
    const db = setup();
    const a = createAccount(db, actor, {
      name: "HDFC", kind: "budget", subtype: "savings",
      openingBalance: rupees(10_000), openingDate: "2026-08-01",
    });
    const t = createTransaction(db, actor, { accountId: a.id, amount: rupees(-1_000), date: "2026-08-05" });
    execute(db, `UPDATE transactions SET deleted_at = ? WHERE id = ?`, "2026-08-06T00:00:00+05:30", t.id);

    assert.equal(accountBalances(db).get(a.id)!.working, rupees(10_000));
    assert.equal(compute(db).month.readyToAssign, rupees(10_000));
    db.close();
  });

  test("averages daily spend over the trailing window, excluding card payments", () => {
    const db = setup();
    const savings = createAccount(db, actor, {
      name: "HDFC", kind: "budget", subtype: "savings",
      openingBalance: rupees(100_000), openingDate: "2026-06-01",
    });
    const card = createAccount(db, actor, {
      name: "Card", kind: "credit", subtype: "credit-card", openingDate: "2026-06-01",
    });
    const group = createGroup(db, actor, "Flexible");
    const groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" });
    const payCategory = paymentCategoryFor(db, card.id)!;

    createTransaction(db, actor, {
      accountId: savings.id, amount: rupees(-9_000), date: "2026-08-01", categoryId: groceries.id,
    });
    // Funding a card is not spending — it must not inflate the denominator.
    // New writes cannot carry a payment category, but a database from before
    // that rule can; the exclusion has to hold for those rows regardless.
    const funding = createTransaction(db, actor, {
      accountId: savings.id, amount: rupees(-50_000), date: "2026-08-02",
    });
    execute(db, `UPDATE transactions SET category_id = ? WHERE id = ?`,
      payCategory.id, funding.id);

    // ₹9,000 over 90 days.
    assert.equal(averageDailySpend(db, "2026-08-26", 90), rupees(100));
    db.close();
  });

  test("spans months from the earliest data through any future assignment", () => {
    const db = setup();
    createAccount(db, actor, {
      name: "HDFC", kind: "budget", subtype: "savings",
      openingBalance: rupees(10_000), openingDate: "2026-06-15",
    });
    const group = createGroup(db, actor, "Flexible");
    const c = createCategory(db, actor, { groupId: group.id, name: "Rent" });
    setAssigned(db, actor, "2026-11", c.id, rupees(1_000));

    const months = monthRange(db, AUG);
    assert.equal(months[0], "2026-06");
    assert.equal(months.at(-1), "2026-11", "a future assignment must be inside the walk (R2)");
    db.close();
  });
});
