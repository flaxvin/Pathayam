/**
 * P4 · Spending across budgets.
 *
 * `15` §3A.4 reduces all of this to one rule — *A's money paying for B's envelope
 * means B owes A* — and these are the cases that rule has to survive: a shared
 * card, an add-on on somebody else's card, one receipt split across two budgets,
 * and the filing that has no arrangement behind it and must be refused.
 *
 * Every case asserts both identities. That is the only check that cannot be
 * satisfied by a plausible-looking half-implementation.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount, createCard } from "./accounts.ts";
import { createGroup, createCategory, setAssigned } from "./budget.ts";
import { createTransaction } from "./transactions.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget, identityResidual } from "../engine/engine.ts";
import { householdBudgetId, ensurePersonalBudget } from "./budgets.ts";
import { ensureCommitmentEnvelope, commitmentEnvelope } from "./commitments.ts";

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

function stateOf(db: DB, budgetId: string) {
  return computeBudget(loadEngineInput(db, { through: MONTH, budgetId })).get(MONTH)!;
}

/** Every month of every budget, which is where a rollover bug hides. */
function allClose(db: DB, budgetIds: string[]): string[] {
  const out: string[] = [];
  for (const budgetId of budgetIds) {
    const state = computeBudget(loadEngineInput(db, { through: MONTH, budgetId }));
    for (const [month, s] of state) {
      const residual = identityResidual(s);
      if (residual !== 0) out.push(`${budgetId} ${month} = ${residual}`);
    }
  }
  return out;
}

describe("P4 · R6.h–j · a shared card", () => {
  test("a charge filed to a personal envelope leaves that member owing the household", () => {
    const db = setup();
    const household = householdBudgetId(db);
    const hers = ensurePersonalBudget(db, PRIYA, "Priya");
    ensureCommitmentEnvelope(db, actor, hers.id);

    // Shared: the card's account is in the household budget (15 §2).
    const card = createAccount(db, actor, {
      name: "Household card", kind: "credit", subtype: "credit-card",
      openingDate: todayIST(),
    });
    const herGroup = createGroup(db, actor, "Mine", "normal", hers.id);
    const clothes = createCategory(db, actor, { groupId: herGroup.id, name: "Clothes" });
    createAccount(db, actor, {
      name: "Her savings", kind: "budget", subtype: "savings",
      budgetId: hers.id, openingBalance: rupees(50_000), openingDate: todayIST(),
    });
    setAssigned(db, actor, MONTH, clothes.id, rupees(6_000));

    createTransaction(db, actor, {
      accountId: card.id, amount: -rupees(4_500), date: todayIST(),
      categoryId: clothes.id, ownerMemberId: PRIYA,
    });

    // Her envelope paid for it; the household's card carries the debt. So she
    // owes the household, settled against her commitment — never by adjusting
    // what the household pays the bank (R6.j).
    const envelope = commitmentEnvelope(db, hers.id)!;
    assert.equal(stateOf(db, hers.id).categories.get(envelope.id)!.balance, rupees(4_500));
    assert.equal(stateOf(db, household).dueFromOtherBudgets, rupees(4_500));
    assert.equal(stateOf(db, hers.id).categories.get(clothes.id)!.balance, rupees(1_500));
    assert.deepEqual(allClose(db, [household, hers.id]), []);
    db.close();
  });

  test("the payment envelope stays with the card, whoever spent (R6.i)", () => {
    const db = setup();
    const household = householdBudgetId(db);
    const card = createAccount(db, actor, {
      name: "Household card", kind: "credit", subtype: "credit-card", openingDate: todayIST(),
    });
    // Exactly one payment envelope, and it is in the card's budget.
    const envelopes = db.prepare(
      `SELECT id, budget_id FROM categories WHERE payment_account_id = ?`,
    ).all(card.id) as { id: string; budget_id: string }[];
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0]!.budget_id, household);

    // And the household's grid is where it appears, so the bill is funded from
    // the budget that owes it.
    const grid = stateOf(db, household).categories;
    assert.ok(grid.has(envelopes[0]!.id), "the payment envelope is on the card's own grid");
    db.close();
  });
});

