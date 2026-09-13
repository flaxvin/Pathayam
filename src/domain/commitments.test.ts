/**
 * P3 · Committing money to the household, and the claim it creates.
 *
 * The worked example is `15` §3.1, and the property under test is the one that
 * matters: **both identities close at every step**. Ravi commits ₹38,000 to the
 * household without a rupee leaving his account, and neither budget's books go
 * out by a paisa.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf, addMonths } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount, listAccounts, updateAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned } from "./budget.ts";
import { createTransaction, createTransfer } from "./transactions.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget, identityResidual } from "../engine/engine.ts";
import { householdBudgetId, ensurePersonalBudget } from "./budgets.ts";
import {
  ensureCommitmentEnvelope, commitmentEnvelope, commitmentSources, anyCommitments,
  guardCommitmentEnvelope,
} from "./commitments.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const actor: Actor = { memberId: RAVI, source: "ui" };
const MONTH = monthOf(todayIST());

function setup(): DB {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  for (const [id, name] of [[RAVI, "Ravi"], [PRIYA, "Priya"]] as const) {
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
      id, `${name.toLowerCase()}@example.com`, name, nowIST());
  }
  return db;
}

/** The residual of one budget's identity for the month being viewed. */
function residual(db: DB, budgetId: string): number {
  const state = computeBudget(loadEngineInput(db, { through: MONTH, budgetId }));
  return identityResidual(state.get(MONTH)!);
}

function stateOf(db: DB, budgetId: string) {
  return computeBudget(loadEngineInput(db, { through: MONTH, budgetId })).get(MONTH)!;
}

describe("P3 · the household envelope", () => {
  test("only a personal budget has one, and asking twice gives the same one", () => {
    const db = setup();
    const mine = ensurePersonalBudget(db, RAVI, "Ravi");

    const first = ensureCommitmentEnvelope(db, actor, mine.id);
    const second = ensureCommitmentEnvelope(db, actor, mine.id);
    assert.equal(first.id, second.id);
    assert.equal(first.commits_to_budget_id, householdBudgetId(db));
    assert.equal(first.budget_id, mine.id);

    assert.throws(
      () => ensureCommitmentEnvelope(db, actor, householdBudgetId(db)),
      /already holds the shared money/,
    );
    db.close();
  });

  test("it cannot be deleted or hidden out from under the household", () => {
    const db = setup();
    const mine = ensurePersonalBudget(db, RAVI, "Ravi");
    const envelope = ensureCommitmentEnvelope(db, actor, mine.id);
    assert.throws(() => guardCommitmentEnvelope(db, envelope.id, "deleted"), /counting on/);
    db.close();
  });
});

