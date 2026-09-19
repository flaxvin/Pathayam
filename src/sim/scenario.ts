/**
 * The standing scenario: thirty-six months of a household of four.
 *
 * Every top-down check of this app runs against *this* household, so that a
 * regression has one place to show up and one shape to show up in. The shape is
 * fixed:
 *
 * - **Four members**, not two. Two of them keep budgets of their own, which is
 *   the only way commitments, claims, squaring up and per-budget month closes
 *   have anything to act on.
 * - **Thirty-six months**, ending in the current one, so rollover has actually
 *   rolled, a loan is mid-tenure, and XIRR has something to chew on.
 * - **Two members leave at month 24**, settled two different ways — one released,
 *   one turned into a family loan — because those are different arithmetic and
 *   both have to hold.
 * - **One of them comes back at month 30**, which is the case that tells you
 *   whether removal was a state or a deletion (F1.6 says a state).
 *
 * And it exercises the whole surface: every mutating function the domain
 * exports is called at least once, which `scenario.test.ts` asserts rather than
 * hopes. That is what makes this a *top-down* test — not that it touches many
 * screens, but that nothing in the domain goes unexercised while the identity is
 * being checked after every single month.
 *
 * Deterministic: one seed, and every date derived from the day it runs. Two runs
 * on the same day produce the same household to the paisa.
 */

import type { DB } from "../db/db.ts";
import { queryOne, queryAll } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";
import {
  todayIST, monthOf, addMonths, addDays, firstDayOfMonth, lastDayOfMonth,
  type IsoDate, type MonthKey,
} from "../core/dates.ts";
import { inviteMember, removeMember, listMembers } from "../auth/sessions.ts";
import {
  createAccount, updateAccount, closeAccount, reopenAccount, createCard, closeCard,
  recordCardStatement, paymentCategoryFor,
} from "../domain/accounts.ts";
import {
  listCategories, createGroup, renameGroup, deleteGroup, createCategory, renameCategory,
  mergeCategories,
  moveCategoryToGroup, reorderCategory, reorderGroup, setCategoryHidden, deleteCategory,
  setTarget, clearTarget, setAssigned, addAssigned, copyAssignmentsFromMonth, moveMoney,
  setHeld, startPersonalBudget,
} from "../domain/budget.ts";
import {
  createTransaction, updateTransaction, deleteTransaction, restoreTransaction,
  createTransfer, resolvePayee, mergePayees, setTags,
} from "../domain/transactions.ts";
import { applyStartingTemplate } from "../domain/starting-budget.ts";
import { reconcile } from "../domain/reconciliation.ts";
import { addAttachment, deleteAttachment } from "../domain/attachments.ts";
import {
  createLoan, recordInstalment, recordDisbursement, recordLoanStatement, recordRateChange,
  recordPrepayment, closeLoan, listLoans, projectLoan, paymentCategoryForLoan,
} from "../domain/loans.ts";
import { convertToEmi } from "../domain/card-emi.ts";
import {
  createSchedule, updateSchedule, deleteSchedule, markPaid, skipOccurrence,
} from "../domain/schedules.ts";
import { createGoal, updateGoal, completeGoal, deleteGoal } from "../domain/goals.ts";
import {
  createFamilyLoan, recordAdvance, recordRepayment, writeOffFamilyLoan, closeFamilyLoan,
  reopenFamilyLoan, listFamilyLoans,
} from "../domain/family-loans.ts";
import {
  createAssetAccount, findOrCreateInstrument, classifyInstrument, recordPurchase, recordSale,
  recordDividend, recordSplit, recordMerger, recordReturnOfCapital, recordValuation,
  recordPrice, recordFxRate, listHoldings,
} from "../domain/assets.ts";
import { snapshotNetWorth } from "../domain/networth.ts";
import { closeMonth, reopenMonth } from "../domain/month-close.ts";
import { householdBudgetId, ensurePersonalBudget, listBudgets } from "../domain/budgets.ts";
import { ensureCommitmentEnvelope, prepareClaim } from "../domain/commitments.ts";
import { callItEven, ensureGivenUpCategory } from "../domain/squaring-up.ts";
import { describeDeparture, settleDeparture } from "../domain/departure.ts";
import { setMutedKinds } from "../domain/digest.ts";
import {
  parseDelimited, guessMapping, applyMapping, headerSignature, type RawRecord,
} from "../import/csv.ts";
import {
  ingest, listStaged, approveStaged, rejectStaged, mergeStaged, undoBatch,
} from "../import/pipeline.ts";
import { saveProfile, markProfileUsed, deleteProfile } from "../import/profiles.ts";
import {
  proposeCategoryRules, proposePayeeRule, suppress, setLearningEnabled,
  previewRetroactive, applyRetroactive, confirmRule, dismissRule,
} from "../import/learning.ts";
import type { RuleStage } from "../import/rules.ts";
import { planCasImport, applyCasPlan } from "../import/cas-plan.ts";
import { setIdentity, clearIdentity } from "../import/identity.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget } from "../engine/engine.ts";
import { units as toUnits, price as toPrice } from "../portfolio/holdings.ts";

export const SCENARIO_MONTHS = 36;

/** What the household keeps unassigned, so the next month starts with something. */
const FLOAT = 60_000 * 100;

/**
 * The member a demo instance signs you in as, and therefore the one who must
 * still be here when the simulation finishes.
 *
 * `/demo/enter` takes the oldest member who has not been removed, so this is
 * Ravi by construction — but by construction is not the same as on purpose. He
 * is named here, kept out of every departure, and checked by the test, because
 * a scenario that removed him would leave the demo signing somebody in as a
 * person the household no longer has: their own budget on screen, their name in
 * the corner, and no row for them on the page that lists who is here.
 */
export const SIGNED_IN_AS = "ravi" as const;
/** Month index (0-based) at which two members leave. */
export const DEPARTURE_AT = 23;
/** Month index at which one of them comes back. */
export const RETURN_AT = 29;

export interface SimMember {
  id: string;
  name: string;
  email: string;
}

export interface SimResult {
  months: MonthKey[];
  members: Record<"ravi" | "priya" | "anil" | "meera", SimMember>;
  /** Whose budget is whose, for a test that wants to check one of them. */
  budgets: { household: string; ravi: string; anil: string };
  accounts: Record<string, string>;
  /** Every domain function the run actually called, and how often. */
  calls: Map<string, number>;
  /** A human-readable trace, for when an invariant breaks and you need why. */
  log: string[];
  /** Called after each month is built, before the next begins. */
  monthsBuilt: MonthKey[];
}

export interface SimOptions {
  months?: number;
  seed?: number;
  /** Run after each month, so a test can assert the identity as history grows. */
  afterMonth?: (month: MonthKey, index: number) => void;
}

/** An 8-byte PNG header plus the minimum chunks: enough to be a real receipt. */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const PAYEES = {
  grocers: ["DMart", "Big Basket", "Zepto", "Blinkit", "Local kirana"],
  food: ["Swiggy", "Zomato", "Third Wave Coffee", "Toit", "Chai Point"],
  travel: ["Uber", "Ola", "Rapido", "Indian Oil", "Namma Metro"],
  shops: ["Amazon", "Myntra", "Nykaa", "Decathlon", "Croma"],
  utility: ["BESCOM", "ACT Fibernet", "Airtel", "Bangalore Water Supply"],
  health: ["Apollo Pharmacy", "Practo", "1mg"],
} as const;

