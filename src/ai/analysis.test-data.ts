/**
 * A two-member household for the analysis tests: Priya, who keeps nothing
 * private, and Ravi, who has a personal budget with one of everything private
 * in it. Every name and amount of his is one that appears nowhere else, so a
 * match anywhere in Priya's output is unambiguous.
 *
 * `withPrivate: false` builds the same household without Ravi's private
 * things, so a test can check that Priya's totals are the totals of the world
 * she can see — the leak a planted string cannot catch, a number recovered by
 * subtraction.
 *
 * Not a `.test.ts` file: this is the fixture the analysis tests import.
 */

import { freshDb, seedMember } from "../web/harness.test-data.ts";
import type { DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, addDays, monthOf, fiscalYearOf } from "../core/dates.ts";
import { createAccount, createCard } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { createSchedule } from "../domain/schedules.ts";
import { createGoal } from "../domain/goals.ts";
import { createLoan } from "../domain/loans.ts";
import { createPolicy } from "../domain/insurance.ts";
import { saveDeclaration } from "../domain/tax.ts";
import { createAssetAccount, findOrCreateInstrument, recordPurchase } from "../domain/assets.ts";
import { units, price } from "../portfolio/holdings.ts";

export const RAVI = "m-ravi";
export const PRIYA = "m-priya";

/** Ravi's private names. None may appear in anything Priya is given. */
export const SECRET_NAMES = [
  "Zzyzx Private Account", "Qwertyuiop Envelope", "Grimalkin Therapy Clinic",
  "Snorlax Secret Subscription", "Jabberwock Private Goal", "Quokka Private Demat",
  "Bandersnatch Secret Fund", "Wombat Private Card", "Wombat Jeweller",
  "Vorpal Private Lender", "Frabjous Private Insurer", "Mine-Only Group",
];

/** Ravi's private amounts, in rupees as the analysis prints them. */
export const SECRET_AMOUNTS = ["300017.31", "999.37", "60011.17", "200013", "31007", "4321.09", "1234567"];

export interface AnalysisWorld {
  db: DB;
  ids: {
    householdAccount: string; groceries: string;
    privateAccount?: string; privateCategory?: string; privateBudget?: string;
    privateLoan?: string; privatePolicy?: string; privateCard?: string; privateGoal?: string;
    privateSchedule?: string; privateDemat?: string;
  };
}

