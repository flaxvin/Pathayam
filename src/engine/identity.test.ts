/**
 * B90 · The identity, asserted against a real database.
 *
 * `docs/dev/01-engine-derivation.md` §1 states the equation every month must
 * satisfy, and says plainly: "If a change to the engine breaks this equation,
 * the change is wrong." `engine.test.ts` asserts it after every scenario — but
 * those scenarios are built by `Scenario`, an in-memory fixture that hands the
 * engine its input directly.
 *
 * Nothing asserted it against input assembled from actual rows. That is a real
 * gap rather than a theoretical one, because `loadEngineInput` is a substantial
 * piece of SQL that has been rewritten for speed, and a fault there cannot
 * break a single engine test: the engine would be computing correctly from
 * wrong numbers.
 *
 * It duly happened. A per-account balance fact was added to the month rollup
 * and the sealed-row dispatch ended in a bare `else`, so every balance row was
 * added to the transfer term. Every engine test passed. The identity was out by
 * a constant in every month that was old enough to seal.
 *
 * So this suite drives the domain API the way the app does, and then checks the
 * equation — the same one, from the other end.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import { nowIST, addMonths, monthOf, todayIST, type MonthKey } from "../core/dates.ts";
import { rupees, formatPaise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount, createCard } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned, setHeld, moveMoney } from "../domain/budget.ts";
import { createTransaction, createTransfer } from "../domain/transactions.ts";
import { loadEngineInput } from "./repository.ts";
import { computeBudget, identityResidual } from "./engine.ts";

const actor: Actor = { memberId: "m", source: "ui" };

/**
 * A household doing everything at once: cash and card spending, a split, an
 * overspend, money moved between envelopes, income held for next month, a
 * transfer out of the budget entirely, and an assignment into the future.
 */
function household(months: number) {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());

  const now = monthOf(todayIST());
  const start = addMonths(now, -(months - 1));
  const opened = `${start}-01` as never;

  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings", openingDate: opened,
    openingBalance: rupees(200000),
  }).id;
  const cash = createAccount(db, actor, {
    name: "Cash", kind: "budget", subtype: "cash", openingDate: opened,
    openingBalance: rupees(5000),
  }).id;
  const card = createAccount(db, actor, {
    name: "Atlas", kind: "credit", subtype: "credit-card", openingDate: opened,
    openingBalance: 0,
  }).id;
  createCard(db, actor, { accountId: card, label: "Atlas", last4: "4321", holderMemberId: "m" });
  const gold = createAccount(db, actor, {
    name: "Gold", kind: "tracking", subtype: "asset", openingDate: opened, openingBalance: 0,
  }).id;

  const group = createGroup(db, actor, "Flexible");
  const [groceries, fuel, eating, rent] = ["Groceries", "Fuel", "Eating out", "Rent"]
    .map((n) => createCategory(db, actor, { groupId: group.id, name: n }).id);

  for (let k = 0; k < months; k++) {
    const m = addMonths(start, k);
    createTransaction(db, actor, {
      accountId: bank, amount: rupees(150000), date: `${m}-01` as never, payeeName: "Salary",
    });
    for (const c of [groceries!, fuel!, eating!, rent!]) setAssigned(db, actor, m, c, rupees(20000));

    createTransaction(db, actor, {
      accountId: bank, amount: -rupees(18000), date: `${m}-05` as never,
      categoryId: rent, payeeName: "Landlord",
    });
    // R6 · a card charge consumes its envelope and creates the debt.
    createTransaction(db, actor, {
      accountId: card, amount: -rupees(26000), date: `${m}-08` as never,
      categoryId: groceries, payeeName: "Big Basket",
    });
    createTransaction(db, actor, {
      accountId: cash, amount: -rupees(1500), date: `${m}-09` as never,
      categoryId: eating, payeeName: "Chai",
    });
    createTransaction(db, actor, {
      accountId: bank, amount: -rupees(9000), date: `${m}-12` as never, payeeName: "Market",
      splits: [
        { categoryId: fuel!, amount: -rupees(5000) },
        { categoryId: eating!, amount: -rupees(4000) },
      ],
    });
    // Budget↔credit: internal, and must not touch Ready to Assign.
    createTransfer(db, actor, {
      fromAccountId: bank, toAccountId: card, amount: rupees(20000), date: `${m}-25` as never,
    });
    // Budget→tracking: money genuinely leaving the budget.
    createTransfer(db, actor, {
      fromAccountId: bank, toAccountId: gold, amount: rupees(3000), date: `${m}-26` as never,
    });
  }

  // An overspend covered from another envelope, and income held back.
  const last = addMonths(start, months - 1);
  createTransaction(db, actor, {
    accountId: bank, amount: -rupees(40000), date: `${last}-20` as never,
    categoryId: fuel, payeeName: "Car repair",
  });
  moveMoney(db, actor, {
    month: last, fromCategoryId: groceries!, toCategoryId: fuel!, amount: rupees(15000),
  });
  setHeld(db, actor, last, rupees(10000));
  // R7: assigning into a month that has not arrived yet.
  setAssigned(db, actor, addMonths(now, 1), groceries!, rupees(7000));

  return { db, now };
}

