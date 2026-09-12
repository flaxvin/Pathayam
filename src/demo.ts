/**
 * Demo data — thirty-six months of an invented household.
 *
 * Built for a public demonstration instance, where the first screen somebody
 * sees has to be a budget that has plainly been *lived in*: rollover that has
 * actually rolled, categories that drifted, a card that was once overspent, a
 * loan halfway through its tenure, and an investment history long enough for
 * XIRR to mean something.
 *
 *   DATA_DIR=./demo-data npm run demo
 *
 * Two properties this file must keep:
 *
 * 1. **It ends today.** Every date is derived from `todayIST()` at run time, so
 *    the newest month is always the current one however long from now it runs.
 *    A demo whose latest transaction is eight months old reads as abandoned.
 * 2. **Every figure is invented.** No real person, account, card or balance
 *    appears here or anywhere in this repository.
 *
 * It refuses to run against a database that already has accounts, so it can
 * never be pointed at a household's real data by accident.
 */

import { loadConfig } from "./config.ts";
import { openDatabase, ensureHousehold, queryOne } from "./db/db.ts";
import type { Actor } from "./core/events.ts";
import { inviteMember } from "./auth/sessions.ts";
import { createAccount, createCard, paymentCategoryFor } from "./domain/accounts.ts";
import { listCategories, setAssigned } from "./domain/budget.ts";
import { createTransaction, createTransfer } from "./domain/transactions.ts";
import { applyStartingTemplate } from "./domain/starting-budget.ts";
import {
  createLoan, recordInstalment, recordDisbursement, recordLoanStatement,
} from "./domain/loans.ts";
import { createSchedule } from "./domain/schedules.ts";
import { createGoal } from "./domain/goals.ts";
import { createFamilyLoan, recordAdvance, recordRepayment } from "./domain/family-loans.ts";
import { closeMonth } from "./domain/month-close.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale, listHoldings,
  recordPrice, recordFxRate, recordValuation,
} from "./domain/assets.ts";
import { snapshotNetWorth } from "./domain/networth.ts";
import { units as toUnits, price as toPrice } from "./portfolio/holdings.ts";
import { rupees, type Paise } from "./core/money.ts";
import { todayIST, monthOf, addMonths, addDays, firstDayOfMonth, lastDayOfMonth } from "./core/dates.ts";

const system: Actor = { memberId: null, source: "system" };

/** Deterministic, so two runs on the same day produce the same household. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}
const rand = rng(20260912);
const between = (lo: number, hi: number): number => Math.round(lo + rand() * (hi - lo));
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
/** Round to something a human would actually have paid. */
const tidy = (n: number): number => Math.round(n / 10) * 10;

const MONTHS = 36;

const GROCERS = ["DMart", "Big Basket", "Zepto", "Blinkit", "Nature's Basket", "Local kirana"];
const FOOD = ["Swiggy", "Zomato", "Third Wave Coffee", "Toit", "Truffles", "Chai Point"];
const TRAVEL = ["Uber", "Ola", "Rapido", "Indian Oil", "Shell", "Namma Metro"];
const SHOPS = ["Amazon", "Myntra", "Nykaa", "Decathlon", "Croma", "IKEA"];
const UTILITY = ["BESCOM", "ACT Fibernet", "Airtel", "Bangalore Water Supply"];
const HEALTH = ["Apollo Pharmacy", "Practo", "1mg", "Cloudnine"];

