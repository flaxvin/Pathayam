/**
 * B109 · A screen that shows one budget's money must show the one selected.
 *
 * The budget switcher moved into the chrome, which made a latent problem into a
 * visible lie: Overview, Cards, Schedules and the cashflow projection all read
 * every budget at once, so switching to "Ravi" left the household's Ready to
 * Assign, the household's card bills and the household's runway on screen under
 * his name.
 *
 * Reports and Query are deliberately different — `16` settled that they offer
 * every scope rather than picking one — so they are checked for *offering* the
 * choice and honouring it, not for following the switcher.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount, listAccounts } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned, listCategories } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { createSchedule, listSchedules } from "../domain/schedules.ts";
import { projectCashflow } from "../domain/schedules.ts";
import { queryTransactions, envelopeSpendByMonth, incomeVsExpense } from "../domain/reports.ts";
import { buildBudgetView } from "./viewmodel.ts";
import { householdBudgetId, ensurePersonalBudget } from "../domain/budgets.ts";
import { ensureCommitmentEnvelope } from "../domain/commitments.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };
const MONTH = monthOf(todayIST());

/** A household with a shared budget and one personal budget that has its own money. */
function twoBudgets() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());

  const household = householdBudgetId(db);
  const mine = ensurePersonalBudget(db, RAVI, "Ravi");
  ensureCommitmentEnvelope(db, actor, mine.id);

  const joint = createAccount(db, actor, {
    name: "Joint current", kind: "budget", subtype: "savings",
    openingBalance: rupees(80_000), openingDate: todayIST(),
  });
  const hisOwn = createAccount(db, actor, {
    name: "His savings", kind: "budget", subtype: "savings",
    budgetId: mine.id, openingBalance: rupees(30_000), openingDate: todayIST(),
  });
  const hisCard = createAccount(db, actor, {
    name: "His card", kind: "credit", subtype: "credit-card",
    budgetId: mine.id, openingBalance: -rupees(4_000), openingDate: todayIST(),
  });

  const shared = createGroup(db, actor, "Shared", "normal", household);
  const groceries = createCategory(db, actor, { groupId: shared.id, name: "Groceries" });
  const hisGroup = createGroup(db, actor, "Mine", "normal", mine.id);
  const books = createCategory(db, actor, { groupId: hisGroup.id, name: "Books" });

  setAssigned(db, actor, MONTH, groceries.id, rupees(9_000));
  setAssigned(db, actor, MONTH, books.id, rupees(3_000));
  createTransaction(db, actor, {
    accountId: joint.id, amount: -rupees(2_000), date: todayIST(), categoryId: groceries.id,
  });
  createTransaction(db, actor, {
    accountId: hisOwn.id, amount: -rupees(1_100), date: todayIST(), categoryId: books.id,
  });

  return { db, household, mine: mine.id, joint, hisOwn, hisCard, groceries: groceries.id, books: books.id };
}

describe("B109 · screens follow the budget being looked at", () => {
  test("the budget view's Ready to Assign differs per budget", () => {
    const { db, household, mine } = twoBudgets();
    const hh = buildBudgetView(db, MONTH, household).monthState.readyToAssign;
    const his = buildBudgetView(db, MONTH, mine).monthState.readyToAssign;
    assert.notEqual(hh, his);
    db.close();
  });

  test("the overview's month spend is the selected budget's, not everyone's", () => {
    const { db, household, mine } = twoBudgets();
    const hh = envelopeSpendByMonth(db, `${MONTH}-01`, todayIST(), household).at(-1)?.spent ?? 0;
    const his = envelopeSpendByMonth(db, `${MONTH}-01`, todayIST(), mine).at(-1)?.spent ?? 0;
    const all = envelopeSpendByMonth(db, `${MONTH}-01`, todayIST()).at(-1)?.spent ?? 0;

    assert.equal(hh, rupees(2_000), "the household's groceries");
    assert.equal(his, rupees(1_100), "his books");
    assert.equal(all, rupees(3_100), "and everything, when nothing is asked for");
    db.close();
  });

  test("the cashflow projection opens from the selected budget's cash", () => {
    const { db, household, mine, joint, hisOwn, books } = twoBudgets();
    // A standing instruction out of his account belongs to his projection alone.
    createSchedule(db, actor, {
      name: "Gym", amount: -rupees(1_500), recurrence: "monthly",
      nextDue: todayIST(), accountId: hisOwn.id, categoryId: books,
    });

    const hh = projectCashflow(db, { days: 40, budgetId: household });
    const his = projectCashflow(db, { days: 40, budgetId: mine });
    assert.notEqual(hh.openingBalance, his.openingBalance);
    assert.ok(hh.openingBalance > his.openingBalance, "the joint account holds more");
    assert.ok(joint.id && hisOwn.id);
    db.close();
  });

  test("a card belongs to the budget that owns its account (15 §3A.5)", () => {
    const { db, household, mine, hisCard } = twoBudgets();
    const inHousehold = buildBudgetView(db, MONTH, household);
    const inHis = buildBudgetView(db, MONTH, mine);

    const paymentIn = (view: ReturnType<typeof buildBudgetView>) =>
      [...view.categories.values()].some((c) => c.paymentAccountId === hisCard.id);

    assert.equal(paymentIn(inHis), true, "his card's envelope is on his grid");
    assert.equal(paymentIn(inHousehold), false, "and not on the household's");
    db.close();
  });
});

