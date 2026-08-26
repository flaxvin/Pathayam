/**
 * Development seed.
 *
 * Builds a household that exercises the parts of the engine most likely to be
 * wrong — a card with an add-on, a cash overspend, a credit overspend, a card
 * payment — so a running instance shows real behaviour rather than an empty
 * grid. Deliberately small: `assertDevLoginSafeAgainstData` treats a large
 * database as a production indicator (R38.3).
 *
 *   npm run seed
 */

import { loadConfig } from "./config.ts";
import { openDatabase, ensureHousehold, queryOne } from "./db/db.ts";
import type { Actor } from "./core/events.ts";
import { inviteMember } from "./auth/sessions.ts";
import { createAccount, createCard, paymentCategoryFor } from "./domain/accounts.ts";
import { listCategories, setAssigned } from "./domain/budget.ts";
import { createTransaction, createTransfer } from "./domain/transactions.ts";
import { applyStartingTemplate } from "./domain/starting-budget.ts";
import { rupees } from "./core/money.ts";
import { todayIST, monthOf, addDays } from "./core/dates.ts";

const system: Actor = { memberId: null, source: "system" };

function main(): void {
  const config = loadConfig();
  const db = openDatabase({ path: config.databasePath });
  ensureHousehold(db);

  const existing = queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM accounts`)?.n ?? 0;
  if (existing > 0) {
    console.error("This database already has accounts. Delete it first if you want a fresh seed.");
    process.exit(1);
  }

  const ravi = inviteMember(db, system, { email: "ravi@example.com", name: "Ravi" });
  const priya = inviteMember(db, system, { email: "priya@example.com", name: "Priya" });
  const actor: Actor = { memberId: ravi.id, source: "system" };

  const today = todayIST();
  const month = monthOf(today);
  const monthStart = `${month}-01`;

  // Q7 / L8: cash is a real Budget account, not an afterthought.
  const savings = createAccount(db, actor, {
    name: "HDFC Savings", kind: "budget", subtype: "savings", institution: "HDFC Bank",
    last4: "6604", openingBalance: rupees(178_000), openingDate: monthStart,
  });
  const cash = createAccount(db, actor, {
    name: "Cash", kind: "budget", subtype: "cash",
    openingBalance: rupees(4_000), openingDate: monthStart,
  });
  const hdfcCard = createAccount(db, actor, {
    name: "Swiggy HDFC", kind: "credit", subtype: "credit-card", institution: "HDFC Bank",
    last4: "4412", openingBalance: rupees(-8_400), openingDate: monthStart,
    statementDay: 18, dueDay: 5,
  });
  const axisCard = createAccount(db, actor, {
    name: "Axis Atlas", kind: "credit", subtype: "credit-card", institution: "Axis Bank",
    last4: "3150", openingDate: monthStart, statementDay: 22, dueDay: 10,
  });

  // 09 §4: Priya's 3162 is an add-on on Ravi's Axis account, sharing its
  // limit, statement and payment — not a credit account of its own.
  const addOn = createCard(db, actor, {
    accountId: axisCard.id, label: "Axis Atlas — Priya", last4: "3162", holderMemberId: priya.id,
  });

  applyStartingTemplate(db, actor, {
    monthlyIncome: rupees(165_000),
    hasEmis: true,
    hasSchoolFees: false,
    hasDomesticHelp: true,
  });

  const categories = new Map(listCategories(db).map((c) => [c.name, c.id]));
  const id = (name: string): string => {
    const found = categories.get(name);
    if (!found) throw new Error(`seed: no category named ${name}`);
    return found;
  };

  for (const [name, amount] of [
    ["Rent", 41_000], ["Groceries", 16_000], ["Vegetables", 3_000], ["Milk", 2_400],
    ["Eating out", 6_500], ["Fuel", 6_000], ["Cab / auto", 3_000], ["Electricity", 3_200],
    ["Broadband", 1_200], ["Mobile recharge", 1_600], ["Household", 3_000], ["Personal", 5_000],
    ["EMIs", 16_000], ["Diwali", 8_400], ["Medical", 4_000], ["Investments", 25_000],
    ["Domestic help", 5_000], ["Parental support", 8_000],
  ] as const) {
    setAssigned(db, actor, month, id(name), rupees(amount));
  }

  const spend = (
    account: string, category: string, amount: number, payee: string, daysAgo: number,
    opts: { cardId?: string; owner?: string } = {},
  ) =>
    createTransaction(db, actor, {
      accountId: account,
      amount: rupees(-amount),
      date: addDays(today, -daysAgo),
      categoryId: id(category),
      payeeName: payee,
      cleared: daysAgo > 3,
      cardId: opts.cardId,
      ownerMemberId: opts.owner,
    });

  spend(savings.id, "Rent", 41_000, "Landlord", 20);
  spend(savings.id, "Electricity", 2_850, "BESCOM", 14);
  spend(savings.id, "Broadband", 1_199, "ACT Fibernet", 12);
  spend(cash.id, "Vegetables", 640, "Local market", 6);
  spend(cash.id, "Milk", 420, "Milk vendor", 4);

  // A cash overspend, so R4 is visible on a running instance.
  spend(savings.id, "Groceries", 9_400, "DMart", 11);
  spend(hdfcCard.id, "Groceries", 7_100, "Big Basket", 5);

  spend(hdfcCard.id, "Eating out", 2_400, "Toit", 8);
  spend(hdfcCard.id, "Eating out", 1_850, "Swiggy", 3);

  // A credit overspend on the add-on card, which must not reduce RTA (R6),
  // and must be attributed to Priya rather than to the primary holder (R6.c).
  spend(axisCard.id, "Personal", 6_200, "Nykaa", 7, { cardId: addOn.id, owner: priya.id });
  spend(axisCard.id, "Fuel", 3_400, "Indian Oil", 9);

  // Paying a card is a transfer and touches no spending category.
  const hdfcPayment = paymentCategoryFor(db, hdfcCard.id)!;
  setAssigned(db, actor, month, hdfcPayment.id, rupees(8_400));
  createTransfer(db, actor, {
    fromAccountId: savings.id, toAccountId: hdfcCard.id,
    amount: rupees(8_400), date: addDays(today, -2),
  });

  // ATM withdrawal as a transfer into Cash (Q7).
  createTransfer(db, actor, {
    fromAccountId: savings.id, toAccountId: cash.id,
    amount: rupees(5_000), date: addDays(today, -10),
  });

  console.log(`Seeded a household: 2 members, 4 accounts, ${categories.size} categories.`);
  console.log(`Run with DEV_LOGIN=true and sign in as Ravi or Priya.`);
  db.close();
}

main();