describe("P3 · 15 §3.1, worked", () => {
  test("committing ₹38,000 moves no money and closes both identities", () => {
    const db = setup();
    const household = householdBudgetId(db);
    const mine = ensurePersonalBudget(db, RAVI, "Ravi");

    // Ravi's own account, in his own budget. The household never sums it.
    const hdfc = createAccount(db, actor, {
      name: "HDFC Savings", kind: "budget", subtype: "savings",
      holderMemberId: RAVI, visibility: "private", budgetId: mine.id,
      openingBalance: rupees(1_00_000), openingDate: todayIST(),
    });

    // His own spending, and the envelope for the household.
    const group = createGroup(db, actor, "Mine", "normal", mine.id);
    const personal = createCategory(db, actor, { groupId: group.id, name: "Personal" });
    const toHousehold = ensureCommitmentEnvelope(db, actor, mine.id);

    // The household's own envelope for the rent.
    const shared = createGroup(db, actor, "Shared", "normal", household);
    const rent = createCategory(db, actor, { groupId: shared.id, name: "Rent" });

    setAssigned(db, actor, MONTH, personal.id, rupees(20_000));
    setAssigned(db, actor, MONTH, toHousehold.id, rupees(38_000));

    // ── His budget: 1,00,000 = 20,000 + 38,000 + 42,000 ──────────────────────
    const mineState = stateOf(db, mine.id);
    assert.equal(mineState.budgetAccountBalance, rupees(1_00_000));
    assert.equal(mineState.categories.get(personal.id)!.balance, rupees(20_000));
    assert.equal(mineState.categories.get(toHousehold.id)!.balance, rupees(38_000));
    assert.equal(mineState.readyToAssign, rupees(42_000));
    assert.equal(mineState.dueFromOtherBudgets, 0, "nothing is committed to a personal budget");
    assert.equal(residual(db, mine.id), 0);

    // ── The household: 0 + 38,000 due = 0 assigned + 38,000 to assign ────────
    let householdState = stateOf(db, household);
    assert.equal(householdState.budgetAccountBalance, 0, "not a rupee has moved");
    assert.equal(householdState.dueFromOtherBudgets, rupees(38_000));
    assert.equal(householdState.readyToAssign, rupees(38_000), "and it can be assigned");
    assert.equal(residual(db, household), 0);

    // ── The household assigns it to the rent ─────────────────────────────────
    setAssigned(db, actor, MONTH, rent.id, rupees(38_000));
    householdState = stateOf(db, household);
    assert.equal(householdState.categories.get(rent.id)!.balance, rupees(38_000));
    assert.equal(householdState.readyToAssign, 0);
    assert.equal(residual(db, household), 0);

    // His account still holds every rupee it started with.
    assert.equal(stateOf(db, mine.id).budgetAccountBalance, rupees(1_00_000));
    assert.equal(hdfc.visibility, "private");
    db.close();
  });

  test("two members' commitments add up, and are attributable", () => {
    const db = setup();
    const household = householdBudgetId(db);
    const ravi = ensurePersonalBudget(db, RAVI, "Ravi");
    const priya = ensurePersonalBudget(db, PRIYA, "Priya");

    for (const [budget, member, amount] of [
      [ravi, RAVI, rupees(38_000)], [priya, PRIYA, rupees(25_000)],
    ] as const) {
      createAccount(db, actor, {
        name: `${member} current`, kind: "budget", subtype: "savings",
        holderMemberId: member, budgetId: budget.id,
        openingBalance: rupees(1_00_000), openingDate: todayIST(),
      });
      const envelope = ensureCommitmentEnvelope(db, actor, budget.id);
      setAssigned(db, actor, MONTH, envelope.id, amount);
    }

    assert.equal(stateOf(db, household).dueFromOtherBudgets, rupees(63_000));
    assert.equal(residual(db, household), 0);
    assert.equal(residual(db, ravi.id), 0);
    assert.equal(residual(db, priya.id), 0);

    // Who committed what, without going near either account balance.
    const sources = commitmentSources(db, household);
    assert.deepEqual(sources.map((s) => s.memberId).sort(), [PRIYA, RAVI].sort());
    assert.equal(anyCommitments(db, household), true);
    db.close();
  });

  test("asked for every budget at once, the claim is not counted a second time", () => {
    // The export and the backup ask for everything. There the committing
    // budget's own account is already on the left and its envelope already in
    // the category total, so adding the claim would double the money.
    const db = setup();
    const mine = ensurePersonalBudget(db, RAVI, "Ravi");
    createAccount(db, actor, {
      name: "HDFC Savings", kind: "budget", subtype: "savings", budgetId: mine.id,
      openingBalance: rupees(1_00_000), openingDate: todayIST(),
    });
    const envelope = ensureCommitmentEnvelope(db, actor, mine.id);
    setAssigned(db, actor, MONTH, envelope.id, rupees(38_000));

    const everything = computeBudget(loadEngineInput(db, { through: MONTH })).get(MONTH)!;
    assert.equal(everything.dueFromOtherBudgets, 0);
    assert.equal(identityResidual(everything), 0);
    db.close();
  });

  test("a household nobody has committed to is exactly what it was", () => {
    const db = setup();
    const household = householdBudgetId(db);
    createAccount(db, actor, {
      name: "Joint current", kind: "budget", subtype: "savings",
      openingBalance: rupees(80_000), openingDate: todayIST(),
    });
    const group = createGroup(db, actor, "Spending", "normal", household);
    const groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" });
    setAssigned(db, actor, MONTH, groceries.id, rupees(12_000));

    const state = stateOf(db, household);
    assert.equal(state.dueFromOtherBudgets, 0);
    assert.equal(state.readyToAssign, rupees(68_000));
    assert.equal(identityResidual(state), 0);
    assert.equal(commitmentEnvelope(db, household), null);
    db.close();
  });
});

