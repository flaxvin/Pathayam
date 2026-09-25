/**
 * 15 §6A · When a member leaves.
 *
 * Two properties matter. **Nothing is deleted** — removal is a state, every
 * historical attribution survives, and adding them back restores them. And
 * **what is outstanding does not evaporate**: the household either gives it back,
 * records it as money owed, or the leaver lets it go, and whichever is chosen,
 * both sets of books still close.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned } from "./budget.ts";
import { createTransaction } from "./transactions.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget, identityResidual } from "../engine/engine.ts";
import { householdBudgetId, ensurePersonalBudget } from "./budgets.ts";
import { ensureCommitmentEnvelope, commitmentEnvelope } from "./commitments.ts";
import { describeDeparture, settleDeparture } from "./departure.ts";
import { listMembers, removeMember, inviteMember, getMember } from "../auth/sessions.ts";
import { listFamilyLoans } from "./family-loans.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const actor: Actor = { memberId: PRIYA, source: "ui" };
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

/** Ravi with his own budget, committing ₹10,000, and household groceries to spend on. */
function withCommitment(db: DB) {
  const household = householdBudgetId(db);
  const mine = ensurePersonalBudget(db, RAVI, "Ravi");
  const envelope = ensureCommitmentEnvelope(db, actor, mine.id);
  const account = createAccount(db, actor, {
    name: "His savings", kind: "budget", subtype: "savings",
    budgetId: mine.id, openingBalance: rupees(1_00_000), openingDate: todayIST(),
  });
  const shared = createGroup(db, actor, "Shared", "normal", household);
  const groceries = createCategory(db, actor, { groupId: shared.id, name: "Groceries" });
  setAssigned(db, actor, MONTH, envelope.id, rupees(10_000));
  return { household, mine: mine.id, envelope: envelope.id, account, groceries };
}

function allClose(db: DB, budgetIds: string[]): string[] {
  const out: string[] = [];
  for (const budgetId of budgetIds) {
    for (const [month, s] of computeBudget(loadEngineInput(db, { through: MONTH, budgetId }))) {
      if (identityResidual(s) !== 0) out.push(`${budgetId} ${month} = ${identityResidual(s)}`);
    }
  }
  return out;
}

describe("15 §6A · nothing is deleted", () => {
  test("removing keeps their name on what they entered, and adding them back restores them", () => {
    const db = setup();
    const { account, groceries } = withCommitment(db);
    createTransaction(db, actor, {
      accountId: account.id, amount: -rupees(2_000), date: todayIST(),
      categoryId: groceries.id, ownerMemberId: RAVI,
    });

    removeMember(db, actor, RAVI);
    assert.equal(listMembers(db).some((m) => m.id === RAVI), false, "gone from the household");
    assert.equal(getMember(db, RAVI)?.removed_at !== null, true, "but still there, marked removed");

    const owner = queryOne<{ owner_member_id: string }>(
      db, `SELECT owner_member_id FROM transactions WHERE amount = ?`, -rupees(2_000),
    );
    assert.equal(owner?.owner_member_id, RAVI, "his name stays on what he entered (F1.6)");

    // And back again, by the same address.
    inviteMember(db, actor, { email: "ravi@example.com" });
    assert.equal(listMembers(db).some((m) => m.id === RAVI), true);
    assert.equal(getMember(db, RAVI)?.removed_at, null);
    db.close();
  });

  test("the last member cannot be removed", () => {
    const db = setup();
    removeMember(db, actor, RAVI);
    assert.throws(() => removeMember(db, actor, PRIYA), /last member/);
    db.close();
  });
});

describe("15 §6A · what is outstanding, and every option offered", () => {
  test("money set aside and unspent is theirs to take back", () => {
    const db = setup();
    const { household, mine, envelope } = withCommitment(db);

    const departure = describeDeparture(db, RAVI);
    assert.equal(departure.standing, "overfunded");
    assert.equal(departure.outstanding, rupees(10_000));
    assert.deepEqual(departure.options, ["release"], "a loan here would invent a debt");

    // D15 · The message is read by a person: ₹10,000, not "1000000" paise.
    assert.equal(
      settleDeparture(db, actor, RAVI, "release"),
      "Released ₹10,000 back to Ravi's Ready to Assign.",
    );

    const state = computeBudget(loadEngineInput(db, { through: MONTH, budgetId: mine }))
      .get(MONTH)!;
    assert.equal(state.categories.get(envelope)!.balance, 0, "the commitment is released");
    assert.equal(
      computeBudget(loadEngineInput(db, { through: MONTH, budgetId: household }))
        .get(MONTH)!.dueFromOtherBudgets,
      0,
      "and the household's claim falls with it",
    );
    assert.deepEqual(allClose(db, [household, mine]), []);
    db.close();
  });

  test("what the household already had becomes money owed, and the books still close", () => {
    const db = setup();
    const { household, mine, envelope, account, groceries } = withCommitment(db);
    // He paid ₹18,000 of the household's groceries having put aside ₹10,000.
    setAssigned(db, actor, MONTH, groceries.id, rupees(10_000));
    createTransaction(db, actor, {
      accountId: account.id, amount: -rupees(18_000), date: todayIST(),
      categoryId: groceries.id, ownerMemberId: RAVI,
    });

    const departure = describeDeparture(db, RAVI);
    assert.equal(departure.standing, "underfunded");
    assert.equal(departure.outstanding, rupees(8_000));
    assert.deepEqual(departure.options, ["family-loan", "call-it-even"]);

    settleDeparture(db, actor, RAVI, "family-loan");

    const loans = listFamilyLoans(db);
    assert.equal(loans.length, 1, "recorded where somebody can act on it");
    assert.match(loans[0]!.counterparty, /Ravi/);

    const envelopeNow = computeBudget(loadEngineInput(db, { through: MONTH, budgetId: mine }))
      .get(MONTH)!.categories.get(envelope)!;
    assert.equal(envelopeNow.balance, 0, "closed out, so it is not counted twice");
    assert.deepEqual(allClose(db, [household, mine]), []);
    db.close();
  });

  test("or the leaver lets it go, which is calling it even", () => {
    const db = setup();
    const { household, mine, envelope, account, groceries } = withCommitment(db);
    setAssigned(db, actor, MONTH, groceries.id, rupees(10_000));
    createTransaction(db, actor, {
      accountId: account.id, amount: -rupees(18_000), date: todayIST(),
      categoryId: groceries.id, ownerMemberId: RAVI,
    });

    settleDeparture(db, actor, RAVI, "call-it-even");
    assert.equal(listFamilyLoans(db).length, 0, "nothing is owed");
    assert.equal(
      computeBudget(loadEngineInput(db, { through: MONTH, budgetId: mine }))
        .get(MONTH)!.categories.get(envelope)!.balance,
      0,
    );
    assert.deepEqual(allClose(db, [household, mine]), []);
    db.close();
  });

  test("an option that does not apply to this balance is refused", () => {
    const db = setup();
    withCommitment(db); // overfunded: releasing is the only honest ending
    assert.throws(() => settleDeparture(db, actor, RAVI, "family-loan"), /not one of the ways/);
    db.close();
  });

  test("somebody who never kept their own budget has nothing to settle", () => {
    const db = setup();
    const departure = describeDeparture(db, RAVI);
    assert.equal(departure.budgetId, null);
    assert.equal(departure.standing, "even");
    assert.deepEqual(departure.options, []);
    db.close();
  });
});