function assertIdentityFrom(db: DB, through: MonthKey, opts: { useRollup: boolean }) {
  const budget = computeBudget(loadEngineInput(db, { through, useRollup: opts.useRollup }));
  assert.ok(budget.size > 0, "no months were computed");

  const broken: string[] = [];
  for (const [month, state] of budget) {
    const residual = identityResidual(state);
    if (residual !== 0) broken.push(`${month} out by ${formatPaise(residual)}`);
  }
  assert.deepEqual(
    broken, [],
    `the identity in docs/dev/01-engine-derivation.md §1 does not hold ` +
    `(rollup ${opts.useRollup ? "in use" : "bypassed"})`,
  );
  return budget;
}

describe("B90 · the identity holds against a real database", () => {
  test("over a few months, with nothing old enough to seal", () => {
    const { db, now } = household(4);
    assertIdentityFrom(db, now, { useRollup: true });
    db.close();
  });

  test("over years, with most months served from the rollup", () => {
    // The case that was broken: everything past six months old is summarised.
    const { db, now } = household(30);
    assertIdentityFrom(db, now, { useRollup: true });
    db.close();
  });

  test("and the rollup agrees with deriving it all from the ledger", () => {
    const { db, now } = household(30);
    const warm = assertIdentityFrom(db, now, { useRollup: true });
    const cold = assertIdentityFrom(db, now, { useRollup: false });

    const differ: string[] = [];
    for (const [month, w] of warm) {
      const c = cold.get(month)!;
      if (w.readyToAssign !== c.readyToAssign) {
        differ.push(`${month}: ${formatPaise(w.readyToAssign)} vs ${formatPaise(c.readyToAssign)}`);
      }
    }
    assert.deepEqual(differ, [], "sealed months disagree with the ledger");
    db.close();
  });

  /*
   * B97 · An uncategorised card charge breaks the identity by its own amount.
   *
   * Found by leaving a few imported card transactions unreviewed — which is not
   * an edge case, it is the normal state of every card transaction between the
   * import landing and somebody filing it. The review queue exists to hold
   * exactly this.
   *
   * The payment envelope's activity is derived from the card's raw account flow
   * (`creditAccountFlow`), so it reserves against every charge whatever its
   * category. With a category, the spending category is consumed by the same
   * amount and the two cancel. With none, the envelope rises and nothing falls,
   * so the category totals exceed what the budget accounts hold.
   *
   * Marked `todo` rather than asserted, because the fix is a decision about R6
   * and not mine to take alone. The likely answer is that an envelope should
   * only ever reserve what a category actually gave up — leaving the debt
   * visibly unbudgeted, which is both true and more useful than silently
   * reserving for it. But that changes what R6 means, so it wants a deliberate
   * choice rather than a quiet patch.
   */
  test("an uncategorised card charge keeps the identity", { todo: true }, () => {
    const db = openDatabase({ path: ":memory:", verbose: false });
    ensureHousehold(db);
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
      "m", "f@e.com", "Ravi", nowIST());
    const bank = createAccount(db, actor, {
      name: "Bank", kind: "budget", subtype: "savings",
      openingDate: "2026-08-01", openingBalance: rupees(100000),
    }).id;
    const card = createAccount(db, actor, {
      name: "Card", kind: "credit", subtype: "credit-card",
      openingDate: "2026-08-01", openingBalance: 0,
    }).id;
    createCard(db, actor, { accountId: card, label: "Card", last4: "1111", holderMemberId: "m" });
    const group = createGroup(db, actor, "Flexible");
    const groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" }).id;
    setAssigned(db, actor, "2026-08", groceries, rupees(5000));

    // Categorised: the envelope reserves and the category gives up the same.
    const txn = createTransaction(db, actor, {
      accountId: card, amount: -rupees(800), date: "2026-08-10",
      categoryId: groceries, payeeName: "Shop",
    });
    assertIdentityFrom(db, "2026-08", { useRollup: false });

    // Exactly what an unreviewed import looks like.
    execute(db, `UPDATE transactions SET category_id = NULL WHERE id = ?`, txn.id);
    assertIdentityFrom(db, "2026-08", { useRollup: false });
    db.close();
  });

  test("a past month is as true as the present one", () => {
    const { db, now } = household(30);
    assertIdentityFrom(db, addMonths(now, -18), { useRollup: true });
    db.close();
  });
});