describe("P3 · 15 §6.1 · a commitment stays and rolls", () => {
  test("unspent, it carries into next month like any other envelope", () => {
    const db = setup();
    const household = householdBudgetId(db);
    const mine = ensurePersonalBudget(db, RAVI, "Ravi");
    createAccount(db, actor, {
      name: "HDFC Savings", kind: "budget", subtype: "savings", budgetId: mine.id,
      openingBalance: rupees(1_00_000), openingDate: todayIST(),
    });
    const envelope = ensureCommitmentEnvelope(db, actor, mine.id);
    setAssigned(db, actor, MONTH, envelope.id, rupees(38_000));

    const next = addMonths(MONTH, 1);
    const mineNext = computeBudget(
      loadEngineInput(db, { through: next, budgetId: mine.id }),
    ).get(next)!;

    // R3, with no exception for being a commitment: taking it back has to be a
    // deliberate move, because the household was counting on it.
    assert.equal(mineNext.categories.get(envelope.id)!.opening, rupees(38_000));
    assert.equal(mineNext.categories.get(envelope.id)!.balance, rupees(38_000));

    // And the claim rolls with it, so the household is not surprised either.
    const householdNext = computeBudget(
      loadEngineInput(db, { through: next, budgetId: household }),
    ).get(next)!;
    assert.equal(householdNext.dueFromOtherBudgets, rupees(38_000));
    assert.equal(identityResidual(householdNext), 0);
    db.close();
  });

  test("taking it back is an ordinary move, and the claim falls with it", () => {
    const db = setup();
    const household = householdBudgetId(db);
    const mine = ensurePersonalBudget(db, RAVI, "Ravi");
    createAccount(db, actor, {
      name: "HDFC Savings", kind: "budget", subtype: "savings", budgetId: mine.id,
      openingBalance: rupees(1_00_000), openingDate: todayIST(),
    });
    const envelope = ensureCommitmentEnvelope(db, actor, mine.id);
    setAssigned(db, actor, MONTH, envelope.id, rupees(38_000));
    assert.equal(stateOf(db, household).dueFromOtherBudgets, rupees(38_000));

    setAssigned(db, actor, MONTH, envelope.id, rupees(10_000));
    assert.equal(stateOf(db, household).dueFromOtherBudgets, rupees(10_000));
    assert.equal(residual(db, household), 0);
    assert.equal(residual(db, mine.id), 0);
    db.close();
  });
});

describe("P3 · a commitment in the red is a debt, not an overspend", () => {
  test("it carries its negative forward, and the claim carries with it", () => {
    const db = setup();
    const household = householdBudgetId(db);
    const mine = ensurePersonalBudget(db, RAVI, "Ravi");
    createAccount(db, actor, {
      name: "HDFC Savings", kind: "budget", subtype: "savings", budgetId: mine.id,
      openingBalance: rupees(1_00_000), openingDate: todayIST(),
    });
    const envelope = ensureCommitmentEnvelope(db, actor, mine.id);
    const shared = createGroup(db, actor, "Shared", "normal", household);
    const groceries = createCategory(db, actor, { groupId: shared.id, name: "Groceries" });

    // He commits nothing and then pays ₹5,000 of the household's groceries from
    // his own account: household spending nobody put money aside for.
    createTransaction(db, actor, {
      accountId: listAccounts(db).find((a) => a.name === "HDFC Savings")!.id,
      amount: -rupees(5_000), date: todayIST(), categoryId: groceries.id,
    });

    const now = stateOf(db, mine.id);
    assert.equal(now.categories.get(envelope.id)!.balance, -rupees(5_000));
    assert.equal(residual(db, mine.id), 0);
    assert.equal(stateOf(db, household).dueFromOtherBudgets, -rupees(5_000));
    assert.equal(residual(db, household), 0);

    // Next month the debt is still a debt. An ordinary envelope would have
    // reopened at zero with the ₹5,000 taken out of Ready to Assign instead.
    const next = addMonths(MONTH, 1);
    const mineNext = computeBudget(
      loadEngineInput(db, { through: next, budgetId: mine.id }),
    ).get(next)!;
    assert.equal(mineNext.categories.get(envelope.id)!.opening, -rupees(5_000));
    assert.equal(mineNext.rtaBreakdown.cashOverspendCarried, 0, "not treated as an overspend");
    assert.equal(identityResidual(mineNext), 0);

    const householdNext = computeBudget(
      loadEngineInput(db, { through: next, budgetId: household }),
    ).get(next)!;
    assert.equal(householdNext.dueFromOtherBudgets, -rupees(5_000), "still owed to him");
    assert.equal(identityResidual(householdNext), 0);
    db.close();
  });
});

