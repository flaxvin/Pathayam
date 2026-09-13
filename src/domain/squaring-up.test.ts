/**
 * P5 · Ahead, behind, and calling it even.
 *
 * `15` §4A.4 answers the objection that matters — *the money has to come from
 * somewhere* — by following the household's side to the end. These tests are that
 * trace, asserted: every step closes both sets of books, and the amount ends up
 * in a real envelope rather than disappearing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf, addMonths } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned } from "./budget.ts";
import { createTransaction } from "./transactions.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget, identityResidual } from "../engine/engine.ts";
import { householdBudgetId, ensurePersonalBudget } from "./budgets.ts";
import { ensureCommitmentEnvelope, commitmentEnvelope } from "./commitments.ts";
import { callItEven, listEvenCalls, GIVEN_UP_CATEGORY, ensureGivenUpCategory } from "./squaring-up.ts";
import { standingOf, outstanding, standingSentence } from "./standing.ts";
import { undoEvent, historyFor } from "../core/events.ts";
import { closeMonth, isClosed, monthCloseView } from "./month-close.ts";

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

function stateOf(db: DB, budgetId: string, month = MONTH) {
  return computeBudget(loadEngineInput(db, { through: month, budgetId })).get(month)!;
}

function allClose(db: DB, budgetIds: string[]): string[] {
  const out: string[] = [];
  for (const budgetId of budgetIds) {
    for (const [month, s] of computeBudget(loadEngineInput(db, { through: MONTH, budgetId }))) {
      const residual = identityResidual(s);
      if (residual !== 0) out.push(`${budgetId} ${month} = ${residual}`);
    }
  }
  return out;
}

describe("P5 · R6.n · the words for a balance", () => {
  test("a positive envelope is behind, a negative one is ahead", () => {
    assert.equal(standingOf(rupees(2_000)), "behind");
    assert.equal(standingOf(-rupees(2_000)), "ahead");
    assert.equal(standingOf(0 as never), "even");
    assert.equal(outstanding(-rupees(2_000)), rupees(2_000));
  });

  test("it is said as ahead and behind, never as debt", () => {
    const ahead = standingSentence(-rupees(2_000), "Ravi");
    assert.match(ahead, /behind with Ravi/);
    for (const word of [/\bdebt\b/i, /\bowes\b/i, /\bliabilit/i, /\bcreditor\b/i, /forgive/i]) {
      assert.doesNotMatch(ahead, word, `the wrong register: ${word}`);
    }
    assert.match(standingSentence(-rupees(2_000), null), /you are .* ahead/i);
    assert.match(standingSentence(0 as never, null), /square/i);
  });
});

describe("P5 · 15 §4A.2 · putting it down to yourself", () => {
  test("covering your own household envelope makes your share bigger, and closes both books", () => {
    const db = setup();
    const household = householdBudgetId(db);
    const his = ensurePersonalBudget(db, RAVI, "Ravi");
    const envelope = ensureCommitmentEnvelope(db, actor, his.id);

    const account = createAccount(db, actor, {
      name: "His savings", kind: "budget", subtype: "savings",
      budgetId: his.id, openingBalance: rupees(1_00_000), openingDate: todayIST(),
    });
    const shared = createGroup(db, actor, "Shared", "normal", household);
    const groceries = createCategory(db, actor, { groupId: shared.id, name: "Groceries" });

    // He planned ₹3,000 and spent ₹5,000 of his own on the household's groceries.
    setAssigned(db, actor, MONTH, envelope.id, rupees(3_000));
    setAssigned(db, actor, MONTH, groceries.id, rupees(3_000));
    createTransaction(db, actor, {
      accountId: account.id, amount: -rupees(5_000), date: todayIST(), categoryId: groceries.id,
    });

    assert.equal(stateOf(db, his.id).categories.get(envelope.id)!.balance, -rupees(2_000));
    assert.equal(standingOf(stateOf(db, his.id).categories.get(envelope.id)!.balance), "ahead");
    assert.deepEqual(allClose(db, [household, his.id]), []);

    // He puts it down to himself: ₹2,000 more out of his own Ready to Assign.
    setAssigned(db, actor, MONTH, envelope.id, rupees(5_000));

    assert.equal(stateOf(db, his.id).categories.get(envelope.id)!.balance, 0);
    assert.equal(stateOf(db, household).dueFromOtherBudgets, 0);
    assert.deepEqual(allClose(db, [household, his.id]), []);
    db.close();
  });
});

describe("P5 · 15 §4A.4 · calling it even, and where the money comes from", () => {
  /**
   * The worked example: Priya used the household's shared card for ₹2,000 of her
   * own shopping, so she is ₹2,000 behind. The household says leave it.
   */
  function behindByTwoThousand(db: DB) {
    const household = householdBudgetId(db);
    const hers = ensurePersonalBudget(db, PRIYA, "Priya");
    ensureCommitmentEnvelope(db, actor, hers.id);

    const card = createAccount(db, actor, {
      name: "Household card", kind: "credit", subtype: "credit-card", openingDate: todayIST(),
    });
    const joint = createAccount(db, actor, {
      name: "Joint current", kind: "budget", subtype: "savings",
      openingBalance: rupees(50_000), openingDate: todayIST(),
    });
    createAccount(db, actor, {
      name: "Her savings", kind: "budget", subtype: "savings",
      budgetId: hers.id, openingBalance: rupees(40_000), openingDate: todayIST(),
    });
    const herGroup = createGroup(db, actor, "Mine", "normal", hers.id);
    const clothes = createCategory(db, actor, { groupId: herGroup.id, name: "Clothes" });
    setAssigned(db, actor, MONTH, clothes.id, rupees(2_000));

    createTransaction(db, actor, {
      accountId: card.id, amount: -rupees(2_000), date: todayIST(),
      categoryId: clothes.id, ownerMemberId: PRIYA,
    });

    return { household, hers, joint, card, envelope: commitmentEnvelope(db, hers.id)! };
  }

  test("she is behind, and both books close before anybody does anything", () => {
    const db = setup();
    const { household, hers, envelope } = behindByTwoThousand(db);
    assert.equal(stateOf(db, hers.id).categories.get(envelope.id)!.balance, rupees(2_000));
    assert.equal(stateOf(db, household).dueFromOtherBudgets, rupees(2_000));
    assert.deepEqual(allClose(db, [household, hers.id]), []);
    db.close();
  });

  test("calling it even closes the balance and lands as spending on the giving side", () => {
    const db = setup();
    const { household, hers, envelope } = behindByTwoThousand(db);
    const before = stateOf(db, household);

    callItEven(db, actor, { envelopeId: envelope.id, amount: rupees(2_000), month: MONTH });

    // Her side: the obligation goes, and she is genuinely ₹2,000 better off.
    const herNow = stateOf(db, hers.id);
    assert.equal(herNow.categories.get(envelope.id)!.balance, 0);
    assert.equal(herNow.readyToAssign, stateOf(db, hers.id).readyToAssign);
    assert.equal(herNow.rtaBreakdown.incomeToDate - rupees(40_000), rupees(2_000));

    // The household's side: the claim is gone and the amount is spending, in a
    // real envelope, which is the whole argument of §4A.4.
    const householdNow = stateOf(db, household);
    assert.equal(householdNow.dueFromOtherBudgets, 0);
    const gifts = [...householdNow.categories.values()].find(
      (c) => c.activity === -rupees(2_000) && c.categoryId !== envelope.id,
    );
    assert.ok(gifts, "the given-up amount is spent from an envelope");
    assert.equal(gifts!.balance, -rupees(2_000), "and until it is funded it sits overspent");

    // Both sets of books still close, which is the point.
    assert.deepEqual(allClose(db, [household, hers.id]), []);

    // Funding it is ordinary, and it comes out of the household's own pool.
    setAssigned(db, actor, MONTH, gifts!.categoryId, rupees(2_000));
    const funded = stateOf(db, household);
    assert.equal(funded.categories.get(gifts!.categoryId)!.balance, 0);
    assert.equal(funded.readyToAssign, before.readyToAssign - rupees(2_000));
    assert.deepEqual(allClose(db, [household, hers.id]), []);
    db.close();
  });

  test("it never pays the card bill — the bank is owed either way", () => {
    const db = setup();
    const { household, hers, envelope, card, joint } = behindByTwoThousand(db);
    callItEven(db, actor, { envelopeId: envelope.id, amount: rupees(2_000), month: MONTH });

    // The card's payment envelope still holds the ₹2,000 the bank will want.
    const payment = db.prepare(
      `SELECT id FROM categories WHERE payment_account_id = ?`,
    ).get(card.id) as { id: string };
    assert.equal(stateOf(db, household).categories.get(payment.id)!.balance, rupees(2_000));

    // Paying it changes nothing about the balance between the two of them.
    execute(db, `SELECT 1`);
    assert.equal(stateOf(db, hers.id).categories.get(envelope.id)!.balance, 0);
    assert.deepEqual(allClose(db, [household, hers.id]), []);
    assert.ok(joint.id);
    db.close();
  });

  test("partial amounts are ordinary, and the rest stays outstanding", () => {
    const db = setup();
    const { household, hers, envelope } = behindByTwoThousand(db);
    callItEven(db, actor, { envelopeId: envelope.id, amount: rupees(500), month: MONTH });

    assert.equal(stateOf(db, hers.id).categories.get(envelope.id)!.balance, rupees(1_500));
    assert.equal(stateOf(db, household).dueFromOtherBudgets, rupees(1_500));
    assert.deepEqual(allClose(db, [household, hers.id]), []);
    db.close();
  });

  test("more than is outstanding is refused, and so is a square balance", () => {
    const db = setup();
    const { envelope } = behindByTwoThousand(db);
    assert.throws(
      () => callItEven(db, actor, { envelopeId: envelope.id, amount: rupees(3_000), month: MONTH }),
      /Only ₹2,000 is outstanding/,
    );
    callItEven(db, actor, { envelopeId: envelope.id, amount: rupees(2_000), month: MONTH });
    assert.throws(
      () => callItEven(db, actor, { envelopeId: envelope.id, amount: rupees(100), month: MONTH }),
      /square already/,
    );
  });

  test("it is undoable, like everything else (R37)", () => {
    const db = setup();
    const { household, hers, envelope } = behindByTwoThousand(db);
    callItEven(db, actor, { envelopeId: envelope.id, amount: rupees(2_000), month: MONTH });
    assert.equal(listEvenCalls(db, envelope.id).length, 1);

    const call = listEvenCalls(db, envelope.id)[0]!;
    const event = historyFor(db, "even-call", call.id)[0]!;
    const undone = undoEvent(db, event.id, actor);
    assert.equal(undone.ok, true);

    assert.equal(listEvenCalls(db, envelope.id).length, 0);
    assert.equal(stateOf(db, hers.id).categories.get(envelope.id)!.balance, rupees(2_000));
    assert.equal(stateOf(db, household).dueFromOtherBudgets, rupees(2_000));
    assert.deepEqual(allClose(db, [household, hers.id]), []);
    db.close();
  });

  test("the amount still has an envelope next month, and the balance stays closed", () => {
    const db = setup();
    const { household, hers, envelope } = behindByTwoThousand(db);
    callItEven(db, actor, { envelopeId: envelope.id, amount: rupees(2_000), month: MONTH });

    const next = addMonths(MONTH, 1);
    for (const budgetId of [household, hers.id]) {
      const state = computeBudget(loadEngineInput(db, { through: next, budgetId }));
      for (const [month, s] of state) {
        assert.equal(identityResidual(s), 0, `${budgetId} ${month}`);
      }
    }
    db.close();
  });

  test("the given-up envelope is an ordinary one, made on demand", () => {
    const db = setup();
    const household = householdBudgetId(db);
    const category = ensureGivenUpCategory(db, actor, household);
    assert.equal(category.name, GIVEN_UP_CATEGORY);
    assert.equal(category.budget_id, household);
    assert.equal(category.commits_to_budget_id, null);
    assert.equal(ensureGivenUpCategory(db, actor, household).id, category.id);
    db.close();
  });
});