export function simulateHousehold(db: DB, opts: SimOptions = {}): SimResult {
  const MONTHS = opts.months ?? SCENARIO_MONTHS;
  const calls = new Map<string, number>();
  const log: string[] = [];
  const monthsBuilt: MonthKey[] = [];

  /** Every domain call goes through here, so coverage is a fact rather than a hope. */
  function did<T>(name: string, fn: () => T): T {
    calls.set(name, (calls.get(name) ?? 0) + 1);
    return fn();
  }
  const note = (month: MonthKey, what: string): void => { log.push(`${month}  ${what}`); };

  let seed = (opts.seed ?? 20260914) >>> 0;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const between = (lo: number, hi: number): number => Math.round(lo + rand() * (hi - lo));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const tidy = (n: number): number => Math.round(n / 10) * 10;

  const today = todayIST();
  const thisMonth = monthOf(today);
  const start = addMonths(thisMonth, -(MONTHS - 1));
  const months: MonthKey[] = [];
  for (let i = 0; i < MONTHS; i++) months.push(addMonths(start, i));
  const opened = firstDayOfMonth(start);
  const day = (month: MonthKey, d: number): IsoDate =>
    `${month}-${String(Math.min(d, Number(lastDayOfMonth(month).slice(-2)))).padStart(2, "0")}`;

  // ------------------------------------------------------------------ people
  const ravi = did("inviteMember", () =>
    inviteMember(db, { memberId: null, source: "system" }, { email: "ravi@example.com", name: "Ravi" }));
  const actor: Actor = { memberId: ravi.id, source: "system" };
  const priya = did("inviteMember", () =>
    inviteMember(db, actor, { email: "priya@example.com", name: "Priya" }));
  const anil = did("inviteMember", () =>
    inviteMember(db, actor, { email: "anil@example.com", name: "Anil" }));
  const meera = did("inviteMember", () =>
    inviteMember(db, actor, { email: "meera@example.com", name: "Meera" }));

  // ---------------------------------------------------------------- accounts
  const acc = {
    savings: did("createAccount", () => createAccount(db, actor, {
      name: "HDFC Savings", kind: "budget", subtype: "savings", institution: "HDFC Bank",
      last4: "6604", openingBalance: rupees(96_000), openingDate: opened, holderMemberId: ravi.id,
    })).id,
    priyaSavings: did("createAccount", () => createAccount(db, actor, {
      name: "Kotak Savings", kind: "budget", subtype: "savings", institution: "Kotak Mahindra Bank",
      last4: "6631", openingBalance: rupees(58_000), openingDate: opened, holderMemberId: priya.id,
    })).id,
    current: did("createAccount", () => createAccount(db, actor, {
      name: "ICICI Current", kind: "budget", subtype: "current", institution: "ICICI Bank",
      last4: "6612", openingBalance: rupees(24_000), openingDate: opened, holderMemberId: ravi.id,
    })).id,
    cash: did("createAccount", () => createAccount(db, actor, {
      name: "Cash", kind: "budget", subtype: "cash",
      openingBalance: rupees(6_000), openingDate: opened,
    })).id,
    meeraSavings: did("createAccount", () => createAccount(db, actor, {
      name: "SBI Savings", kind: "budget", subtype: "savings", institution: "State Bank of India",
      last4: "2290", openingBalance: rupees(41_000), openingDate: opened, holderMemberId: meera.id,
    })).id,
    hdfcCard: did("createAccount", () => createAccount(db, actor, {
      name: "Swiggy HDFC", kind: "credit", subtype: "credit-card", institution: "HDFC Bank",
      last4: "4412", openingBalance: rupees(-6_200), openingDate: opened,
      statementDay: 18, dueDay: 5, holderMemberId: ravi.id, creditLimit: rupees(3_00_000),
    })).id,
    priyaCard: did("createAccount", () => createAccount(db, actor, {
      name: "Amazon Pay ICICI", kind: "credit", subtype: "credit-card", institution: "ICICI Bank",
      last4: "7731", openingDate: opened, statementDay: 14, dueDay: 2, holderMemberId: priya.id,
    })).id,
    axisCard: did("createAccount", () => createAccount(db, actor, {
      name: "Axis Atlas", kind: "credit", subtype: "credit-card", institution: "Axis Bank",
      last4: "3150", openingDate: opened, statementDay: 22, dueDay: 10, holderMemberId: ravi.id,
    })).id,
    ppf: did("createAccount", () => createAccount(db, actor, {
      name: "PPF", kind: "tracking", subtype: "asset",
      openingBalance: rupees(3_10_000), openingDate: opened,
    })).id,
    hisOwn: "",
    anilOwn: "",
    addOn: "",
  };
  // An add-on on Ravi's card, carried by Priya: R6.e's case, liable to the holder.
  acc.addOn = did("createCard", () => createCard(db, actor, {
    accountId: acc.axisCard, label: "Axis Atlas — Priya", last4: "3162", holderMemberId: priya.id,
  })).id;

  did("applyStartingTemplate", () => applyStartingTemplate(db, actor, {
    monthlyIncome: rupees(1_45_000), hasEmis: true, hasSchoolFees: true, hasDomesticHelp: true,
  }));

  const catIds = new Map(listCategories(db).map((c) => [c.name, c.id]));
  /*
   * The starting template's own names, which are what a household actually
   * gets. Naming them here rather than inventing parallel ones keeps the
   * scenario spending into the envelopes the app itself created.
   */
  const cat = (name: string): string => {
    const found = catIds.get(name);
    if (!found) throw new Error(`scenario: no category named ${name}`);
    return found;
  };
  const cardCat = paymentCategoryFor(db, acc.hdfcCard)!;
  const axisCat = paymentCategoryFor(db, acc.axisCard)!;
  const priyaCardCat = paymentCategoryFor(db, acc.priyaCard)!;

  // -------------------------------------------------------- budget furniture
  const household = householdBudgetId(db);
  const extras = did("createGroup", () => createGroup(db, actor, "Now and then"));
  const gifts = did("createCategory", () =>
    createCategory(db, actor, { groupId: extras.id, name: "Gifts and treats" }));
  const repairs = did("createCategory", () =>
    createCategory(db, actor, { groupId: extras.id, name: "Repairs" }));
  const doomed = did("createCategory", () =>
    createCategory(db, actor, { groupId: extras.id, name: "Subscriptions we cancelled" }));

  did("renameGroup", () => renameGroup(db, actor, extras.id, "Now and again"));
  did("renameCategory", () => renameCategory(db, actor, repairs.id, "Repairs and upkeep"));
  did("reorderCategory", () => reorderCategory(db, actor, gifts.id, "down"));
  did("reorderGroup", () => reorderGroup(db, actor, extras.id, "up"));
  did("setTarget", () => setTarget(db, actor, gifts.id, { type: "monthly", amount: rupees(3_000) }));
  did("setTarget", () => setTarget(db, actor, cat("Groceries"), { type: "monthly", amount: rupees(22_000) }));
  did("setCategoryHidden", () => setCategoryHidden(db, actor, doomed.id, true));

  // ------------------------------------------------- two budgets of their own
  /*
   * Ravi consults and keeps his income in his own account; Anil is a brother who
   * lives with them and pays a fixed share. Two committing budgets rather than
   * one, because the claim arithmetic only gets interesting when the household
   * owes one member and is owed by another in the same month.
   */
  const hisBudget = did("ensurePersonalBudget", () => ensurePersonalBudget(db, ravi.id, "Ravi"));
  const hisEnvelope = did("ensureCommitmentEnvelope", () =>
    ensureCommitmentEnvelope(db, actor, hisBudget.id));
  const anilBudget = did("ensurePersonalBudget", () => ensurePersonalBudget(db, anil.id, "Anil"));
  const anilEnvelope = did("ensureCommitmentEnvelope", () =>
    ensureCommitmentEnvelope(db, actor, anilBudget.id));
  did("startPersonalBudget", () => startPersonalBudget(db, actor, anilBudget.id));

  acc.hisOwn = did("createAccount", () => createAccount(db, actor, {
    name: "IDFC Savings", kind: "budget", subtype: "savings", institution: "IDFC First Bank",
    last4: "9014", openingBalance: rupees(1_40_000), openingDate: opened,
    holderMemberId: ravi.id, budgetId: hisBudget.id, visibility: "private",
  })).id;
  acc.anilOwn = did("createAccount", () => createAccount(db, actor, {
    name: "Axis Savings", kind: "budget", subtype: "savings", institution: "Axis Bank",
    last4: "7788", openingBalance: rupees(62_000), openingDate: opened,
    holderMemberId: anil.id, budgetId: anilBudget.id,
  })).id;

  const hisGroup = did("createGroup", () => createGroup(db, actor, "Mine", "normal", hisBudget.id));
  const hisBooks = did("createCategory", () =>
    createCategory(db, actor, { groupId: hisGroup.id, name: "Books and courses" }));
  const anilGroup = did("createGroup", () => createGroup(db, actor, "Mine", "normal", anilBudget.id));
  const anilOut = did("createCategory", () =>
    createCategory(db, actor, { groupId: anilGroup.id, name: "Going out" }));
  /*
   * Somewhere for what is left to go. A personal budget whose income is larger
   * than its commitment leaves a pile in Ready to Assign otherwise — ₹31 lakh of
   * it by month thirty-six, which is not money management, it is money ignored.
   * Assigning the surplus to a savings envelope is what a person actually does,
   * and it is what makes the budget screen read as finished rather than
   * abandoned.
   */
  const hisSavings = did("createCategory", () =>
    createCategory(db, actor, { groupId: hisGroup.id, name: "Set aside" }));
  const anilSavings = did("createCategory", () =>
    createCategory(db, actor, { groupId: anilGroup.id, name: "Set aside" }));

  did("setTarget", () => setTarget(db, actor, hisEnvelope.id, { type: "monthly", amount: rupees(40_000) }));
  did("setTarget", () => setTarget(db, actor, anilEnvelope.id, { type: "monthly", amount: rupees(18_000) }));

  // ------------------------------------------------------------------- loans
  const eduLoan = did("createLoan", () => createLoan(db, actor, {
    lender: "Union Bank of India", nickname: "Education loan", loanType: "education",
    interestModel: "reducing", annualRatePct: 10.25,
    sanctioned: rupees(12_00_000), sanctionDate: `${addMonths(start, -30)}-01`,
    tenureMonths: 120, firstInstalmentDate: firstDayOfMonth(start),
    currentOutstanding: rupees(10_20_000), historyFrom: firstDayOfMonth(start),
    repaymentAccountId: acc.savings,
  }));
  const personalTakenIn = months[14]!;
  const personalLoan = did("createLoan", () => createLoan(db, actor, {
    lender: "Axis Bank", nickname: "Axis personal loan", loanType: "personal",
    interestModel: "flat", annualRatePct: 11.5,
    sanctioned: rupees(4_00_000), sanctionDate: `${personalTakenIn}-08`,
    tenureMonths: 36, firstInstalmentDate: `${addMonths(personalTakenIn, 1)}-05`,
    repaymentAccountId: acc.savings,
  }));
  did("recordDisbursement", () => recordDisbursement(db, actor, {
    loanId: personalLoan.id, date: `${personalTakenIn}-08`, amount: rupees(4_00_000),
    destination: "budget-account", destinationAccountId: acc.savings,
  }));
  // A tranche that never touches the budget: R15.3's builder payment.
  const homeLoan = did("createLoan", () => createLoan(db, actor, {
    lender: "SBI", nickname: "Home loan", loanType: "home-under-construction",
    interestModel: "reducing", annualRatePct: 8.6,
    sanctioned: rupees(45_00_000), sanctionDate: `${months[8]!}-12`,
    tenureMonths: 240, repaymentAccountId: acc.savings,
  }));
  did("recordDisbursement", () => recordDisbursement(db, actor, {
    loanId: homeLoan.id, date: `${months[9]!}-05`, amount: rupees(9_00_000),
    destination: "third-party", note: "Builder — slab 1",
  }));

  // ------------------------------------------------------------- investments
  const demat = did("createAssetAccount", () =>
    createAssetAccount(db, actor, { name: "Zerodha", subtype: "investment" }));
  const gold = did("createAssetAccount", () =>
    createAssetAccount(db, actor, { name: "Gold (SafeGold)", subtype: "commodity" }));
  const nps = did("createAssetAccount", () =>
    createAssetAccount(db, actor, { name: "NPS Tier I", subtype: "retirement" }));
  /*
   * N7 · An account held in another currency, which the feature flag allowed and
   * no scenario ever created. Priya worked in Singapore for two years before the
   * household moved back and the balance stayed where it was: an ordinary reason
   * for an Indian household to hold a foreign account, and the one case where a
   * hand-entered valuation is not in rupees.
   */
  const overseas = did("createAssetAccount", () => createAssetAccount(db, actor, {
    name: "DBS Singapore (savings)", subtype: "deposit", currency: "SGD",
  }));

  const flexi = did("findOrCreateInstrument", () => findOrCreateInstrument(db, actor, {
    name: "Parag Parikh Flexi Cap Fund - Direct Plan - Growth",
    kind: "mutual-fund", symbol: "122639", isin: "INF879O01019", provider: "mfapi",
  }));
  const index = did("findOrCreateInstrument", () => findOrCreateInstrument(db, actor, {
    name: "UTI Nifty 50 Index Fund - Direct Plan - Growth",
    kind: "mutual-fund", symbol: "120716", isin: "INF789F01XA0", provider: "mfapi",
  }));
  const apple = did("findOrCreateInstrument", () => findOrCreateInstrument(db, actor, {
    name: "Apple Inc", kind: "equity", symbol: "AAPL", currency: "USD", provider: "alphavantage",
  }));
  did("classifyInstrument", () =>
    classifyInstrument(db, actor, flexi.id, { assetClass: "equity", region: "domestic" }));
  did("classifyInstrument", () =>
    classifyInstrument(db, actor, apple.id, { assetClass: "equity", region: "international" }));

  let flexiNav = 58, indexNav = 112, applePrice = 168, usdInr = 82.5, sgdInr = 61.2;
  let goldValue = 1_90_000, npsValue = 2_40_000;
  // In Singapore dollars, because that is what the account is in.
  let overseasValue = 42_000;

  // --------------------------------------------------------------- schedules
  const rentSchedule = did("createSchedule", () => createSchedule(db, actor, {
    /*
     * Paid from Ravi's own account against the household's envelope, which is
     * what a commitment is *for*: the money stays in his account until a shared
     * bill is actually paid out of it, and that is what draws the commitment
     * down. Pointed at the joint account instead, his envelope would only ever
     * grow, and the household page would show a number nobody could explain.
     */
    name: "Rent", accountId: acc.hisOwn, categoryId: cat("Rent"),
    amount: -rupees(38_000) as Paise, recurrence: "monthly", nextDue: day(months[0]!, 3),
  }));
  const salarySchedule = did("createSchedule", () => createSchedule(db, actor, {
    // Money coming in: a positive amount and no envelope, which is the only
    // shape the guard lets through without one.
    name: "Rent from the Kochi flat", accountId: acc.savings, amount: rupees(12_000),
    recurrence: "monthly", nextDue: day(months[0]!, 20),
  }));
  const gymSchedule = did("createSchedule", () => createSchedule(db, actor, {
    name: "Cult.fit", accountId: acc.priyaCard, categoryId: cat("Medical"),
    amount: -rupees(1_499) as Paise, recurrence: "monthly", nextDue: day(months[0]!, 12),
    isSubscription: true,
  }));

  // ------------------------------------------------------------------- goals
  const tripGoal = did("createGoal", () => createGoal(db, actor, {
    name: "Kerala trip", targetAmount: rupees(1_20_000),
    targetDate: `${months[20]!}-01`, budgetId: household,
  }));
  const laptopGoal = did("createGoal", () => createGoal(db, actor, {
    name: "New laptop", targetAmount: rupees(1_40_000), budgetId: hisBudget.id,
  }));
  const abandonedGoal = did("createGoal", () => createGoal(db, actor, {
    name: "Standing desk", targetAmount: rupees(30_000), budgetId: household,
  }));
  /*
   * One goal that is never finished and never abandoned, because the other two
   * are: the trip is completed in the last month and the desk is deleted in the
   * first, and a household with no goal in progress has nothing to show on the
   * screen that exists to show progress.
   */
  const emergencyGoal = did("createGoal", () => createGoal(db, actor, {
    name: "Emergency fund", targetAmount: rupees(6_00_000),
    targetDate: `${addMonths(thisMonth, 20)}-01`, budgetId: household,
  }));
  did("updateGoal", () => updateGoal(db, actor, tripGoal.id, {
    name: "Kerala trip", targetAmount: rupees(1_35_000), targetDate: `${months[20]!}-01`,
  }));
  did("deleteGoal", () => deleteGoal(db, actor, abandonedGoal.id));

  // ------------------------------------------------------- lending to family
  const cousin = did("createFamilyLoan", () => createFamilyLoan(db, actor, {
    counterparty: "Cousin Arun", agreedTotal: rupees(60_000), holderMemberId: ravi.id,
  }));
  const neighbour = did("createFamilyLoan", () => createFamilyLoan(db, actor, {
    counterparty: "Neighbour Suresh", holderMemberId: priya.id, visibility: "private",
  }));

  did("setMutedKinds", () => setMutedKinds(db, actor, ["subscription-due"]));

  // =========================================================== the month loop
  let emiConverted = false;
  let ratesChanged = false;
  let prepaid = false;
  let reconciled = false;

  const spend = (
    account: string, category: string | null, amount: number, payee: string, date: IsoDate,
    extra: { cardId?: string; owner?: string; cleared?: boolean } = {},
  ) => did("createTransaction", () => createTransaction(db, actor, {
    accountId: account, amount: rupees(-Math.max(10, amount)) as Paise, date,
    categoryId: category, payeeName: payee,
    cleared: extra.cleared ?? date < addDays(today, -3),
    cardId: extra.cardId,
    ownerMemberId: extra.owner ?? (rand() < 0.4 ? priya.id : ravi.id),
  }));

  months.forEach((month, ix) => {
    const isCurrent = month === thisMonth;
    const cap = isCurrent ? Number(today.slice(-2)) : 28;
    const live = (d: number): boolean => d <= cap;
    const departed = ix > DEPARTURE_AT;
    const anilHere = !departed || ix > RETURN_AT;

    // --------------------------------------------------------------- income
    if (live(28)) {
      const raise = 1 + Math.floor(ix / 12) * 0.08;
      const salary = tidy(78_000 * raise);
      did("createTransaction", () => createTransaction(db, actor, {
        accountId: acc.priyaSavings, amount: rupees(salary), date: day(month, 28),
        payeeName: "Salary — Nirvana Labs", cleared: true, ownerMemberId: priya.id,
      }));
      if (month.endsWith("-03")) {
        did("createTransaction", () => createTransaction(db, actor, {
          accountId: acc.priyaSavings, amount: rupees(tidy(salary * between(8, 16) / 10)),
          date: day(month, 28), payeeName: "Annual bonus", cleared: true, ownerMemberId: priya.id,
        }));
      }
    }

    // Ravi's consulting, into his own budget's account.
    const invoices = rand() < 0.1 ? 0 : between(1, 3);
    for (let c = 0; c < invoices; c++) {
      const d = between(2, 26);
      if (!live(d)) continue;
      did("createTransaction", () => createTransaction(db, actor, {
        accountId: acc.hisOwn, amount: rupees(tidy(between(34_000, 96_000) * (rand() < 0.14 ? 2.4 : 1))),
        date: day(month, d), cleared: true, ownerMemberId: ravi.id,
        payeeName: pick(["Consulting retainer", "Client invoice", "Project milestone"]),
      }));
    }

    /*
     * Anil's salary, into his own account — while he is here.
     *
     * On the 26th, not the 30th. A past month is only simulated to the 28th, so
     * a payday on the 30th never happened at all: his budget ran for three years
     * on its opening balance, Ready to Assign went further into the red every
     * month, and every figure downstream of it was wrong in a way that looked
     * like an engine bug rather than a missing transaction.
     */
    if (anilHere && live(26)) {
      did("createTransaction", () => createTransaction(db, actor, {
        accountId: acc.anilOwn, amount: rupees(tidy(between(52_000, 58_000))),
        date: day(month, 26), payeeName: "Salary — Fern Systems",
        cleared: true, ownerMemberId: anil.id,
      }));
    }

    // Meera's pension, into the household, while she is here.
    if (!departed && live(5)) {
      did("createTransaction", () => createTransaction(db, actor, {
        accountId: acc.meeraSavings, amount: rupees(24_000), date: day(month, 5),
        payeeName: "Pension", cleared: true, ownerMemberId: meera.id,
      }));
    }

    /*
     * ----------------------------------------------------------- assignment
     *
     * Zero-based means you can only assign money you actually have, so this
     * reads Ready to Assign and stops when it runs out — the same discipline
     * the app asks of a person, and the only way a simulated household stays a
     * plausible one. Copying last month's numbers blind, which is what this did
     * first, drifted into Ready to Assign at minus sixty-two lakh by month
     * thirty-six: arithmetically consistent, and not a household anybody would
     * recognise.
     *
     * Order is the priority: the roof first, then food and the bills, then the
     * cards, then whatever is left goes to the goals.
     */
    const available = (): number => {
      const state = computeBudget(loadEngineInput(db, { through: month, budgetId: household })).get(month);
      return state?.readyToAssign ?? 0;
    };
    const fund = (categoryId: string, wanted: number): void => {
      const room = available();
      if (room <= 0) return;
      const amount = Math.min(rupees(wanted), room);
      if (amount <= 0) return;
      did("addAssigned", () => addAssigned(db, actor, month, categoryId, amount as Paise));
    };

    if (ix === 0) {
      did("setAssigned", () => setAssigned(db, actor, month, cat("Rent"), rupees(1) as Paise));
      did("copyAssignmentsFromMonth", () => copyAssignmentsFromMonth(db, actor, month, month));
    } else if (ix % 9 === 4) {
      // Once in a while they start from last month rather than from zero, which
      // is what the button is for — and then top up below like any other month.
      did("copyAssignmentsFromMonth", () => copyAssignmentsFromMonth(db, actor, months[ix]!, months[ix - 1]!));
    }

    /*
     * The loans get their EMIs, because that is what their envelopes are for:
     * the instalment is paid out of the envelope, the way a card's bill is.
     */
    for (const loan of listLoans(db)) {
      const envelope = paymentCategoryForLoan(db, loan.id);
      const p = projectLoan(db, loan.id);
      if (!envelope || !p) continue;
      const due = p.preEmi ?? p.emi;
      if (due > 0) fund(envelope.id, due / 100);
    }

    // The cards get what they are actually carrying, as far as there is money.
    for (const c of [cardCat, axisCat, priyaCardCat]) {
      if (!c) continue;
      const owed = -(queryOne<{ total: number }>(
        db,
        `SELECT COALESCE(SUM(t.amount),0) AS total FROM transactions t
          WHERE t.account_id = (SELECT payment_account_id FROM categories WHERE id = ?)
            AND t.deleted_at IS NULL AND substr(t.date,1,7) = ?`,
        c.id, month,
      )?.total ?? 0);
      if (owed > 0) fund(c.id, owed / 100);
    }

    const monthlyNeeds: [string, number][] = [
      ["Rent", 38_000], ["Groceries", 22_000 + between(-800, 1_400)], ["Eating out", 9_000],
      ["Cab / auto", 7_000], ["Electricity", 6_500], ["Domestic help", 5_000],
      ["Medical", 4_000], ["Personal", 6_000], ["Household", 5_000], ["Broadband", 1_500],
    ];
    for (const [name, amount] of monthlyNeeds) {
      if (!catIds.has(name)) continue;
      const state = computeBudget(loadEngineInput(db, { through: month, budgetId: household })).get(month);
      const already = state?.categories.get(cat(name))?.assigned ?? 0;
      if (already < rupees(amount)) fund(cat(name), amount - already / 100);
    }
    fund(gifts.id, 3_000);

    if (ix % 7 === 3) {
      did("moveMoney", () => moveMoney(db, actor, {
        month, fromCategoryId: cat("Personal"), toCategoryId: cat("Groceries"),
        amount: rupees(1_500) as Paise,
      }));
    }
    // Holding income back for next month, but only what there is to hold.
    if (ix === 11) {
      const spare = Math.min(rupees(1_50_000), Math.max(0, available()));
      if (spare > 0) did("setHeld", () => setHeld(db, actor, month, spare as Paise));
    }

    // --------------------------------------------------------- the spending
    const shops: [string, keyof typeof PAYEES, number, number][] = [
      ["Groceries", "grocers", 6, 4_200],
      ["Eating out", "food", 5, 1_100],
      ["Cab / auto", "travel", 5, 700],
      ["Personal", "shops", 3, 2_400],
      ["Medical", "health", 1, 1_800],
    ];
    for (const [category, list, count, typical] of shops) {
      if (!catIds.has(category)) continue;
      for (let i = 0; i < count; i++) {
        const d = between(1, 28);
        if (!live(d)) continue;
        const onCard = rand() < 0.55;
        spend(
          onCard ? pick([acc.hdfcCard, acc.priyaCard, acc.axisCard]) : pick([acc.savings, acc.cash]),
          cat(category), tidy(typical * (0.5 + rand())), pick(PAYEES[list]), day(month, d),
        );
      }
    }
    // Utilities, always on a bank account, always the same week.
    for (const name of PAYEES.utility) {
      const d = between(6, 12);
      if (!live(d)) continue;
      spend(acc.savings, cat("Electricity"), tidy(between(900, 3_400)), name, day(month, d));
    }
    // An add-on card charge: liable to Ravi, spent by Priya (R6.e/R6.k).
    if (live(19)) {
      spend(acc.axisCard, cat("Personal"), tidy(between(1_200, 6_000)), pick(PAYEES.shops),
        day(month, 19), { cardId: acc.addOn, owner: priya.id });
    }
    // A refund: money coming back into a spending category.
    if (ix % 6 === 2 && live(21)) {
      did("createTransaction", () => createTransaction(db, actor, {
        accountId: acc.priyaCard, amount: rupees(tidy(between(400, 2_200))), date: day(month, 21),
        categoryId: cat("Personal"), payeeName: "Myntra refund", cleared: true,
        ownerMemberId: priya.id,
      }));
    }

    /*
     * ------------------------------------------------------- the statement
     *
     * Money does not only arrive by being typed. Once a quarter the bank's CSV
     * is imported the way a household actually does it: parse, guess the
     * columns, ingest, and then work the review queue — approve most, file one
     * by hand, merge a duplicate that was already entered, and dismiss a row
     * that was somebody else's.
     *
     * `04` §1's whole pipeline lives here and nothing else in this scenario
     * touched it: the parser, the mapping guess, the duplicate tiers, the rules
     * and the queue were exercised by unit tests alone, against fixtures, never
     * against three years of a household's own ledger.
     */
    if (ix % 3 === 2 && ix > 3) {
      const rows: string[][] = [["Date", "Narration", "Debit", "Credit", "Ref"]];
      const line = (d: number, narration: string, debit: number, ref: string) =>
        rows.push([day(month, d).split("-").reverse().join("-"), narration,
                   debit > 0 ? debit.toFixed(2) : "", debit < 0 ? (-debit).toFixed(2) : "", ref]);

      /*
       * The shape a bank actually prints: rail, reference, merchant. The first
       * cut here was "UPI/DMART/4471920/GROCERY", with a trailing purpose field
       * that no statement in a corpus of seventy-seven real ones carries — and
       * because the merchant is taken as the longest segment, "GROCERY" won.
       * Every learned rule was therefore about a payee called "Grocery", matched
       * nothing, and three years of imports applied no rules at all.
       */
      line(4, "UPI/447192012345/DMART", tidy(between(1_800, 4_200)), `R${ix}01`);
      line(7, "UPI/883012345678/BESCOM", tidy(between(900, 2_600)), `R${ix}02`);
      line(12, "NEFT/LANDLORD/RENT", 0.01, `R${ix}03`);
      /*
       * `04` §4's own example: the same order arrives twice, once because
       * somebody typed it and once because the bank put it on the statement.
       * Without one of these the review queue never has a duplicate in it, and
       * the tiers, the merge and the "two people at the same restaurant" case
       * are exercised by fixtures alone.
       */
      const alsoTyped = tidy(between(300, 900));
      spend(acc.savings, cat("Eating out"), alsoTyped, "Swiggy", day(month, 17));
      line(17, "UPI/992130045511/SWIGGY", alsoTyped, `R${ix}04`);
      line(21, "IMPS/CREDIT/REFUND", -tidy(between(200, 1_400)), `R${ix}05`);

      const mapping = did("guessMapping", () => guessMapping(rows));
      if (mapping) {
        const parsed = did("applyMapping", () => applyMapping(rows, mapping));
        // The household teaches the app this layout once, and it is recognised
        // every quarter after (F6.4).
        if (ix === 5) {
          const profile = did("saveProfile", () => saveProfile(db, actor, {
            name: "HDFC statement", accountId: acc.savings,
            headers: rows[0]!, mapping,
          }));
          did("markProfileUsed", () => markProfileUsed(db, profile.id));
        }

        const result = did("ingest", () => ingest(db, actor, {
          accountId: acc.savings, source: "csv", adapter: "hdfc",
          fileName: `hdfc-${month}.csv`, records: parsed.records,
          errors: parsed.errors, rowsRead: rows.length - 1,
        }));
        void result;

        // Work the queue the way a person does.
        // "pending" is what the column actually says; "staged" is the table's name.
        const queue = listStaged(db).filter((r) => r.status === "pending");
        queue.forEach((row, n) => {
          if (row.duplicate_of_id) {
            did("mergeStaged", () => mergeStaged(db, actor, row.id));
          } else if (n === queue.length - 1) {
            did("rejectStaged", () => rejectStaged(db, actor, row.id, "not ours"));
          } else {
            did("approveStaged", () => approveStaged(db, actor, row.id, {
              categoryId: row.amount < 0 ? cat("Groceries") : null,
            }));
          }
        });
      }
    }

    /*
     * L2 · A year in, the household starts believing the app's suggestions.
     *
     * This used to happen only in the last few lines of the run, which meant the
     * middle of the feature was never exercised: forty-three rules proposed,
     * none confirmed, and therefore none ever applied to anything. The
     * `rule_applications` table came out of a three-year simulation with zero
     * rows in it. Confirming here leaves two dozen months of imports for the
     * rules to actually file.
     */
    if (ix === 12) {
      const proposed = did("proposeCategoryRules", () => proposeCategoryRules(db, actor));
      const waiting = queryAll<{ id: string; conditions_json: string; actions_json: string }>(
        db,
        `SELECT id, conditions_json, actions_json FROM rules
          WHERE proposed = 1 AND dismissed_at IS NULL
          ORDER BY strength IS NULL, strength DESC LIMIT 8`,
      );
      // The strongest are taken; the last is told to stop asking.
      for (const [n, rule] of waiting.entries()) {
        if (n < waiting.length - 1) {
          did("confirmRule", () => confirmRule(db, actor, rule.id));
        } else {
          did("dismissRule", () => dismissRule(db, actor, rule.id, {
            conditions: JSON.parse(rule.conditions_json),
            actions: JSON.parse(rule.actions_json),
          }));
        }
      }
      void proposed;
    }

    /*
     * F4.3 · One receipt, three envelopes.
     *
     * A ₹4,000 trip to a big shop is groceries and household and a birthday
     * present, and splitting it is the feature that stops all three from being
     * filed as "Groceries". Three years of simulation had never created one —
     * `transaction_splits` came out of the whole run empty — so the arithmetic
     * that has to hold across a split envelope was tested by unit tests alone.
     */
    if (live(9) && ix % 6 === 3) {
      const parts = [
        { categoryId: cat("Groceries"), amount: -rupees(2_400) as Paise },
        { categoryId: cat("Household"), amount: -rupees(1_100) as Paise },
        { categoryId: cat("Personal"), amount: -rupees(500) as Paise },
      ].filter((p): p is { categoryId: string; amount: Paise } => Boolean(p.categoryId));
      if (parts.length > 1) {
        const total = parts.reduce((sum, p) => sum + p.amount, 0) as Paise;
        did("createTransaction", () => createTransaction(db, actor, {
          accountId: acc.savings, amount: total, date: day(month, 9),
          payeeName: "Big Basket", cleared: true, ownerMemberId: ravi.id,
          memo: "Monthly stock-up", splits: parts,
          tags: ["household"],
        }));
      }
    }

    // Once, the whole batch was a mistake and went back out again.
    if (ix === 14) {
      const batch = queryOne<{ id: string }>(
        db, `SELECT id FROM import_batches ORDER BY created_at DESC LIMIT 1`,
      );
      if (batch) did("undoBatch", () => undoBatch(db, actor, batch.id));
    }

    // ------------------------------------------------------------ transfers
    if (live(2)) {
      did("createTransfer", () => createTransfer(db, actor, {
        fromAccountId: acc.priyaSavings, toAccountId: acc.savings,
        amount: rupees(30_000) as Paise, date: day(month, 2), memo: "To the joint account",
      }));
    }
    if (live(24)) {
      did("createTransfer", () => createTransfer(db, actor, {
        fromAccountId: acc.savings, toAccountId: acc.cash,
        amount: rupees(6_000) as Paise, date: day(month, 24), memo: "Cash for the week",
      }));
    }

    // --------------------------------------------------------------- cards
    for (const card of [
      { id: acc.hdfcCard, statement: 18, due: 5 },
      { id: acc.priyaCard, statement: 14, due: 2 },
      { id: acc.axisCard, statement: 22, due: 10 },
    ]) {
      if (!live(card.statement)) continue;
      const owed = -(queryOne<{ total: number }>(
        db,
        `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
          WHERE account_id = ? AND deleted_at IS NULL AND date <= ?`,
        card.id, day(month, card.statement),
      )?.total ?? 0);
      if (owed <= 0) continue;
      did("recordCardStatement", () => recordCardStatement(db, actor, {
        accountId: card.id, statementDate: day(month, card.statement),
        dueDate: day(addMonths(month, 1), card.due), amount: owed as Paise,
        minimumDue: Math.round(owed * 0.05) as Paise,
      }));
      // Paid in full the following month, which is what the envelope is for.
      const payOn = day(addMonths(month, 1), card.due);
      if (payOn <= today) {
        did("createTransfer", () => createTransfer(db, actor, {
          fromAccountId: acc.savings, toAccountId: card.id, amount: owed as Paise,
          date: payOn, memo: "Card payment",
        }));
      }
    }

    // --------------------------------------------------------------- loans
    const emiDay = 5;
    if (live(emiDay)) {
      for (const loan of listLoans(db)) {
        const p = projectLoan(db, loan.id);
        if (!p || p.outstanding <= 0 || p.emi <= 0) continue;
        if (loan.first_instalment_date && day(month, emiDay) < loan.first_instalment_date) continue;
        did("recordInstalment", () => recordInstalment(db, actor, {
          loanId: loan.id, date: day(month, emiDay), amount: p.emi,
          fromAccountId: loan.repayment_account_id ?? acc.savings,
        }));
      }
    }
    if (ix === 6) {
      did("recordLoanStatement", () => recordLoanStatement(db, actor, {
        loanId: eduLoan.id, lenderOutstanding: rupees(9_60_000) as Paise,
        asOf: day(month, 20),
      }));
    }
    if (ix === 18 && !ratesChanged) {
      ratesChanged = true;
      did("recordRateChange", () => recordRateChange(db, actor, {
        loanId: eduLoan.id, effectiveFrom: day(month, 1), annualRatePct: 9.75, keep: "tenure",
        note: "Repo cut",
      }));
      did("recordRateChange", () => recordRateChange(db, actor, {
        loanId: homeLoan.id, effectiveFrom: day(month, 1), annualRatePct: 9.1, keep: "emi",
        note: "Repo rise",
      }));
    }
    if (ix === 26 && !prepaid) {
      prepaid = true;
      did("recordPrepayment", () => recordPrepayment(db, actor, {
        loanId: personalLoan.id, date: day(month, 14), amount: rupees(50_000) as Paise,
        mode: "tenure", fromAccountId: acc.savings,
      }));
    }

    // A card purchase converted to an instalment plan (§7.4).
    if (ix === 20 && !emiConverted && live(16)) {
      emiConverted = true;
      const charge = did("createTransaction", () => createTransaction(db, actor, {
        accountId: acc.hdfcCard, amount: rupees(-84_000) as Paise, date: day(month, 16),
        categoryId: cat("Personal"), payeeName: "Croma", cleared: true, ownerMemberId: ravi.id,
      }));
      did("convertToEmi", () => convertToEmi(db, actor, {
        transactionId: charge.id, tenureMonths: 12, annualRatePct: 16,
        processingFee: rupees(499) as Paise, feeCategoryId: cat("Household"),
        nameSuffix: "Croma TV",
      }));
    }

    // ------------------------------------------------------------ schedules
    // The rent and the sub-let both post themselves, which is what a schedule is.
    if (live(3)) did("markPaid", () => markPaid(db, actor, rentSchedule.id, day(month, 3)));
    if (live(20)) did("markPaid", () => markPaid(db, actor, salarySchedule.id, day(month, 20)));
    if (ix === 9) did("skipOccurrence", () => skipOccurrence(db, actor, gymSchedule.id));
    if (ix === 15) {
      did("updateSchedule", () => updateSchedule(db, actor, gymSchedule.id, { amount: -rupees(1_799) as Paise }));
    }
    if (ix === 31) did("deleteSchedule", () => deleteSchedule(db, actor, gymSchedule.id));

    // ---------------------------------------------------------- investments
    flexiNav *= 1 + (rand() - 0.42) * 0.05;
    indexNav *= 1 + (rand() - 0.44) * 0.04;
    applePrice *= 1 + (rand() - 0.45) * 0.06;
    usdInr *= 1 + (rand() - 0.5) * 0.01;
    sgdInr *= 1 + (rand() - 0.5) * 0.008;
    if (live(7)) {
      did("recordPrice", () => recordPrice(db, { instrumentId: flexi.id, price: toPrice(flexiNav), asOf: day(month, 7), source: "sim" }));
      did("recordPrice", () => recordPrice(db, { instrumentId: index.id, price: toPrice(indexNav), asOf: day(month, 7), source: "sim" }));
      did("recordPrice", () => recordPrice(db, { instrumentId: apple.id, price: toPrice(applePrice), asOf: day(month, 7), source: "sim" }));
      did("recordFxRate", () => recordFxRate(db, { base: "USD", quote: "INR", rate: usdInr, asOf: day(month, 7), source: "sim" }));
      did("recordFxRate", () => recordFxRate(db, { base: "SGD", quote: "INR", rate: sgdInr, asOf: day(month, 7), source: "sim" }));
    }
    // A monthly SIP into each fund.
    if (live(6)) {
      for (const [instrument, nav, amount] of [[flexi.id, flexiNav, 15_000], [index.id, indexNav, 10_000]] as const) {
        did("recordPurchase", () => recordPurchase(db, actor, {
          accountId: demat.id, instrumentId: instrument, tradeDate: day(month, 6),
          price: toPrice(nav), amount: rupees(amount) as Paise, fromAccountId: acc.savings,
          categoryId: cat("Investments") ?? null,
        }));
      }
    }
    if (ix === 4 && live(9)) {
      did("recordPurchase", () => recordPurchase(db, actor, {
        accountId: demat.id, instrumentId: apple.id, tradeDate: day(month, 9),
        price: toPrice(applePrice), units: toUnits(12), fxRate: usdInr,
      }));
    }
    if (ix === 22 && live(11)) {
      const holding = listHoldings(db, demat.id).find((h) => h.instrument_id === index.id);
      if (holding) {
        did("recordSale", () => recordSale(db, actor, {
          holdingId: holding.id, units: toUnits(20), price: toPrice(indexNav),
          date: day(month, 11), toAccountId: acc.savings,
        }));
      }
    }
    if (ix === 13 && live(17)) {
      const holding = listHoldings(db, demat.id).find((h) => h.instrument_id === apple.id);
      if (holding) {
        did("recordDividend", () => recordDividend(db, actor, {
          holdingId: holding.id, date: day(month, 17), amount: rupees(1_800) as Paise,
          toAccountId: acc.savings,
        }));
      }
    }
    if (ix === 16 && live(20)) {
      const holding = listHoldings(db, demat.id).find((h) => h.instrument_id === apple.id);
      if (holding) did("recordSplit", () => recordSplit(db, actor, { holdingId: holding.id, date: day(month, 20), ratio: 4 }));
    }
    if (ix === 27 && live(20)) {
      const holding = listHoldings(db, demat.id).find((h) => h.instrument_id === index.id);
      if (holding) did("recordMerger", () => recordMerger(db, actor, { holdingId: holding.id, date: day(month, 20), ratio: 0.9 }));
    }
    if (ix === 28 && live(23)) {
      const holding = listHoldings(db, demat.id).find((h) => h.instrument_id === flexi.id);
      if (holding) {
        did("recordReturnOfCapital", () => recordReturnOfCapital(db, actor, {
          holdingId: holding.id, date: day(month, 23), amount: rupees(2_400) as Paise,
        }));
      }
    }
    goldValue *= 1 + (rand() - 0.4) * 0.03;
    npsValue *= 1.008;
    if (live(26)) {
      did("recordValuation", () => recordValuation(db, actor, { accountId: gold.id, value: rupees(Math.round(goldValue)) as Paise, asOf: day(month, 26) }));
      did("recordValuation", () => recordValuation(db, actor, { accountId: nps.id, value: rupees(Math.round(npsValue)) as Paise, asOf: day(month, 26) }));
      // N7 · In SGD. Net worth converts it at the dated rate; it used to be
      // summed into a rupee total as though S$42,000 were ₹42,000.
      overseasValue *= 1 + (rand() - 0.45) * 0.01;
      did("recordValuation", () => recordValuation(db, actor, {
        accountId: overseas.id, value: rupees(Math.round(overseasValue)) as Paise,
        asOf: day(month, 26),
      }));
    }

    // ------------------------------------------------------ lending in the family
    if (ix === 3 && live(12)) {
      did("recordAdvance", () => recordAdvance(db, actor, {
        loanId: cousin.id, amount: rupees(60_000) as Paise, date: day(month, 12),
        fromAccountId: acc.savings, memo: "Cousin Arun — hospital",
      }));
    }
    if (ix === 10 && live(14)) {
      did("recordRepayment", () => recordRepayment(db, actor, {
        loanId: cousin.id, amount: rupees(25_000) as Paise, date: day(month, 14),
        accountId: acc.savings,
      }));
    }
    if (ix === 17 && live(9)) {
      did("recordAdvance", () => recordAdvance(db, actor, {
        loanId: neighbour.id, amount: rupees(8_000) as Paise, date: day(month, 9),
        fromAccountId: acc.priyaSavings,
      }));
    }
    if (ix === 25) {
      did("writeOffFamilyLoan", () => writeOffFamilyLoan(db, actor, {
        loanId: neighbour.id, categoryId: gifts.id, date: day(month, 20),
      }));
    }
    if (ix === 32) {
      did("recordRepayment", () => recordRepayment(db, actor, {
        loanId: cousin.id, amount: rupees(35_000) as Paise, date: day(month, 6),
        accountId: acc.savings,
      }));
      did("closeFamilyLoan", () => closeFamilyLoan(db, actor, cousin.id));
    }
    if (ix === 33) {
      did("reopenFamilyLoan", () => reopenFamilyLoan(db, actor, cousin.id));
      did("closeFamilyLoan", () => closeFamilyLoan(db, actor, cousin.id));
    }

    // ------------------------------------------------- commitments and claims
    for (const [budgetId, envelope, amount, present] of [
      [hisBudget.id, hisEnvelope.id, 40_000, true],
      [anilBudget.id, anilEnvelope.id, 18_000, anilHere],
    ] as [string, string, number, boolean][]) {
      if (!present) continue;
      /*
       * Committed out of what they have, not out of thin air. A commitment is an
       * assignment like any other, so a month where the invoices were thin funds
       * less of it — which is the state the household screen exists to show.
       */
      const state = computeBudget(loadEngineInput(db, { through: month, budgetId })).get(month);
      const already = state?.categories.get(envelope)?.assigned ?? 0;
      const room = Math.max(0, state?.readyToAssign ?? 0);
      const wanted = Math.max(0, rupees(amount) - already);
      const give = Math.min(wanted, room);
      if (give > 0) {
        did("addAssigned", () => addAssigned(db, actor, month, envelope, give as Paise));
      }

      /*
       * And if this month's income did not cover it, it comes out of savings —
       * which is what savings are for, and what a person actually does. Without
       * this a thin month simply skipped the commitment, the shortfall carried
       * for ever, and the household page reported somebody nearly two lakh
       * behind on a ₹40,000 agreement they had kept every month they could.
       */
      const short = wanted - give;
      const savings = budgetId === hisBudget.id ? hisSavings.id : anilSavings.id;
      if (short > 0) {
        const held = state?.categories.get(savings)?.balance ?? 0;
        const take = Math.min(short, Math.max(0, held));
        if (take > 0) {
          did("moveMoney", () => moveMoney(db, actor, {
            month, fromCategoryId: savings, toCategoryId: envelope, amount: take as Paise,
          }));
        }
      }
    }
    /*
     * Anil's share, paid out of his own account against household envelopes —
     * near enough what he commits, so his standing wanders either side of even
     * rather than climbing for three years.
     */
    if (anilHere) {
      if (live(15)) {
        spend(acc.anilOwn, cat("Groceries"), tidy(between(6_000, 11_000)), pick(PAYEES.grocers),
          day(month, 15), { owner: anil.id });
      }
      if (live(9)) {
        spend(acc.anilOwn, cat("Electricity"), tidy(between(2_400, 4_200)), "BESCOM",
          day(month, 9), { owner: anil.id });
      }
      if (live(11)) {
        spend(acc.anilOwn, cat("Domestic help"), tidy(between(3_800, 5_200)), "Lakshmi",
          day(month, 11), { owner: anil.id });
      }
    }
    // And spends on his own envelope, so his budget is not only a commitment.
    if (anilHere && live(22)) {
      spend(acc.anilOwn, anilOut.id, tidy(between(900, 3_200)), pick(PAYEES.food),
        day(month, 22), { owner: anil.id });
    }
    if (live(10)) {
      spend(acc.hisOwn, hisBooks.id, tidy(between(600, 2_600)), "Blinkist", day(month, 10),
        { owner: ravi.id });
    }

    // A month they agreed to leave alone.
    if (ix === 19) {
      const state = computeBudget(loadEngineInput(db, { through: month, budgetId: hisBudget.id })).get(month);
      const balance = state?.categories.get(hisEnvelope.id)?.balance ?? 0;
      if (balance !== 0) {
        did("ensureGivenUpCategory", () => ensureGivenUpCategory(db, actor, balance < 0 ? hisBudget.id : household));
        did("callItEven", () => callItEven(db, actor, {
          envelopeId: hisEnvelope.id, amount: Math.abs(balance) as Paise, month,
          note: "Left it there",
        }));
      }
    }

    // ------------------------------------------------------------- departure
    if (ix === DEPARTURE_AT) {
      // Never the member the demo signs in as (SIGNED_IN_AS).
      assertNotSignedIn(["anil", "meera"]);
      /*
       * Two members leave in the same month, settled two different ways,
       * because `15` §6A offers both and they are different arithmetic: one
       * envelope is released back to its own budget, the other becomes money
       * the household owes and therefore a family loan.
       */
      const anilStanding = describeDeparture(db, anil.id);
      did("settleDeparture", () => settleDeparture(db, actor, anil.id,
        anilStanding.options.includes("family-loan") ? "family-loan" : "release", month));
      did("removeMember", () => removeMember(db, actor, anil.id));
      note(month, `Anil left (${anilStanding.standing})`);

      did("settleDeparture", () => settleDeparture(db, actor, meera.id, "release", month));
      did("removeMember", () => removeMember(db, actor, meera.id));
      note(month, "Meera left (released)");
    }

    // --------------------------------------------------------------- return
    if (ix === RETURN_AT) {
      did("inviteMember", () => inviteMember(db, actor, { email: "anil@example.com", name: "Anil" }));
      note(month, "Anil came back");
    }

    // ----------------------------------------------------- the odds and ends
    if (ix === 5) {
      const t = did("createTransaction", () => createTransaction(db, actor, {
        accountId: acc.savings, amount: rupees(-2_400) as Paise, date: day(month, 8),
        categoryId: cat("Household"), payeeName: "Urban Company", cleared: true,
        ownerMemberId: priya.id,
      }));
      did("updateTransaction", () => updateTransaction(db, actor, t.id, { memo: "Deep clean" }));
      did("setTags", () => setTags(db, t.id, ["reimbursable", "work"]));
      did("addAttachment", () => addAttachment(db, actor, {
        // A receipt has to be an image or a PDF, so this is the smallest real PNG.
        transactionId: t.id, filename: "receipt.png", mime: "image/png",
        bytes: ONE_PIXEL_PNG,
      }));
    }
    if (ix === 7) {
      const doomedTxn = did("createTransaction", () => createTransaction(db, actor, {
        accountId: acc.cash, amount: rupees(-350) as Paise, date: day(month, 11),
        categoryId: cat("Eating out"), payeeName: "Mistake", cleared: false,
      }));
      did("deleteTransaction", () => deleteTransaction(db, actor, doomedTxn.id));
      did("restoreTransaction", () => restoreTransaction(db, actor, doomedTxn.id));
      did("deleteTransaction", () => deleteTransaction(db, actor, doomedTxn.id));
    }
    if (ix === 8) {
      const a = did("resolvePayee", () => resolvePayee(db, actor, "Big Bazaar"));
      const b = did("resolvePayee", () => resolvePayee(db, actor, "BigBazaar"));
      did("mergePayees", () => mergePayees(db, actor, b.id, a.id));

      /*
       * The household decides "Eating out" and "Restaurants" were always the
       * same envelope. Both have been assigned to and spent from by now, which
       * is the case that matters: the merge has to add the two assignments
       * rather than keep one, and the identity assertion that runs after every
       * simulated month is what proves it did.
       */
      const duplicate = did("createCategory", () => createCategory(db, actor, {
        groupId: queryOne<{ group_id: string }>(
          db, `SELECT group_id FROM categories WHERE id = ?`, cat("Eating out"),
        )!.group_id,
        name: "Restaurants",
      }));
      did("setAssigned", () => setAssigned(db, actor, month, duplicate.id, rupees(800) as Paise));
      did("createTransaction", () => createTransaction(db, actor, {
        accountId: acc.cash, amount: rupees(-300) as Paise, date: day(month, 14),
        categoryId: duplicate.id, payeeName: "Paragon",
      }));
      did("mergeCategories", () => mergeCategories(db, actor, duplicate.id, cat("Eating out")));
    }
    if (ix === 12 && !reconciled) {
      reconciled = true;
      const balance = queryOne<{ total: number }>(
        db,
        `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
          WHERE account_id = ? AND deleted_at IS NULL AND date <= ? AND cleared = 1`,
        acc.cash, day(month, 25),
      )?.total ?? 0;
      const opening = queryOne<{ opening_balance: number }>(
        db, `SELECT opening_balance FROM accounts WHERE id = ?`, acc.cash,
      )?.opening_balance ?? 0;
      did("reconcile", () => reconcile(db, actor, {
        accountId: acc.cash, bankBalance: (balance + opening) as Paise,
        asOf: day(month, 25),
      }));
    }
    if (ix === 14) {
      did("updateAccount", () => updateAccount(db, actor, acc.current, { nickname: "Business current" }));
    }
    if (ix === 21) {
      did("closeAccount", () => closeAccount(db, actor, acc.meeraSavings));
      did("reopenAccount", () => reopenAccount(db, actor, acc.meeraSavings));
    }
    if (ix === 24) {
      did("closeCard", () => closeCard(db, actor, acc.addOn));
    }
    if (ix === 30) {
      did("clearTarget", () => clearTarget(db, actor, gifts.id));
      did("setTarget", () => setTarget(db, actor, gifts.id, {
        type: "by-date", amount: rupees(24_000) as Paise, targetDate: `${months[35]!}-01`,
      }));
      did("moveCategoryToGroup", () => moveCategoryToGroup(db, actor, gifts.id, extras.id));
    }
    if (ix === 34) {
      const state = computeBudget(loadEngineInput(db, { through: month })).get(month);
      const balance = (state?.categories.get(doomed.id)?.balance ?? 0) as Paise;
      did("deleteCategory", () => deleteCategory(db, actor, doomed.id, {
        remapTo: gifts.id, currentBalance: balance,
      }));
    }
    if (ix === 35) {
      // The goal reached, and the envelope spent down.
      did("completeGoal", () => completeGoal(db, actor, tripGoal.id, "spend"));
    }

    /*
     * The goals get what is left, which is the honest order: a savings goal is
     * funded out of what the month did not need, not ahead of the rent.
     */
    for (const goal of [tripGoal, emergencyGoal]) {
      const envelope = queryOne<{ category_id: string }>(
        db, `SELECT category_id FROM goal_categories WHERE goal_id = ? LIMIT 1`, goal.id,
      )?.category_id;
      /*
       * Never the last rupee. A household that assigns every paisa the day the
       * salary lands has nothing to fund the first fortnight of the next month
       * with, and every envelope reads "not funded" until payday — which is how
       * the demo came to show four loans unfunded while every instalment had
       * been paid on time. A float is what a buffer actually is.
       */
      const spare = available() - FLOAT;
      if (envelope && spare > 0) fund(envelope, Math.min(rupees(between(2_000, 5_000)), spare) / 100);
    }
    // Ravi's own goal is funded out of his own budget, not the household's.
    {
      const envelope = queryOne<{ category_id: string }>(
        db, `SELECT category_id FROM goal_categories WHERE goal_id = ? LIMIT 1`, laptopGoal.id,
      )?.category_id;
      const his = computeBudget(
        loadEngineInput(db, { through: month, budgetId: hisBudget.id }),
      ).get(month);
      const room = his?.readyToAssign ?? 0;
      if (envelope && room > 0) {
        did("addAssigned", () => addAssigned(
          db, actor, month, envelope, Math.min(rupees(between(2_000, 6_000)), room) as Paise,
        ));
      }
    }

    /*
     * Whatever a personal budget has left at the end of the month goes to its
     * own savings envelope. Zero-based means the month is not finished until
     * Ready to Assign is nothing.
     */
    for (const [budgetId, envelope, present] of [
      [hisBudget.id, hisSavings.id, true],
      [anilBudget.id, anilSavings.id, anilHere],
    ] as [string, string, boolean][]) {
      if (!present) continue;
      const state = computeBudget(loadEngineInput(db, { through: month, budgetId })).get(month);
      const room = state?.readyToAssign ?? 0;
      if (room > 0) {
        did("addAssigned", () => addAssigned(db, actor, month, envelope, room as Paise));
      } else if (room < 0) {
        /*
         * And the other direction, which is the half that matters. A month where
         * the invoices were thin leaves Ready to Assign below zero, and a sweep
         * that only ever adds cannot put that right — it just leaves the budget
         * screen saying "you have assigned more than you have" for ever. Taking
         * it back out of the savings envelope is what a person does, and what
         * the app's own move-money is for.
         */
        const held = state?.categories.get(envelope)?.balance ?? 0;
        const claw = Math.min(-room, Math.max(0, held));
        if (claw > 0) {
          did("addAssigned", () => addAssigned(db, actor, month, envelope, -claw as Paise));
        }
      }
    }

    // ---------------------------------------------------------- month close
    if (!isCurrent) {
      for (const budget of listBudgets(db)) {
        did("closeMonth", () => closeMonth(db, actor, month, null, budget.id));
      }
      if (ix === 2) {
        did("reopenMonth", () => reopenMonth(db, actor, month, household));
        did("closeMonth", () => closeMonth(db, actor, month, "Reopened and closed again", household));
      }
    }
    if (ix % 6 === 5) {
      did("snapshotNetWorth", () => snapshotNetWorth(db, actor, day(month, 28)));
    }

    monthsBuilt.push(month);
    opts.afterMonth?.(month, ix);
  });

  /*
   * The registrar's consolidated statement, once.
   *
   * `07` R24: a CAS is how an Indian household's fund history actually arrives —
   * every scheme, every purchase, from the registrar rather than typed. The
   * planner matches by ISIN, skips what is already recorded, and reports what it
   * would add before anything is written.
   */
  {
    const casMonth = months[Math.min(31, MONTHS - 2)]!;
    const plan = did("planCasImport", () => planCasImport(db, {
      period: { from: `${months[28]!}-01`, to: `${casMonth}-28` },
      unparsed: [],
      schemes: [{
        amc: "PPFAS Mutual Fund", folio: "9911223/44",
        name: "Parag Parikh Flexi Cap Fund - Direct Plan - Growth",
        isin: "INF879O01019", registrar: "CAMS",
        closingUnits: null, closingValue: null, closingNav: null,
        rows: [
          {
            date: `${casMonth}-06`, kind: "purchase", description: "Systematic Investment",
            amount: rupees(5_000) as Paise, units: 62_000, nav: toPrice(80.6),
            raw: "SIP 5,000.00 62.000 80.60",
          },
        ],
      }],
    }, demat.id));
    if (plan.schemes.length > 0) {
      did("applyCasPlan", () => applyCasPlan(db, actor, plan, [0]));
    }
  }

  /*
   * The statement identity, which is what a bank's PDF password is built from
   * (`04` §3.5). Invented, like everything else in this file: no real PAN, date
   * of birth or number appears anywhere in this repository.
   */
  did("setIdentity", () => setIdentity(db, actor, {
    // DDMMYYYY, which is what a bank asks for and what the password is built from.
    name: "Ravi Menon", pan: "ABCDE1234F", dob: "01011990", mobile: "9000000000",
  }));
  did("clearIdentity", () => clearIdentity(db, actor));

  /*
   * What the app learned from three years of filing.
   *
   * `04` §6: rules are proposed from what the household actually did, never
   * invented. By month thirty-six the same payees have been filed the same way
   * often enough for the proposals to mean something — which is the only state
   * this code is ever really in, and the one no fixture had it in.
   */
  did("setLearningEnabled", () => setLearningEnabled(db, actor, true));
  const proposals = did("proposeCategoryRules", () => proposeCategoryRules(db, actor));
  did("proposePayeeRule", () => proposePayeeRule(db, actor, {
    rawNarration: "UPI/DMART/4471920/GROCERY", cleanName: "DMart",
  }));
  if (proposals.length > 0) {
    // One is taken and applied backwards; one is told to stop asking.
    const rule = queryOne<{
      id: string; name: string; stage: string; conditions_json: string; actions_json: string;
    }>(db, `SELECT * FROM rules WHERE proposed = 1 ORDER BY created_at LIMIT 1`);
    if (rule) {
      const shaped = {
        id: rule.id, name: rule.name, stage: rule.stage as RuleStage,
        match: "all" as const,
        conditions: JSON.parse(rule.conditions_json),
        actions: JSON.parse(rule.actions_json),
        enabled: true, timesApplied: 0,
      };
      did("previewRetroactive", () => previewRetroactive(db, shaped));
      did("applyRetroactive", () => applyRetroactive(db, actor, shaped));
    }
    did("suppress", () => suppress(db, "rule", proposals.at(-1)!.name, ravi.id));
  }
  did("deleteProfile", () => {
    const profile = queryOne<{ id: string }>(db, `SELECT id FROM import_profiles LIMIT 1`);
    if (profile) deleteProfile(db, actor, profile.id);
  });

  // A loan settled early, with the lender's charge (R19.5).
  const settleable = listLoans(db).find((l) => l.loan_type === "personal");
  if (settleable) {
    const p = projectLoan(db, settleable.id);
    if (p && p.outstanding > 0) {
      did("closeLoan", () => closeLoan(db, actor, {
        loanId: settleable.id, date: today, settlement: p.outstanding,
        foreclosureCharge: rupees(4_000) as Paise,
        chargeAccountId: acc.savings, chargeCategoryId: cat("Household"),
      }));
    }
  }
  did("deleteGroup", () => {
    const empty = createGroup(db, actor, "Nothing in here");
    deleteGroup(db, actor, empty.id);
  });
  /*
   * Exercising deleteAttachment used to take the only receipt in the
   * household with it, so the demo — and every screenshot taken from it —
   * ended with the feature invisible. Delete one that exists to be deleted,
   * and leave the deep-clean receipt where a reader will find it.
   */
  did("deleteAttachment", () => {
    const doomed = addAttachment(db, actor, {
      transactionId: queryAll<{ id: string }>(
        db, `SELECT id FROM transactions WHERE deleted_at IS NULL ORDER BY date DESC LIMIT 1`,
      )[0]!.id,
      filename: "wrong-photo.png", mime: "image/png", bytes: ONE_PIXEL_PNG,
    });
    deleteAttachment(db, actor, doomed.id);
  });
  did("prepareClaim", () => prepareClaim(db, actor, acc.anilOwn, anilBudget.id, household));

  return {
    months,
    members: {
      ravi: { id: ravi.id, name: "Ravi", email: ravi.email },
      priya: { id: priya.id, name: "Priya", email: priya.email },
      anil: { id: anil.id, name: "Anil", email: anil.email },
      meera: { id: meera.id, name: "Meera", email: meera.email },
    },
    budgets: { household, ravi: hisBudget.id, anil: anilBudget.id },
    accounts: acc,
    calls,
    log,
    monthsBuilt,
  };
}

/**
 * A guard rather than a comment: if somebody ever edits the departure to take
 * out the member the demo signs in as, this stops them at the moment they run
 * it rather than at the moment somebody opens the demo.
 */
function assertNotSignedIn(leaving: readonly string[]): void {
  if (leaving.includes(SIGNED_IN_AS)) {
    throw new Error(
      `The scenario removes ${SIGNED_IN_AS}, who is the member a demo instance ` +
      "signs in as. Pick somebody else to leave, or change SIGNED_IN_AS and the " +
      "order the members are created in.",
    );
  }
}

/** Who is still here, for a test that wants to check the departure took. */
export function presentMembers(db: DB): string[] {
  return listMembers(db).map((m) => m.name).sort();
}
