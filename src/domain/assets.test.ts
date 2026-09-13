/**
 * R30 · The firewall, as a test suite.
 *
 * `05` §5 excluded net worth because "every budgeting app that added it became
 * a dashboard, and dashboards do not change spending behaviour". That
 * exclusion was reversed, and R30's ten invariants are the containment that
 * made the reversal safe.
 *
 * Q15 declined making R30 a build gate, so these are tests and a review item
 * rather than a blocker — `09` §7 records that as an accepted risk. Tests are
 * still the cheapest way to know: `05` §5's standing test is that *if net
 * worth ever appears on the budget screen, this module has failed*.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDatabase, ensureHousehold, execute, queryOne, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned } from "./budget.ts";
import { createLoan } from "./loans.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale,
  recordDividend, recordSplit, recordMerger, recordPrice, recordFxRate, recordValuation,
  latestValuation, latestPrice, fxRate, viewHolding, listHoldings,
} from "./assets.ts";
import { netWorthStatement, snapshotNetWorth, netWorthChange } from "./networth.ts";
import { units, price, formatUnits } from "../portfolio/holdings.ts";
import { buildBudgetView } from "../web/viewmodel.ts";
import { computeBudget, identityResidual } from "../engine/engine.ts";
import { loadEngineInput } from "../engine/repository.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };
const MONTH = todayIST().slice(0, 7);

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());

  const savings = createAccount(db, actor, {
    name: "HDFC Savings", kind: "budget", subtype: "savings",
    openingBalance: rupees(500_000), openingDate: `${MONTH}-01`,
  });
  const group = createGroup(db, actor, "Savings goals");
  const investments = createCategory(db, actor, { groupId: group.id, name: "Investments" });
  const demat = createAssetAccount(db, actor, { name: "Zerodha", subtype: "investment" });

  const fund = findOrCreateInstrument(db, actor, {
    name: "Parag Parikh Flexi Cap - Direct - Growth",
    kind: "mutual-fund", symbol: "122639", isin: "INF879O01019", provider: "mfapi",
  });

  return { db, savings, investments, demat, fund };
}

function rta(db: DB): number {
  const state = computeBudget(loadEngineInput(db)).get(MONTH)!;
  return state.readyToAssign;
}

describe("R30 · the firewall", () => {
  test("FW1 — an asset account's value never contributes to Ready to Assign", () => {
    const { db, demat, fund } = setup();
    const before = rta(db);

    // A holding worth ₹5,00,000 appears out of nowhere, with no cash moving.
    recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: fund.id,
      tradeDate: `${MONTH}-05`, price: price(80), units: units(6250),
    });
    recordPrice(db, { instrumentId: fund.id, price: price(160), asOf: todayIST(), source: "test" });

    assert.equal(rta(db), before, "market value cannot reach the budget");
    db.close();
  });

  test("FW2 — a portfolio doubling changes no envelope", () => {
    const { db, demat, fund, investments } = setup();
    setAssigned(db, actor, MONTH, investments.id, rupees(75_000));

    recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: fund.id,
      tradeDate: `${MONTH}-05`, price: price(80), units: units(937.5),
    });

    recordPrice(db, { instrumentId: fund.id, price: price(80), asOf: `${MONTH}-05`, source: "t" });
    const beforeView = buildBudgetView(db);
    const beforeBalance = beforeView.categories.get(investments.id)!.state.balance;
    const beforeRta = beforeView.monthState.readyToAssign;

    // The price doubles.
    recordPrice(db, { instrumentId: fund.id, price: price(160), asOf: todayIST(), source: "t" });

    const afterView = buildBudgetView(db);
    assert.equal(afterView.categories.get(investments.id)!.state.balance, beforeBalance);
    assert.equal(afterView.monthState.readyToAssign, beforeRta);
    db.close();
  });

  test("FW3 — net worth never appears on the budget screen", () => {
    // The standing test from `05` §5. Enforced structurally: the budget view
    // does not import the net worth or assets modules at all.
    const source = readFileSync(new URL("../web/viewmodel.ts", import.meta.url), "utf8");
    assert.ok(!source.includes("networth"), "viewmodel must not import net worth");
    assert.ok(!source.includes("domain/assets"), "viewmodel must not import assets");
    assert.ok(!source.includes("portfolio/"), "viewmodel must not import the portfolio engine");

    const budgetPage = readFileSync(new URL("../web/pages/budget.ts", import.meta.url), "utf8");
    assert.ok(!/net\s*worth/i.test(budgetPage), "the budget screen must not mention net worth");
    assert.ok(!/portfolio/i.test(budgetPage), "nor portfolio value");

    // A *link* to those screens in the sidebar is not a breach — `03` §2 puts
    // them there, and F28.2 requires a disabled module to disappear from
    // navigation, so an enabled one must appear. What FW3 forbids is the
    // figure, and the check above is on the screen that renders figures.
    const layout = readFileSync(new URL("../web/layout.ts", import.meta.url), "utf8");
    assert.ok(layout.includes("/net-worth"), "the sidebar link is expected");
  });

  test("FW4 — buying is money leaving the budget, through a category", () => {
    const { db, savings, demat, fund, investments } = setup();
    setAssigned(db, actor, MONTH, investments.id, rupees(25_000));

    const beforeRta = rta(db);
    const beforeBalance = buildBudgetView(db).categories.get(investments.id)!.state.balance;

    recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: fund.id, tradeDate: `${MONTH}-05`,
      price: price(80), amount: rupees(25_000),
      fromAccountId: savings.id, categoryId: investments.id,
    });

    const after = buildBudgetView(db);
    // The envelope is consumed, so reports do not count it as consumption of
    // nothing — and RTA is untouched, because the money was already assigned.
    assert.equal(
      after.categories.get(investments.id)!.state.balance,
      beforeBalance - rupees(25_000),
    );
    assert.equal(after.monthState.readyToAssign, beforeRta);
    db.close();
  });

  test("FW5 — sale proceeds are income: the full proceeds, not the gain", () => {
    const { db, savings, demat, fund, investments } = setup();
    setAssigned(db, actor, MONTH, investments.id, rupees(25_000));
    recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: fund.id, tradeDate: `${MONTH}-05`,
      price: price(80), amount: rupees(25_000),
      fromAccountId: savings.id, categoryId: investments.id,
    });

    const beforeRta = rta(db);
    const holding = listHoldings(db, demat.id)[0]!;

    // Sell at double: proceeds ₹50,000, gain ₹25,000.
    const preview = recordSale(db, actor, {
      holdingId: holding.id, units: units(312.5), price: price(160),
      date: todayIST(), toAccountId: savings.id,
    });

    assert.equal(preview.proceeds, rupees(50_000));
    assert.equal(preview.realisedGain, rupees(25_000));
    // Cash is cash: all ₹50,000 arrives to be assigned, not just the gain.
    assert.equal(rta(db) - beforeRta, rupees(50_000));
    db.close();
  });

  test("FW6 — a cash dividend is income; a reinvested one is not", () => {
    const { db, savings, demat, fund } = setup();
    recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: fund.id,
      tradeDate: `${MONTH}-05`, price: price(80), units: units(1000),
    });
    const holding = listHoldings(db, demat.id)[0]!;

    const beforeRta = rta(db);
    recordDividend(db, actor, {
      holdingId: holding.id, date: todayIST(), amount: rupees(2_000),
      toAccountId: savings.id,
    });
    assert.equal(rta(db) - beforeRta, rupees(2_000), "cash dividends are income");

    const afterCash = rta(db);
    recordDividend(db, actor, {
      holdingId: holding.id, date: todayIST(), amount: rupees(3_000),
      reinvestAtPrice: price(100),
    });
    assert.equal(rta(db), afterCash, "a reinvested dividend never touches the budget");

    // …but it does create units.
    assert.equal(formatUnits(viewHolding(db, holding.id)!.units), "1030.000");
    db.close();
  });

  test("FW7 — a price refresh creates, modifies and deletes no transaction", () => {
    const { db, demat, fund } = setup();
    recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: fund.id,
      tradeDate: `${MONTH}-05`, price: price(80), units: units(100),
    });

    const before = db.prepare(`SELECT * FROM transactions ORDER BY id`).all();
    for (const p of [90, 110, 75, 160]) {
      recordPrice(db, { instrumentId: fund.id, price: price(p), asOf: todayIST(), source: "t" });
    }
    assert.deepEqual(db.prepare(`SELECT * FROM transactions ORDER BY id`).all(), before);
    db.close();
  });

  test("FW8 — an FX rate change never alters a recorded transaction", () => {
    const { db, savings, demat, investments } = setup();
    const usStock = findOrCreateInstrument(db, actor, {
      name: "Apple Inc", kind: "equity", symbol: "AAPL", currency: "USD", provider: "alphavantage",
    });

    recordFxRate(db, { base: "USD", quote: "INR", rate: 83.0, asOf: `${MONTH}-05`, source: "t" });
    setAssigned(db, actor, MONTH, investments.id, rupees(200_000));
    recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: usStock.id, tradeDate: `${MONTH}-05`,
      price: price(150), units: units(10), fxRate: 83.0,
      fromAccountId: savings.id, categoryId: investments.id,
    });

    const before = db.prepare(`SELECT id, amount, date FROM transactions ORDER BY id`).all();

    // The rupee moves a long way.
    recordFxRate(db, { base: "USD", quote: "INR", rate: 95.51, asOf: todayIST(), source: "t" });

    assert.deepEqual(
      db.prepare(`SELECT id, amount, date FROM transactions ORDER BY id`).all(),
      before,
      "last month's recorded amounts do not move because the rupee did",
    );

    // The lot's frozen rate is likewise untouched (R33.1).
    const lot = queryOne<{ fx_rate: number }>(db, `SELECT fx_rate FROM lots LIMIT 1`)!;
    assert.equal(lot.fx_rate, 83.0);
    db.close();
  });

  test("FW9 — the portfolio is fully usable with every price feed down", () => {
    const { db, demat, fund } = setup();
    recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: fund.id,
      tradeDate: `${MONTH}-01`, price: price(80), units: units(1000),
    });
    recordPrice(db, { instrumentId: fund.id, price: price(86.4), asOf: `${MONTH}-02`, source: "mfapi" });

    // Weeks later, with no successful fetch since.
    const holding = listHoldings(db, demat.id)[0]!;
    const view = viewHolding(db, holding.id, "2027-01-01")!;

    assert.equal(view.marketValue, rupees(86_400), "never blanked, never zeroed");
    assert.equal(view.quote!.stale, true, "but visibly marked");
    assert.equal(view.quote!.asOf, `${MONTH}-02`, "and labelled with its actual date");
    db.close();
  });

  test("FW10 — the budget view touches no price table", () => {
    const { db, demat, fund, investments } = setup();
    setAssigned(db, actor, MONTH, investments.id, rupees(25_000));
    recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: fund.id,
      tradeDate: `${MONTH}-05`, price: price(80), units: units(100),
    });

    // Dropping the price tables entirely must not break the budget screen —
    // which is the strongest available statement of "does not depend on".
    execute(db, `DROP TABLE prices`);
    execute(db, `DROP TABLE fx_rates`);

    const view = buildBudgetView(db);
    assert.ok(view.monthState.readyToAssign !== undefined);
    assert.ok(view.categories.get(investments.id));
    db.close();
  });

  test("the budgeting identity still holds with a portfolio present", () => {
    const { db, savings, demat, fund, investments } = setup();
    setAssigned(db, actor, MONTH, investments.id, rupees(50_000));
    recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: fund.id, tradeDate: `${MONTH}-05`,
      price: price(80), amount: rupees(25_000),
      fromAccountId: savings.id, categoryId: investments.id,
    });
    recordPrice(db, { instrumentId: fund.id, price: price(200), asOf: todayIST(), source: "t" });

    for (const [month, state] of computeBudget(loadEngineInput(db))) {
      assert.equal(identityResidual(state), 0, `identity broken in ${month}`);
    }
    db.close();
  });
});

describe("R23 · asset accounts", () => {
  test("R23.2 — a manual valuation is dated history, not a mutable number", () => {
    const { db } = setup();
    const property = createAssetAccount(db, actor, {
      name: "Flat", subtype: "physical", openingValue: rupees(6_200_000), asOf: "2026-01-01",
    });
    recordValuation(db, actor, {
      accountId: property.id, value: rupees(6_500_000), asOf: "2026-08-01",
    });

    const rows = db.prepare(`SELECT as_of, value FROM asset_valuations ORDER BY as_of`).all();
    assert.equal(rows.length, 2, "the earlier valuation is kept, not overwritten");
    assert.equal(latestValuation(db, property.id, "2026-08-26")!.value, rupees(6_500_000));
    db.close();
  });

  test("R23.3 — a stale valuation says so", () => {
    const { db } = setup();
    const property = createAssetAccount(db, actor, {
      name: "Flat", subtype: "physical", openingValue: rupees(6_200_000), asOf: "2026-01-01",
    });
    assert.equal(latestValuation(db, property.id, "2026-03-01")!.stale, false);
    assert.equal(latestValuation(db, property.id, "2027-01-01")!.stale, true);
    db.close();
  });

  test("R23.4 — a secured loan with no asset tracked is surfaced, not ignored", () => {
    const { db } = setup();
    createLoan(db, actor, {
      lender: "HDFC", loanType: "home", sanctioned: rupees(5_000_000),
      sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 8.5,
      tenureMonths: 240, currentOutstanding: rupees(4_792_181),
    });

    const statement = netWorthStatement(db);
    assert.equal(statement.untrackedAssetWarnings.length, 1);
    // 07 §4: omit the property and the household looks ₹25.3 lakh underwater.
    assert.match(statement.untrackedAssetWarnings[0]!, /haven't\s+recorded as an asset/);

    createAssetAccount(db, actor, {
      name: "Property — flat", subtype: "physical",
      openingValue: rupees(6_200_000), asOf: "2026-01-01",
    });
    assert.deepEqual(netWorthStatement(db).untrackedAssetWarnings, []);
    db.close();
  });
});

describe("R29 · the net worth statement", () => {
  test("reproduces the worked example", () => {
    const { db } = setup();

    // 07 §4's household, built from real records.
    execute(db, `UPDATE accounts SET opening_balance = ? WHERE kind = 'budget'`, rupees(342_000));

    const epf = createAssetAccount(db, actor, { name: "EPF and PPF", subtype: "retirement" });
    recordValuation(db, actor, { accountId: epf.id, value: rupees(1_450_000), asOf: todayIST() });
    const gold = createAssetAccount(db, actor, { name: "Gold", subtype: "commodity" });
    recordValuation(db, actor, { accountId: gold.id, value: rupees(285_000), asOf: todayIST() });
    const property = createAssetAccount(db, actor, { name: "Property (at cost)", subtype: "physical" });
    recordValuation(db, actor, { accountId: property.id, value: rupees(6_200_000), asOf: todayIST() });

    const card = createAccount(db, actor, {
      name: "Cards", kind: "credit", subtype: "credit-card",
      openingBalance: rupees(-68_400), openingDate: `${MONTH}-01`,
    });
    createLoan(db, actor, {
      lender: "HDFC", nickname: "Home loan", loanType: "home",
      sanctioned: rupees(5_000_000), sanctionDate: "2026-01-01",
      interestModel: "reducing", annualRatePct: 8.5, tenureMonths: 240,
      currentOutstanding: rupees(4_792_181),
    });

    const statement = netWorthStatement(db);
    assert.equal(statement.totalLiabilities, rupees(4_860_581));
    // Assets here are cash + the three manual valuations; the two priced
    // holdings from `07` are covered by the portfolio tests.
    assert.equal(statement.totalAssets, rupees(8_277_000));
    assert.equal(statement.netWorth, statement.totalAssets - statement.totalLiabilities);
    void card;
    db.close();
  });

  test("R29.1 — states the staleness of its worst input", () => {
    const { db } = setup();
    const property = createAssetAccount(db, actor, { name: "Flat", subtype: "physical" });
    recordValuation(db, actor, { accountId: property.id, value: rupees(100), asOf: "2020-01-01" });

    const statement = netWorthStatement(db);
    assert.equal(statement.hasStaleInputs, true);
    assert.equal(statement.worstInputDate, "2020-01-01");
    db.close();
  });

  test("R29.4 — the change decomposes into four different things", () => {
    const { db, savings } = setup();
    snapshotNetWorth(db, actor, "2026-07-01");

    // Money saved, and debt repaid.
    execute(
      db, `INSERT INTO transactions (id,account_id,date,amount,source,created_at,updated_at)
           VALUES ('t1',?,?,?,'manual',?,?)`,
      savings.id, "2026-07-15", rupees(42_000), nowIST(), nowIST(),
    );
    snapshotNetWorth(db, actor, "2026-08-01");

    const change = netWorthChange(db, "2026-07-01", "2026-08-01")!;
    assert.equal(change.moneySaved, rupees(42_000));
    assert.equal(change.total, rupees(42_000));
    // A single figure would have hidden which of the four it was.
    assert.match(change.reading, /saved/);
    db.close();
  });

  test("R29.2 — snapshots build a real history rather than a reconstruction", () => {
    const { db } = setup();
    snapshotNetWorth(db, actor, "2026-06-01");
    snapshotNetWorth(db, actor, "2026-07-01");
    // Re-snapshotting the same date updates rather than duplicating.
    snapshotNetWorth(db, actor, "2026-07-01");
    assert.equal(
      queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM net_worth_snapshots`)!.n, 2,
    );
    db.close();
  });
});

describe("R26, R32 · prices and rates", () => {
  test("R26.8 — the last published price is used and labelled, never interpolated", () => {
    const { db, fund } = setup();
    recordPrice(db, { instrumentId: fund.id, price: price(86.4), asOf: "2026-08-21", source: "mfapi" });

    // Asking about a Sunday returns Friday's price, dated Friday.
    const quote = latestPrice(db, fund.id, "2026-08-23")!;
    assert.equal(quote.asOf, "2026-08-21");
    assert.equal(quote.price, price(86.4));
    db.close();
  });

  test("R26.5 — a later fetch for the same date does not lose the earlier one", () => {
    const { db, fund } = setup();
    recordPrice(db, { instrumentId: fund.id, price: price(80), asOf: "2026-08-20", source: "mfapi" });
    recordPrice(db, { instrumentId: fund.id, price: price(86.4), asOf: "2026-08-21", source: "mfapi" });
    assert.equal(latestPrice(db, fund.id, "2026-08-20")!.price, price(80));
    db.close();
  });

  test("R32.3 — a weekend rate falls back to the last published one, labelled", () => {
    const { db } = setup();
    recordFxRate(db, { base: "USD", quote: "INR", rate: 95.42, asOf: "2026-08-21", source: "frankfurter" });
    const quote = fxRate(db, "USD", "INR", "2026-08-23")!;
    assert.equal(quote.rate, 95.42);
    assert.equal(quote.asOf, "2026-08-21", "labelled with the date it was actually published");
    db.close();
  });

  test("R32.4 — a rate older than the threshold is flagged", () => {
    const { db } = setup();
    recordFxRate(db, { base: "USD", quote: "INR", rate: 83, asOf: "2026-08-01", source: "t" });
    assert.equal(fxRate(db, "USD", "INR", "2026-08-03")!.stale, false);
    assert.equal(fxRate(db, "USD", "INR", "2026-08-20")!.stale, true);
    db.close();
  });

  test("converting a currency to itself needs no rate at all", () => {
    const { db } = setup();
    assert.equal(fxRate(db, "INR", "INR")!.rate, 1);
    db.close();
  });
});

describe("R28 · corporate actions through the database", () => {
  test("a split multiplies units, leaves the basis, and fixes the price history", () => {
    const { db, demat, fund } = setup();
    recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: fund.id,
      tradeDate: "2026-01-05", price: price(80), units: units(100),
    });
    recordPrice(db, { instrumentId: fund.id, price: price(80), asOf: "2026-01-05", source: "t" });
    const holding = listHoldings(db, demat.id)[0]!;

    const before = viewHolding(db, holding.id, "2026-08-26")!;
    recordSplit(db, actor, { holdingId: holding.id, date: "2026-08-01", ratio: 2 });
    const after = viewHolding(db, holding.id, "2026-08-26")!;

    assert.equal(after.units, before.units * 2);
    assert.equal(after.costBasis, before.costBasis, "nothing was bought");
    // R28.2: the pre-split history is adjusted so a chart shows no false crash.
    assert.equal(latestPrice(db, fund.id, "2026-01-06")!.price, price(40));
    db.close();
  });

  /*
   * The corporate action Indian fund investors actually meet, and the one the
   * app could not record: `applyMerger` was written, the events table allowed
   * the kind, and nothing called either. The household's only options were a
   * wrong unit count or a sale that never happened — and a fictitious sale
   * manufactures a capital gain and restarts the clock on long-term treatment.
   */
  test("a merger reissues units and carries the cost forward", () => {
    const { db, demat, fund } = setup();
    recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: fund.id,
      tradeDate: "2026-01-05", price: price(80), units: units(100),
    });
    const holding = listHoldings(db, demat.id)[0]!;
    const before = viewHolding(db, holding.id, "2026-08-26")!;

    // 8 new units for every 10 held.
    recordMerger(db, actor, { holdingId: holding.id, date: "2026-08-01", ratio: 0.8 });

    const after = viewHolding(db, holding.id, "2026-08-26")!;
    assert.equal(after.units, Math.round(before.units * 0.8), "units were reissued");
    assert.equal(after.costBasis, before.costBasis, "and the cost carried forward");
    assert.equal(
      queryOne<{ n: number }>(
        db, `SELECT COUNT(*) AS n FROM holding_events WHERE holding_id = ? AND kind = 'merger'`,
        holding.id,
      )!.n,
      1,
      "recorded as a merger, not as a sale",
    );
    assert.equal(
      queryOne<{ n: number }>(
        db, `SELECT COUNT(*) AS n FROM holding_events WHERE holding_id = ? AND kind = 'sale'`,
        holding.id,
      )!.n,
      0,
      "nothing was realised",
    );
    db.close();
  });

  test("it can point the holding at the surviving scheme", () => {
    const { db, demat, fund } = setup();
    recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: fund.id,
      tradeDate: "2026-01-05", price: price(80), units: units(100),
    });
    const survivor = findOrCreateInstrument(db, actor, {
      name: "Parag Parikh Flexi Cap - Direct - Growth (merged)",
      kind: "mutual-fund", provider: "manual",
    });
    const holding = listHoldings(db, demat.id)[0]!;

    recordMerger(db, actor, {
      holdingId: holding.id, date: "2026-08-01", ratio: 1, intoInstrumentId: survivor.id,
    });

    assert.equal(
      viewHolding(db, holding.id, "2026-08-26")!.instrument.id, survivor.id,
      "it now reads as the scheme that survived",
    );
    db.close();
  });

  test("merging into something already held in the same account is refused", () => {
    const { db, demat, fund } = setup();
    recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: fund.id,
      tradeDate: "2026-01-05", price: price(80), units: units(100),
    });
    const other = findOrCreateInstrument(db, actor, {
      name: "Some other fund", kind: "mutual-fund", provider: "manual",
    });
    recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: other.id,
      tradeDate: "2026-02-05", price: price(50), units: units(10),
    });
    const holding = listHoldings(db, demat.id).find((h) => h.instrument_id === fund.id)!;

    // Silently folding them together would lose the distinction between lots
    // bought at different times, which is the one thing R25.1 forbids.
    assert.throws(
      () => recordMerger(db, actor, {
        holdingId: holding.id, date: "2026-08-01", ratio: 1, intoInstrumentId: other.id,
      }),
      /already hold the scheme it merged into/,
    );
    db.close();
  });

  test("a ratio of zero or less is refused", () => {
    const { db, demat, fund } = setup();
    recordPurchase(db, actor, {
      accountId: demat.id, instrumentId: fund.id,
      tradeDate: "2026-01-05", price: price(80), units: units(100),
    });
    const holding = listHoldings(db, demat.id)[0]!;
    assert.throws(
      () => recordMerger(db, actor, { holdingId: holding.id, date: "2026-08-01", ratio: 0 }),
      /above zero/,
    );
    db.close();
  });
});