describe("P3 · moving an account that already has history", () => {
  /**
   * The case that found three separate bugs, and the reason it is worth keeping:
   * P2 lets a member move an account into their own budget, and every account
   * worth moving has years of spending filed to household envelopes. So the move
   * turns a pile of ordinary transactions into cross-budget ones all at once.
   *
   * What broke, in the order it was found: activity was attributed to the
   * account's budget rather than the envelope's; a transfer to another budget's
   * account or card was still treated as internal; and the commitment envelope's
   * negative was absorbed at each rollover, so the claim evaporated while the
   * debt did not.
   */
  test("three months of household spending, then the account moves — every month still closes", () => {
    const db = setup();
    const household = householdBudgetId(db);
    const start = addMonths(MONTH, -3);

    const account = createAccount(db, actor, {
      name: "HDFC Savings", kind: "budget", subtype: "savings",
      openingBalance: rupees(2_00_000), openingDate: `${start}-01` as never,
    });
    const card = createAccount(db, actor, {
      name: "Household card", kind: "credit", subtype: "credit-card",
      openingBalance: -rupees(3_000), openingDate: `${start}-01` as never,
    });
    const shared = createGroup(db, actor, "Shared", "normal", household);
    const groceries = createCategory(db, actor, { groupId: shared.id, name: "Groceries" });

    for (let i = 0; i < 3; i++) {
      const month = addMonths(start, i);
      setAssigned(db, actor, month, groceries.id, rupees(9_000));
      createTransaction(db, actor, {
        accountId: account.id, amount: -rupees(8_400),
        date: `${month}-05` as never, categoryId: groceries.id,
      });
    }
    /*
     * Two transfers, because the two cross-budget transfer cases part company:
     * paying another budget's card buys a claim, while moving cash into another
     * budget's account is money genuinely gone (15 §3.5).
     */
    createTransfer(db, actor, {
      fromAccountId: account.id, toAccountId: card.id,
      amount: rupees(3_000), date: `${addMonths(start, 1)}-20` as never,
    });
    const joint = createAccount(db, actor, {
      name: "Joint current", kind: "budget", subtype: "savings",
      openingBalance: rupees(10_000), openingDate: `${start}-01` as never,
    });
    createTransfer(db, actor, {
      fromAccountId: account.id, toAccountId: joint.id,
      amount: rupees(5_000), date: `${addMonths(start, 2)}-10` as never,
    });

    const everyMonthCloses = (budgetId: string) => {
      const state = computeBudget(loadEngineInput(db, { through: MONTH, budgetId }));
      return [...state.entries()]
        .filter(([, s]) => identityResidual(s) !== 0)
        .map(([month, s]) => `${month}=${identityResidual(s)}`);
    };

    // Before the move: one budget, and nothing unusual about any of it.
    assert.deepEqual(everyMonthCloses(household), []);

    // Now it becomes hers, along with everything it ever paid for.
    const mine = ensurePersonalBudget(db, PRIYA, "Priya");
    ensureCommitmentEnvelope(db, actor, mine.id);
    updateAccount(db, actor, account.id, { budget_id: mine.id, holder_member_id: PRIYA });

    assert.deepEqual(everyMonthCloses(household), [], "the household's books");
    assert.deepEqual(everyMonthCloses(mine.id), [], "and hers");

    // And the figures say the true thing: she has paid for the household's
    // spending out of her own money, and is owed it.
    const householdNow = stateOf(db, household);
    assert.ok(
      householdNow.dueFromOtherBudgets < 0,
      `the household should owe her, got ${householdNow.dueFromOtherBudgets}`,
    );
    /*
     * The groceries and the card payment are hers to reclaim. The ₹5,000 she
     * transferred into the joint account is not: that money arrived somewhere the
     * household counts, so it is an ordinary transfer and creates no claim.
     */
    assert.equal(householdNow.dueFromOtherBudgets, -(rupees(8_400) * 3 + rupees(3_000)));
    db.close();
  });
});