function main(): void {
  const config = loadConfig();
  const db = openDatabase({ path: config.databasePath });
  ensureHousehold(db);

  if ((queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM accounts`)?.n ?? 0) > 0) {
    console.error("This database already has accounts. Point DATA_DIR somewhere empty.");
    process.exit(1);
  }

  const ravi = inviteMember(db, system, { email: "ravi@example.com", name: "Ravi" });
  const priya = inviteMember(db, system, { email: "priya@example.com", name: "Priya" });
  const actor: Actor = { memberId: ravi.id, source: "system" };

  const today = todayIST();
  const thisMonth = monthOf(today);
  /** The oldest month, so the history is exactly `MONTHS` long ending now. */
  const start = addMonths(thisMonth, -(MONTHS - 1));
  const months: string[] = [];
  for (let i = 0; i < MONTHS; i++) months.push(addMonths(start, i));
  const opened = firstDayOfMonth(start);

  // ---------------------------------------------------------------- accounts
  const savings = createAccount(db, actor, {
    name: "HDFC Savings", kind: "budget", subtype: "savings", institution: "HDFC Bank",
    last4: "6604", openingBalance: rupees(96_000), openingDate: opened,
  });
  const current = createAccount(db, actor, {
    name: "ICICI Current", kind: "budget", subtype: "current", institution: "ICICI Bank",
    last4: "6612", openingBalance: rupees(24_000), openingDate: opened,
  });
  const cash = createAccount(db, actor, {
    name: "Cash", kind: "budget", subtype: "cash",
    openingBalance: rupees(6_000), openingDate: opened,
  });
  const hdfcCard = createAccount(db, actor, {
    name: "Swiggy HDFC", kind: "credit", subtype: "credit-card", institution: "HDFC Bank",
    last4: "4412", openingBalance: rupees(-6_200), openingDate: opened,
    statementDay: 18, dueDay: 5,
  });
  const axisCard = createAccount(db, actor, {
    name: "Axis Atlas", kind: "credit", subtype: "credit-card", institution: "Axis Bank",
    last4: "3150", openingDate: opened, statementDay: 22, dueDay: 10,
  });
  const addOn = createCard(db, actor, {
    accountId: axisCard.id, label: "Axis Atlas — Priya", last4: "3162", holderMemberId: priya.id,
  });
  const ppf = createAccount(db, actor, {
    name: "PPF", kind: "tracking", subtype: "asset",
    openingBalance: rupees(3_10_000), openingDate: opened,
  });
  void ppf;

  applyStartingTemplate(db, actor, {
    monthlyIncome: rupees(1_45_000), hasEmis: true, hasSchoolFees: false, hasDomesticHelp: true,
  });

  const categories = new Map(listCategories(db).map((c) => [c.name, c.id]));
  const id = (name: string): string => {
    const found = categories.get(name);
    if (!found) throw new Error(`demo: no category named ${name}`);
    return found;
  };

  const cardCat = paymentCategoryFor(db, hdfcCard.id)!;
  const axisCat = paymentCategoryFor(db, axisCard.id)!;

  // ------------------------------------------------------------------- loans
  // An education loan already years into repayment, and a personal loan taken
  // out midway through the history so its disbursement is visible as income.
  const eduLoan = createLoan(db, actor, {
    lender: "Union Bank of India", nickname: "Education loan", loanType: "education",
    interestModel: "reducing", annualRatePct: 10.25,
    sanctioned: rupees(12_00_000), sanctionDate: addMonths(start, -30) + "-01",
    tenureMonths: 120, firstInstalmentDate: firstDayOfMonth(start),
    currentOutstanding: rupees(10_20_000),
    historyFrom: firstDayOfMonth(start),
    repaymentAccountId: savings.id,
  });
  const personalTakenIn = months[14]!;
  const personalLoan = createLoan(db, actor, {
    lender: "Axis Bank", nickname: "Axis personal loan", loanType: "personal",
    interestModel: "flat", annualRatePct: 11.5,
    sanctioned: rupees(4_00_000), sanctionDate: `${personalTakenIn}-08`,
    tenureMonths: 36, firstInstalmentDate: `${addMonths(personalTakenIn, 1)}-05`,
    repaymentAccountId: savings.id,
  });
  recordDisbursement(db, actor, {
    loanId: personalLoan.id, date: `${personalTakenIn}-08`, amount: rupees(4_00_000),
    destination: "budget-account", destinationAccountId: savings.id,
  });

  // ------------------------------------------------------------- investments
  const demat = createAssetAccount(db, actor, { name: "Zerodha", subtype: "investment" });
  const flexi = findOrCreateInstrument(db, actor, {
    name: "Parag Parikh Flexi Cap Fund - Direct Plan - Growth",
    kind: "mutual-fund", symbol: "122639", isin: "INF879O01019", provider: "mfapi",
  });
  const index = findOrCreateInstrument(db, actor, {
    name: "UTI Nifty 50 Index Fund - Direct Plan - Growth",
    kind: "mutual-fund", symbol: "120716", isin: "INF789F01XA0", provider: "mfapi",
  });
  const apple = findOrCreateInstrument(db, actor, {
    name: "Apple Inc", kind: "equity", symbol: "AAPL", currency: "USD", provider: "alphavantage",
  });

  let flexiNav = 58, indexNav = 112, applePrice = 168, usdInr = 82.5;

  const gold = createAssetAccount(db, actor, { name: "Gold (SafeGold)", subtype: "commodity" });
  const nps = createAssetAccount(db, actor, { name: "NPS Tier I", subtype: "retirement" });
  let goldValue = 1_90_000, npsValue = 2_40_000;

  // ------------------------------------------------------------- the history
  const spendOn = (
    account: string, category: string, amount: number, payee: string, date: string,
    opts: { cardId?: string; owner?: string } = {},
  ) => createTransaction(db, actor, {
    accountId: account, amount: rupees(-Math.max(10, amount)), date,
    categoryId: id(category), payeeName: payee,
    cleared: date < addDays(today, -3),
    cardId: opts.cardId, ownerMemberId: opts.owner,
  });

  const day = (month: string, d: number): string =>
    `${month}-${String(Math.min(d, Number(lastDayOfMonth(month).slice(-2)))).padStart(2, "0")}`;

  let txns = 0;
  months.forEach((month, ix) => {
    const isCurrent = month === thisMonth;
    const cap = isCurrent ? Number(today.slice(-2)) : 28;
    const live = (d: number): boolean => d <= cap;

    // Income arrives in lumps rather than as a salary — two to four credits a
    // month, which is the shape "hold for next month" exists for.
    let received = 0;
    const credits = between(2, 4);
    for (let c = 0; c < credits; c++) {
      const d = between(2, 26);
      if (!live(d)) continue;
      const amount = tidy(between(38_000, 92_000) * (rand() < 0.12 ? 2.4 : 1));
      createTransaction(db, actor, {
        accountId: rand() < 0.7 ? savings.id : current.id,
        amount: rupees(amount), date: day(month, d),
        payeeName: pick(["Consulting retainer", "Client invoice", "Project milestone", "Retainer top-up"]),
        cleared: true,
      });
      received += amount; txns++;
    }

    // The monthly sit-down. Assignments drift with the household's real costs.
    const drift = 1 + ix * 0.004;
    const plan: [string, number][] = [
      ["Rent", tidy(38_000 * drift)], ["Groceries", tidy(13_000 * drift)],
      ["Vegetables", 2_600], ["Milk", 2_200], ["Eating out", tidy(5_500 * drift)],
      ["Fuel", 4_800], ["Cab / auto", 2_800], ["Electricity", tidy(2_800 * drift)],
      ["Broadband", 1_199], ["Mobile recharge", 1_400], ["Household", 3_000],
      ["Personal", 4_500], ["EMIs", 16_000], ["Medical", 2_500],
      ["Investments", 22_000], ["Domestic help", tidy(4_500 * drift)],
      ["Parental support", 8_000],
    ];
    for (const [name, amount] of plan) setAssigned(db, actor, month, id(name), rupees(amount) as Paise);

    // Bills and the routine, on the days they actually happen.
    if (live(3)) { spendOn(savings.id, "Rent", tidy(38_000 * drift), "Landlord", day(month, 3)); txns++; }
    if (live(5)) { spendOn(savings.id, "Domestic help", tidy(4_500 * drift), "Domestic help", day(month, 5)); txns++; }
    if (live(9)) { spendOn(savings.id, "Broadband", 1_199, "ACT Fibernet", day(month, 9)); txns++; }
    if (live(11)) { spendOn(savings.id, "Electricity", tidy(between(2_200, 3_900) * drift), pick(UTILITY), day(month, 11)); txns++; }
    if (live(13)) { spendOn(current.id, "Parental support", 8_000, "Family transfer", day(month, 13)); txns++; }
    if (live(16)) { spendOn(savings.id, "Mobile recharge", 1_399, "Airtel", day(month, 16)); txns++; }

    // Day-to-day. Groceries and food land mostly on the cards, which is what
    // makes the payment envelopes worth having.
    for (let k = 0; k < between(6, 10); k++) {
      const d = between(1, 28); if (!live(d)) continue;
      spendOn(rand() < 0.6 ? hdfcCard.id : savings.id, "Groceries",
              tidy(between(700, 3_400)), pick(GROCERS), day(month, d)); txns++;
    }
    for (let k = 0; k < between(5, 12); k++) {
      const d = between(1, 28); if (!live(d)) continue;
      spendOn(hdfcCard.id, "Eating out", tidy(between(240, 1_900)), pick(FOOD), day(month, d)); txns++;
    }
    for (let k = 0; k < between(3, 7); k++) {
      const d = between(1, 28); if (!live(d)) continue;
      spendOn(rand() < 0.5 ? axisCard.id : cash.id, "Cab / auto",
              tidy(between(120, 620)), pick(TRAVEL), day(month, d)); txns++;
    }
    for (let k = 0; k < between(1, 3); k++) {
      const d = between(1, 28); if (!live(d)) continue;
      spendOn(axisCard.id, "Fuel", tidy(between(1_800, 3_600)), pick(TRAVEL), day(month, d)); txns++;
    }
    for (let k = 0; k < between(2, 5); k++) {
      const d = between(1, 28); if (!live(d)) continue;
      // Priya's add-on, attributed to her rather than to the primary holder.
      const hers = rand() < 0.45;
      spendOn(axisCard.id, "Personal", tidy(between(600, 5_200)), pick(SHOPS), day(month, d),
              hers ? { cardId: addOn.id, owner: priya.id } : {}); txns++;
    }
    for (let k = 0; k < between(2, 5); k++) {
      const d = between(1, 28); if (!live(d)) continue;
      spendOn(cash.id, "Vegetables", tidy(between(120, 640)), "Local market", day(month, d)); txns++;
    }
    if (rand() < 0.55 && live(20)) {
      spendOn(savings.id, "Medical", tidy(between(500, 6_500)), pick(HEALTH), day(month, 20)); txns++;
    }

    // Cash comes from an ATM, which is a transfer and not spending.
    if (live(10)) {
      createTransfer(db, actor, {
        fromAccountId: savings.id, toAccountId: cash.id,
        amount: rupees(6_000), date: day(month, 10),
      });
    }

    // Loan instalments.
    if (live(5)) {
      const interest = Math.round(10_20_000 * 0.1025 / 12 * Math.pow(0.994, ix));
      recordInstalment(db, actor, {
        loanId: eduLoan.id, date: day(month, 5), amount: rupees(16_000),
        principal: rupees(16_000 - interest), interest: rupees(interest),
        fromAccountId: savings.id,
      });
    }
    if (ix > 14 && live(5)) {
      recordInstalment(db, actor, {
        loanId: personalLoan.id, date: day(month, 5), amount: rupees(14_944),
        principal: rupees(11_111), interest: rupees(3_833),
        fromAccountId: savings.id,
      });
    }

    // The monthly SIP, and prices that move.
    flexiNav *= 1 + (rand() - 0.44) * 0.05;
    indexNav *= 1 + (rand() - 0.45) * 0.04;
    applePrice *= 1 + (rand() - 0.46) * 0.07;
    usdInr *= 1 + (rand() - 0.48) * 0.012;
    const sipDay = day(month, 5);
    if (live(5)) {
      for (const [inst, nav, amount] of [[flexi, flexiNav, 12_000], [index, indexNav, 10_000]] as const) {
        recordPurchase(db, actor, {
          accountId: demat.id, instrumentId: inst.id, tradeDate: sipDay,
          price: toPrice(Number(nav.toFixed(2))), amount: rupees(amount),
          fromAccountId: savings.id, categoryId: id("Investments"),
        });
        recordPrice(db, { instrumentId: inst.id, price: toPrice(Number(nav.toFixed(2))), asOf: sipDay, source: "demo" });
      }
      recordPrice(db, { instrumentId: apple.id, price: toPrice(Number(applePrice.toFixed(2))), asOf: sipDay, source: "demo" });
      recordFxRate(db, { base: "USD", quote: "INR", rate: Number(usdInr.toFixed(2)), asOf: sipDay, source: "demo" });
    }

    // The card statement and its payment. Occasionally the household lets a
    // month get away from it, which is the state the app exists to surface.
    if (live(24)) {
      const owed = tidy(between(14_000, 34_000));
      setAssigned(db, actor, month, cardCat.id, rupees(rand() < 0.14 ? Math.round(owed * 0.72) : owed) as Paise);
      setAssigned(db, actor, month, axisCat.id, rupees(tidy(between(5_000, 14_000))) as Paise);
      if (live(26)) {
        createTransfer(db, actor, {
          fromAccountId: savings.id, toAccountId: hdfcCard.id,
          amount: rupees(owed), date: day(month, 26),
        });
        createTransfer(db, actor, {
          fromAccountId: savings.id, toAccountId: axisCard.id,
          amount: rupees(tidy(between(4_000, 12_000))), date: day(month, 27),
        });
      }
    }

    // Hand-valued pots, revalued quarterly like a real household would.
    if (ix % 3 === 0) {
      goldValue = Math.round(goldValue * (1 + (rand() - 0.35) * 0.06));
      npsValue = Math.round(npsValue * 1.02 + 6_000);
      recordValuation(db, actor, { accountId: gold.id, value: rupees(goldValue), asOf: day(month, 1) });
      recordValuation(db, actor, { accountId: nps.id, value: rupees(npsValue), asOf: day(month, 1) });
    }

    // Anything left after the month is covered gets held rather than spent —
    // the habit that gets a household to spending last month's income.
    void received;

    snapshotNetWorth(db, actor, isCurrent ? today : lastDayOfMonth(month));
    if (!isCurrent) closeMonth(db, actor, month);
  });

  // ------------------------------------------------------- one-off history
  // A rate reset and a prepayment, so the loan screens have something to show.
  recordLoanStatement(db, actor, {
    loanId: eduLoan.id, asOf: day(months[MONTHS - 2]!, 20),
    lenderOutstanding: rupees(7_40_000), interestPaidYtd: rupees(62_400),
  });
  recordInstalment(db, actor, {
    loanId: personalLoan.id, date: day(months[MONTHS - 8]!, 18),
    amount: rupees(60_000), fromAccountId: savings.id, kind: "prepayment",
    note: "Lump sum against principal",
  });

  // A holding sold, so realised gains and the FIFO lot preview have data.
  const indexHolding = listHoldings(db, demat.id).find((h) => h.instrument_id === index.id);
  if (indexHolding) {
    recordSale(db, actor, {
      holdingId: indexHolding.id, date: day(months[MONTHS - 5]!, 12),
      price: toPrice(Number(indexNav.toFixed(2))), units: toUnits(40),
      toAccountId: savings.id,
    });
  }

  // A foreign holding, so the asset-versus-currency split has something to say.
  recordPurchase(db, actor, {
    accountId: demat.id, instrumentId: apple.id, tradeDate: day(months[8]!, 14),
    price: toPrice(172), units: toUnits(12), fxRate: 83.4,
    fromAccountId: savings.id, categoryId: id("Investments"),
  });

  const property = createAssetAccount(db, actor, { name: "Property (at cost)", subtype: "physical" });
  recordValuation(db, actor, { accountId: property.id, value: rupees(58_00_000), asOf: opened });

  // Money lent to a relative, partly repaid.
  const lent = createFamilyLoan(db, actor, {
    counterparty: "Cousin — Arun", note: "Towards his shop deposit",
    agreedTotal: rupees(1_20_000), startedAt: day(months[10]!, 6),
  });
  recordAdvance(db, actor, {
    loanId: lent.id, amount: rupees(1_20_000), date: day(months[10]!, 6), fromAccountId: savings.id,
  });
  recordRepayment(db, actor, {
    loanId: lent.id, amount: rupees(40_000), date: day(months[22]!, 9), accountId: savings.id,
  });

  // Standing instructions, so the cashflow calendar projects against something.
  const nextMonth = addMonths(thisMonth, 1);
  const schedule = (name: string, amount: number, d: number, category: string, sub = false) =>
    createSchedule(db, actor, {
      name, amount: rupees(-amount), recurrence: "monthly",
      nextDue: day(nextMonth, d), categoryId: id(category), accountId: savings.id,
      isSubscription: sub,
    });
  schedule("Rent", 38_000, 3, "Rent");
  schedule("ACT Fibernet", 1_199, 9, "Broadband", true);
  schedule("Netflix", 649, 12, "DTH / OTT subscriptions", true);
  schedule("Spotify", 149, 14, "DTH / OTT subscriptions", true);
  schedule("Electricity", 2_900, 11, "Electricity");
  schedule("Domestic help", 4_600, 5, "Domestic help");

  createGoal(db, actor, {
    name: "Kerala trip", targetAmount: rupees(90_000),
    targetDate: `${addMonths(thisMonth, 5)}-01`, categoryIds: [id("Travel home")],
  });
  createGoal(db, actor, {
    name: "Emergency fund", targetAmount: rupees(6_00_000),
    targetDate: `${addMonths(thisMonth, 20)}-01`, categoryIds: [id("Emergency fund")],
  });

  const n = (t: string) => queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${t}`)?.n ?? 0;
  console.log(
    `Demo household seeded across ${MONTHS} months, ${months[0]} → ${thisMonth}:\n` +
    `  ${n("transactions")} transactions · ${n("accounts")} accounts · ${categories.size} categories\n` +
    `  ${n("loan_payments")} loan payments · ${n("lots")} investment lots · ${n("month_closes")} months closed\n` +
    `  ${n("net_worth_snapshots")} net-worth snapshots · ${n("schedules")} schedules · ${n("goals")} goals`,
  );
  console.log(`\nRun with DEMO_MODE=true and open /signin.`);
  void txns;
  db.close();
}

main();