describe("B109 · reports offer every scope rather than picking one", () => {
  test("a query can be asked of the household, of one person, or of everything", () => {
    const { db, household, mine } = twoBudgets();
    const period = { from: `${MONTH}-01` as never, to: todayIST() };

    const all = queryTransactions(db, { ...period });
    const hh = queryTransactions(db, { ...period, budgetId: household });
    const his = queryTransactions(db, { ...period, budgetId: mine });

    assert.equal(all.length, 2);
    assert.equal(hh.length, 1);
    assert.equal(his.length, 1);
    db.close();
  });

  test("a row counts for both ends when it crosses budgets", () => {
    /*
     * His money paying for the household's groceries is his spending *and* the
     * household's, and which of those somebody means depends on the question. So
     * it appears under both scopes, rather than the app deciding for them.
     */
    const { db, household, mine, hisOwn, groceries } = twoBudgets();
    createTransaction(db, actor, {
      accountId: hisOwn.id, amount: -rupees(700), date: todayIST(), categoryId: groceries,
    });
    const period = { from: `${MONTH}-01` as never, to: todayIST() };

    const inHousehold = queryTransactions(db, { ...period, budgetId: household });
    const inHis = queryTransactions(db, { ...period, budgetId: mine });
    const crossing = (rows: { amount: number }[]) => rows.some((r) => r.amount === -rupees(700));

    assert.equal(crossing(inHousehold), true, "the envelope that paid for it");
    assert.equal(crossing(inHis), true, "and the account it came out of");
    db.close();
  });

  test("income against expense can be asked of one budget", () => {
    const { db, household, mine } = twoBudgets();
    const hh = incomeVsExpense(db, `${MONTH}-01`, todayIST(), household);
    const his = incomeVsExpense(db, `${MONTH}-01`, todayIST(), mine);
    assert.notDeepEqual(hh, his);
    db.close();
  });
});

describe("15 §3A.4 · a schedule belongs to a budget through either end", () => {
  /**
   * Found in a live database: five household bills — rent, broadband, Netflix,
   * electricity, the domestic help — vanished from the household's schedule list
   * the moment the account paying them moved into a personal budget. The account
   * was hers; the envelopes were the household's. Scoping on the account alone
   * answered "whose cash" when the list is asking "whose bills".
   *
   * The cashflow projection is deliberately still account-based: that one *is*
   * asking whose cash leaves.
   */
  test("a household bill paid from a personal account is on both lists", () => {
    const { db, household, mine, hisOwn, groceries } = twoBudgets();
    createSchedule(db, actor, {
      name: "Rent", amount: -rupees(38_000), recurrence: "monthly",
      nextDue: todayIST(), accountId: hisOwn.id, categoryId: groceries,
    });

    const inScope = (scope: string) => {
      const accounts = new Set(
        listAccounts(db, { viewerMemberId: RAVI })
          .filter((a) => a.budget_id === scope).map((a) => a.id),
      );
      const categories = new Set(
        listCategories(db, { includeHidden: true, budgetId: scope }).map((c) => c.id),
      );
      return listSchedules(db).filter((s) =>
        (!s.account_id && !s.category_id)
        || (s.account_id !== null && accounts.has(s.account_id))
        || (s.category_id !== null && categories.has(s.category_id)));
    };

    assert.equal(inScope(household).some((s) => s.name === "Rent"), true, "the household's bill");
    assert.equal(inScope(mine).some((s) => s.name === "Rent"), true, "and his account pays it");
  });
});