describe("P4 · R6.k · an add-on on somebody else's card", () => {
  test("the add-on holder ends up owing the primary, and both budgets close", () => {
    const db = setup();
    const household = householdBudgetId(db);
    const his = ensurePersonalBudget(db, RAVI, "Ravi");
    const hers = ensurePersonalBudget(db, PRIYA, "Priya");

    // His card, in his own budget. Her add-on on it.
    const card = createAccount(db, actor, {
      name: "His card", kind: "credit", subtype: "credit-card",
      budgetId: his.id, visibility: "private", holderMemberId: RAVI,
      openingDate: todayIST(),
    });
    createCard(db, actor, {
      accountId: card.id, label: "Priya's add-on", holderMemberId: PRIYA, isPrimary: false,
    });
    createAccount(db, actor, {
      name: "Her savings", kind: "budget", subtype: "savings",
      budgetId: hers.id, openingBalance: rupees(50_000), openingDate: todayIST(),
    });
    const herGroup = createGroup(db, actor, "Mine", "normal", hers.id);
    const clothes = createCategory(db, actor, { groupId: herGroup.id, name: "Clothes" });
    setAssigned(db, actor, MONTH, clothes.id, rupees(8_000));

    createTransaction(db, actor, {
      accountId: card.id, amount: -rupees(6_200), date: todayIST(),
      categoryId: clothes.id, ownerMemberId: PRIYA,
    });

    /*
     * 15 §3A.5, worked: her Personal falls ₹6,200 and "owed to Ravi" rises
     * ₹6,200, so her books close at zero change; his card payment envelope rises
     * ₹6,200 against a claim on her of the same amount.
     */
    assert.equal(stateOf(db, hers.id).categories.get(clothes.id)!.balance, rupees(1_800));
    assert.equal(stateOf(db, his.id).dueFromOtherBudgets, rupees(6_200));
    assert.deepEqual(allClose(db, [household, his.id, hers.id]), []);
    db.close();
  });
});

describe("P4 · 15 §4 · one receipt, two budgets", () => {
  test("each line lands in its own budget and both sets of books close", () => {
    const db = setup();
    const household = householdBudgetId(db);
    const hers = ensurePersonalBudget(db, PRIYA, "Priya");
    ensureCommitmentEnvelope(db, actor, hers.id);

    const account = createAccount(db, actor, {
      name: "Her card", kind: "credit", subtype: "credit-card",
      budgetId: hers.id, visibility: "private", holderMemberId: PRIYA,
      openingDate: todayIST(),
    });
    createAccount(db, actor, {
      name: "Her savings", kind: "budget", subtype: "savings",
      budgetId: hers.id, openingBalance: rupees(60_000), openingDate: todayIST(),
    });
    const shared = createGroup(db, actor, "Shared", "normal", household);
    const groceries = createCategory(db, actor, { groupId: shared.id, name: "Groceries" });
    const herGroup = createGroup(db, actor, "Mine", "normal", hers.id);
    const personal = createCategory(db, actor, { groupId: herGroup.id, name: "Personal" });

    setAssigned(db, actor, MONTH, groceries.id, rupees(2_000));
    setAssigned(db, actor, MONTH, personal.id, rupees(1_400));
    const envelope = commitmentEnvelope(db, hers.id)!;
    setAssigned(db, actor, MONTH, envelope.id, rupees(2_000));

    createTransaction(db, actor, {
      accountId: account.id, amount: -rupees(3_400), date: todayIST(),
      ownerMemberId: PRIYA,
      splits: [
        { categoryId: groceries.id, amount: -rupees(2_000) },
        { categoryId: personal.id, amount: -rupees(1_400) },
      ],
    });

    // The household line drew on her commitment; her own line did not.
    assert.equal(stateOf(db, household).categories.get(groceries.id)!.balance, 0);
    assert.equal(stateOf(db, hers.id).categories.get(personal.id)!.balance, 0);
    assert.equal(stateOf(db, hers.id).categories.get(envelope.id)!.balance, 0);
    assert.equal(stateOf(db, household).dueFromOtherBudgets, 0);
    assert.deepEqual(allClose(db, [household, hers.id]), []);
    db.close();
  });
});

describe("P4 · R6.l · a debt nobody arranged is refused", () => {
  test("filing one personal budget's money to another's envelope, with nothing between them", () => {
    const db = setup();
    const his = ensurePersonalBudget(db, RAVI, "Ravi");
    const hers = ensurePersonalBudget(db, PRIYA, "Priya");

    const hisAccount = createAccount(db, actor, {
      name: "His savings", kind: "budget", subtype: "savings",
      budgetId: his.id, visibility: "private", holderMemberId: RAVI,
      openingBalance: rupees(50_000), openingDate: todayIST(),
    });
    const herGroup = createGroup(db, actor, "Mine", "normal", hers.id);
    const clothes = createCategory(db, actor, { groupId: herGroup.id, name: "Clothes" });

    assert.throws(
      () => createTransaction(db, actor, {
        accountId: hisAccount.id, amount: -rupees(1_000),
        date: todayIST(), categoryId: clothes.id,
      }),
      /nothing links the two/,
    );

    // A household envelope is always available, because the household budget is
    // shared by definition.
    const shared = createGroup(db, actor, "Shared", "normal", householdBudgetId(db));
    const groceries = createCategory(db, actor, { groupId: shared.id, name: "Groceries" });
    createTransaction(db, actor, {
      accountId: hisAccount.id, amount: -rupees(1_000),
      date: todayIST(), categoryId: groceries.id,
    });
    assert.deepEqual(allClose(db, [householdBudgetId(db), his.id, hers.id]), []);
    db.close();
  });
});