describe("P5 · 15 §6.1 · each budget closes on its own", () => {
  test("the household's month can close while a personal one stays open", () => {
    const db = setup();
    const household = householdBudgetId(db);
    const hers = ensurePersonalBudget(db, PRIYA, "Priya");
    const envelope = ensureCommitmentEnvelope(db, actor, hers.id);
    createAccount(db, actor, {
      name: "Her savings", kind: "budget", subtype: "savings",
      budgetId: hers.id, openingBalance: rupees(50_000), openingDate: todayIST(),
    });
    setAssigned(db, actor, MONTH, envelope.id, rupees(10_000));

    closeMonth(db, actor, MONTH, null, household);

    assert.equal(isClosed(db, MONTH, household), true);
    assert.equal(isClosed(db, MONTH, hers.id), false, "hers is her own to close");

    // And one person's procrastination cannot block the other's ritual.
    closeMonth(db, actor, MONTH, null, hers.id);
    assert.equal(isClosed(db, MONTH, hers.id), true);
    db.close();
  });

  test("the household's close reports what each member committed", () => {
    const db = setup();
    const household = householdBudgetId(db);
    const hers = ensurePersonalBudget(db, PRIYA, "Priya");
    const envelope = ensureCommitmentEnvelope(db, actor, hers.id);
    createAccount(db, actor, {
      name: "Her savings", kind: "budget", subtype: "savings",
      budgetId: hers.id, openingBalance: rupees(50_000), openingDate: todayIST(),
    });
    setAssigned(db, actor, MONTH, envelope.id, rupees(10_000));

    const view = monthCloseView(db, MONTH, todayIST(), household);
    assert.equal(view.budgetId, household);
    assert.deepEqual(
      view.commitments.map((c) => [c.name, c.committed, c.standing]),
      [["Priya", rupees(10_000), "behind"]],
    );

    // A personal close has nobody to report on.
    assert.deepEqual(monthCloseView(db, MONTH, todayIST(), hers.id).commitments, []);
    db.close();
  });

  test("a household with one budget closes exactly as it always did", () => {
    const db = setup();
    const household = householdBudgetId(db);
    createAccount(db, actor, {
      name: "Joint current", kind: "budget", subtype: "savings",
      openingBalance: rupees(80_000), openingDate: todayIST(),
    });
    closeMonth(db, actor, MONTH);
    assert.equal(isClosed(db, MONTH), true);
    assert.equal(isClosed(db, MONTH, household), true);
    assert.deepEqual(monthCloseView(db, MONTH).commitments, []);
    db.close();
  });
});