export function buildAnalysisWorld(opts: { withPrivate?: boolean; householdTransactions?: number } = {}): AnalysisWorld {
  const withPrivate = opts.withPrivate ?? true;
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, PRIYA, "Priya");
  const ravi: Actor = { memberId: RAVI, source: "ui" };
  const priya: Actor = { memberId: PRIYA, source: "ui" };
  const today = todayIST();
  const month = monthOf(today);

  // The household's own money, which both of them see.
  const household = createAccount(db, priya, {
    name: "Joint current", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(50_000) as Paise,
  });
  const everyday = createGroup(db, priya, "Everyday");
  const groceries = createCategory(db, priya, { groupId: everyday.id, name: "Groceries" });
  setAssigned(db, priya, month, groceries.id, rupees(12_000) as Paise);
  const n = opts.householdTransactions ?? 6;
  for (let i = 0; i < n; i++) {
    createTransaction(db, priya, {
      accountId: household.id, amount: -rupees(100 + i) as Paise, date: addDays(today, -i),
      categoryId: groceries.id, payeeName: i % 2 ? "Local kirana" : "DMart", cleared: true,
      ownerMemberId: PRIYA,
    });
  }
  createSchedule(db, priya, {
    name: "Rent", accountId: household.id, categoryId: groceries.id,
    amount: -rupees(20_000) as Paise, recurrence: "monthly", nextDue: addDays(today, 5),
  });

  const ids: AnalysisWorld["ids"] = { householdAccount: household.id, groceries: groceries.id };
  if (!withPrivate) return { db, ids };

  // Ravi's personal budget, with one of everything private in it.
  const his = ensurePersonalBudget(db, RAVI, "Ravi");
  const account = createAccount(db, ravi, {
    name: "Zzyzx Private Account", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(300_017.31) as Paise,
    holderMemberId: RAVI, visibility: "private", budgetId: his.id,
  });
  const group = createGroup(db, ravi, "Mine-Only Group", "normal", his.id);
  const category = createCategory(db, ravi, { groupId: group.id, name: "Qwertyuiop Envelope" });
  setAssigned(db, ravi, month, category.id, rupees(4_321.09) as Paise);
  for (let i = 0; i < 4; i++) {
    createTransaction(db, ravi, {
      accountId: account.id, amount: -rupees(999.37) as Paise, date: addDays(today, -7 * i),
      categoryId: category.id, payeeName: "Grimalkin Therapy Clinic", cleared: true,
      ownerMemberId: RAVI,
    });
  }
  const sched = createSchedule(db, ravi, {
    name: "Snorlax Secret Subscription", accountId: account.id, categoryId: category.id,
    amount: -rupees(777) as Paise, recurrence: "monthly", nextDue: addDays(today, 3),
    isSubscription: true,
  });
  const goal = createGoal(db, ravi, {
    name: "Jabberwock Private Goal", targetAmount: rupees(50_000) as Paise, budgetId: his.id,
  });
  const demat = createAssetAccount(db, ravi, {
    name: "Quokka Private Demat", subtype: "investment", holderMemberId: RAVI, visibility: "private",
  });
  const fund = findOrCreateInstrument(db, ravi, { name: "Bandersnatch Secret Fund", kind: "mutual-fund" });
  recordPurchase(db, ravi, {
    accountId: demat.id, instrumentId: fund.id, tradeDate: addDays(today, -10),
    price: price(80), units: units(100),
  });
  const cc = createAccount(db, ravi, {
    name: "Wombat Private Card", kind: "credit", subtype: "credit-card",
    openingDate: "2025-01-01", openingBalance: 0 as Paise, holderMemberId: RAVI,
    visibility: "private", budgetId: his.id,
  });
  createCard(db, ravi, { accountId: cc.id, label: "Add-on", last4: "4242", holderMemberId: RAVI });
  createTransaction(db, ravi, {
    accountId: cc.id, amount: -rupees(60_011.17) as Paise, date: today, categoryId: category.id,
    payeeName: "Wombat Jeweller", cleared: true, ownerMemberId: RAVI,
  });
  const loan = createLoan(db, ravi, {
    lender: "Vorpal Private Lender", loanType: "personal", sanctioned: rupees(2_00_013) as Paise,
    sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 14,
    tenureMonths: 24, currentOutstanding: rupees(2_00_013) as Paise, repaymentAccountId: account.id,
    holderMemberId: RAVI, visibility: "private",
  });
  const policy = createPolicy(db, ravi, {
    insurer: "Frabjous Private Insurer", kind: "health", premium: rupees(31_007) as Paise,
    frequency: "yearly", nextDue: addDays(today, 2), taxGroup: "80d-self",
    holderMemberId: RAVI, visibility: "private", categoryId: category.id,
  });
  // His own tax figures, which are nobody else's estimate.
  saveDeclaration(db, RAVI, fiscalYearOf(today), {
    gross: rupees(12_34_567) as Paise, s80c: 0 as Paise, s80d: 0 as Paise, s80dSenior: false,
    other: 0 as Paise, hra: null, s24bOverride: null, tds: 0 as Paise,
  });

  return {
    db,
    ids: {
      ...ids,
      privateAccount: account.id, privateCategory: category.id, privateBudget: his.id,
      privateLoan: loan.id, privatePolicy: policy.id, privateCard: cc.id, privateGoal: goal.id,
      privateSchedule: sched.id, privateDemat: demat.id,
    },
  };
}
