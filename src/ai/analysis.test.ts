/**
 * The analysis layer: what an AI client is told, in what shape, and — above
 * all — that it is told nothing the member could not read on their own screens.
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, type DB } from "../db/db.ts";
import { Missing, Refusal } from "../core/refusal.ts";
import { todayIST, monthOf, addDays } from "../core/dates.ts";
import { simulateHousehold } from "../sim/scenario.ts";
import { listMembers } from "../auth/sessions.ts";
import {
  inr, aiOverview, aiAccounts, aiTransactions, aiBudgetMonth, aiSpending, aiLoans, aiLoanSchedule,
  aiPortfolio, aiRealisedGains, aiNetWorth, aiTaxEstimate, aiCashflow, aiInsurance, aiGoals, aiFire,
  aiExplain, aiSnapshot, TRANSACTIONS_MAX_LIMIT, type AnalysisOptions,
} from "./analysis.ts";
import {
  buildAnalysisWorld, RAVI, PRIYA, SECRET_NAMES, SECRET_AMOUNTS, TAX_FY, type AnalysisWorld,
} from "./analysis.test-data.ts";

/** Every function, as a member, with arguments that exercise it. */
function everything(db: DB, viewer: string, opts: AnalysisOptions = {}): Record<string, unknown> {
  const today = todayIST();
  const out: Record<string, unknown> = {
    overview: aiOverview(db, viewer, {}, opts),
    accounts: aiAccounts(db, viewer, { includeClosed: true }, opts),
    transactions: aiTransactions(db, viewer, { limit: TRANSACTIONS_MAX_LIMIT }, opts),
    transactions_text: aiTransactions(db, viewer, { text: "a", include_transfers: true }, opts),
    budget: aiBudgetMonth(db, viewer, {}, opts),
    budget_last_month: aiBudgetMonth(db, viewer, { month: monthOf(addDays(`${monthOf(today)}-01`, -1)) }, opts),
    loans: aiLoans(db, viewer, {}, opts),
    portfolio: aiPortfolio(db, viewer, {}, opts),
    gains: aiRealisedGains(db, viewer, {}, opts),
    net_worth: aiNetWorth(db, viewer, {}, opts),
    tax: aiTaxEstimate(db, viewer, {}, opts),
    cashflow: aiCashflow(db, viewer, { days: 366 }, opts),
    insurance: aiInsurance(db, viewer, {}, opts),
    goals: aiGoals(db, viewer, {}, opts),
    fire: aiFire(db, viewer, {}, opts),
    explain_rta: aiExplain(db, viewer, { what: "ready_to_assign" }, opts),
    snapshot: aiSnapshot(db, viewer, {}, opts),
  };
  for (const by of ["category", "payee", "month", "account"] as const) {
    out[`spending_${by}`] = aiSpending(db, viewer, { from: "2000-01-01", to: today, group_by: by }, opts);
  }
  // Each loan's schedule, and each envelope's explanation, that the viewer is shown.
  const loans = out.loans as { loans?: { loan_id: string }[] };
  for (const l of loans.loans ?? []) {
    out[`schedule_${l.loan_id}`] = aiLoanSchedule(db, viewer, { loan_id: l.loan_id }, opts);
  }
  const budget = out.budget as { budgets: { groups: { envelopes: { category_id: string }[] }[] }[] };
  for (const e of budget.budgets.flatMap((b) => b.groups.flatMap((g) => g.envelopes)).slice(0, 25)) {
    out[`explain_${e.category_id}`] = aiExplain(db, viewer, { what: "category", category_id: e.category_id }, opts);
  }
  return out;
}

/** Every number in a result, so a NaN or an Infinity cannot hide inside one. */
function numbers(value: unknown, path = "$", out: [string, number][] = []): [string, number][] {
  if (typeof value === "number") out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => numbers(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) numbers(v, `${path}.${k}`, out);
  }
  return out;
}

describe("AI · money is rupees, converted in one place", () => {
  test("paise to rupees with two decimals", () => {
    assert.equal(inr(123456), 1234.56);
    assert.equal(inr(-5), -0.05);
    assert.equal(inr(100), 1);
    assert.equal(inr(0), 0);
    assert.ok(Object.is(inr(-0), 0), "no negative zero");
    assert.equal(inr(12_34_56_789), 1234567.89);
  });

  test("a fraction of a paisa the engine carried is rounded, not printed", () => {
    assert.equal(inr(1000.4), 10);
    assert.equal(inr(1000.5), 10.01);
    assert.equal(inr(-33.3333), -0.33);
  });

  test("nothing stays nothing", () => {
    assert.equal(inr(null), null);
    assert.equal(inr(undefined), null);
    assert.equal(inr(Number.NaN), null);
  });
});

describe("AI · every function runs on the demo household", () => {
  let db: DB;
  let members: string[];
  before(() => {
    db = openDatabase({ path: ":memory:", verbose: false });
    ensureHousehold(db);
    simulateHousehold(db);
    members = listMembers(db).map((m) => m.id);
  });

  test("as each member still here, without throwing, as plain JSON", () => {
    assert.ok(members.length >= 2);
    for (const m of members) {
      const out = everything(db, m);
      const text = JSON.stringify(out);
      assert.deepEqual(JSON.parse(text), out, "a value did not survive JSON (a Map, a Date, undefined in an array)");
      const bad = numbers(out).filter(([, n]) => !Number.isFinite(n));
      assert.deepEqual(bad, [], "a number that JSON would print as null");
    }
  });

  test("amounts carry at most two decimals", () => {
    const out = everything(db, members[0]!);
    // Rates, percentages, units and per-unit prices are not money and may carry more.
    const notMoney = /(pct|rate|units|per_unit|percent|runway|years|share|months|count|days|number)/;
    const loose = numbers(out)
      .filter(([path]) => !notMoney.test(path.split(".").at(-1) ?? ""))
      .filter(([, n]) => Math.abs(Math.round(n * 100) - n * 100) > 1e-6);
    assert.deepEqual(loose.slice(0, 5), [], "an amount with more than two decimals");
  });

  test("the snapshot stays small enough to paste", () => {
    for (const months of [12, 36]) {
      const size = Buffer.byteLength(JSON.stringify(aiSnapshot(db, members[0]!, { months }), null, 2));
      assert.ok(size < 300_000, `${months} months came to ${size} bytes`);
    }
    const snap = aiSnapshot(db, members[0]!, { months: 3 });
    assert.equal(snap.currency, "INR");
    assert.equal(snap.spending_by_month.length, 4, "three months back and this one");
    assert.ok(snap.spending_by_month.every((m) => m.top_payees.length <= 20));
    assert.ok(!("transactions" in snap), "the register is not in the snapshot");
  });

  test("a disabled feature is a section that says so, not a throw", () => {
    const off: AnalysisOptions = { features: { assets: false, loans: false } };
    const out = everything(db, members[0]!, off);
    for (const key of ["portfolio", "gains", "net_worth", "fire", "loans"]) {
      assert.equal((out[key] as { enabled: boolean }).enabled, false, key);
    }
    const snap = out.snapshot as { overview: { net_worth: { enabled: boolean } } };
    assert.equal(snap.overview.net_worth.enabled, false);
  });

  test("spending by category agrees with spending by month over the same window", () => {
    const from = `${monthOf(addDays(todayIST(), -200))}-01`;
    const a = aiSpending(db, members[0]!, { from, to: todayIST(), group_by: "category" });
    const b = aiSpending(db, members[0]!, { from, to: todayIST(), group_by: "month" });
    assert.equal(a.total_spent, b.total_spent);
    assert.ok(a.total_spent > 0);
  });
});

describe("AI · nothing private to Ravi reaches Priya", () => {
  let world: AnalysisWorld;
  let control: AnalysisWorld;
  before(() => {
    world = buildAnalysisWorld();
    control = buildAnalysisWorld({ withPrivate: false });
  });

  test("no name, id or amount of his, in any function's answer", () => {
    const text = JSON.stringify(everything(world.db, PRIYA));
    const ids = Object.entries(world.ids)
      .filter(([k]) => k.startsWith("private"))
      .map(([, v]) => v!);
    assert.equal(ids.length, 9);
    assert.deepEqual(SECRET_NAMES.filter((s) => text.includes(s)), [], "a name leaked");
    assert.deepEqual(ids.filter((s) => text.includes(s)), [], "an id leaked");
    assert.deepEqual(SECRET_AMOUNTS.filter((s) => text.includes(s)), [], "an amount leaked");
  });

  test("and her totals are the totals of the household without him", () => {
    const seen = everything(world.db, PRIYA);
    const without = everything(control.db, PRIYA);
    const pick = (o: Record<string, unknown>) => {
      const ov = o.overview as ReturnType<typeof aiOverview>;
      const acc = o.accounts as ReturnType<typeof aiAccounts>;
      const tx = o.transactions as ReturnType<typeof aiTransactions>;
      const nw = o.net_worth as { net_worth: number; total_assets: number; total_liabilities: number };
      const loans = o.loans as { total_outstanding: number; everything_owed: unknown[] };
      const cf = o.cashflow as ReturnType<typeof aiCashflow>;
      const pf = o.portfolio as { totals: unknown };
      const budget = o.budget as ReturnType<typeof aiBudgetMonth>;
      return {
        budgets: ov.budgets.map((b) => [b.budget_kind, b.ready_to_assign, b.cash_in_budget_accounts, b.spent_this_month]),
        overview_net_worth: ov.net_worth,
        account_totals: acc.totals_by_kind,
        account_count: acc.accounts.length,
        transactions: [tx.total_matching, tx.totals],
        spending: (o.spending_category as { total_spent: number }).total_spent,
        net_worth: [nw.net_worth, nw.total_assets, nw.total_liabilities],
        loans: [loans.total_outstanding, loans.everything_owed.length],
        cashflow: cf.budgets.map((b) => [b.opening_balance, b.lowest_balance, b.outflow_total, b.schedules_due.length]),
        maturities: cf.deposit_maturities.length,
        portfolio: pf.totals,
        policies: (o.insurance as { policies: unknown[] }).policies.length,
        goals: (o.goals as { goals: unknown[] }).goals.length,
        budget_month: budget.budgets.map((b) => [b.budget_kind, b.assigned, b.activity, b.available]),
      };
    };
    assert.deepEqual(pick(seen), pick(without));
  });

  test("Priya sees one budget; Ravi sees his own labelled beside the household's", () => {
    const hers = aiBudgetMonth(world.db, PRIYA);
    assert.deepEqual(hers.budgets.map((b) => b.budget_kind), ["household"]);
    const his = aiBudgetMonth(world.db, RAVI);
    assert.deepEqual(his.budgets.map((b) => [b.budget_kind, b.budget_name]), [
      ["household", "Household budget"], ["personal", "Ravi's personal budget"],
    ]);
  });

  test("as Ravi, every private thing of his is there", () => {
    const text = JSON.stringify(everything(world.db, RAVI));
    const missing = SECRET_NAMES.filter((s) => !text.includes(s));
    assert.deepEqual(missing, [], "his own things should be in his answers");
    assert.ok(text.includes("300017.31"), "his private account's balance");
    const tax = aiTaxEstimate(world.db, RAVI, { fy: TAX_FY }) as { gross_income?: number };
    assert.equal(tax.gross_income, 1234567, "his own declared income");
    const loans = aiLoans(world.db, RAVI) as ReturnType<typeof aiLoans> & { loans: { name: string; visibility: string }[] };
    assert.ok(loans.loans.some((l) => l.name === "Vorpal Private Lender" && l.visibility === "private"));
  });

  test("his ids answer not-found to her, exactly as an id that never existed", () => {
    const { ids } = world;
    const cases: [string, () => unknown, () => unknown][] = [
      ["loan schedule", () => aiLoanSchedule(world.db, PRIYA, { loan_id: ids.privateLoan! }),
        () => aiLoanSchedule(world.db, PRIYA, { loan_id: "no-such-loan" })],
      ["explain envelope", () => aiExplain(world.db, PRIYA, { what: "category", category_id: ids.privateCategory! }),
        () => aiExplain(world.db, PRIYA, { what: "category", category_id: "no-such-envelope" })],
      ["transactions by account", () => aiTransactions(world.db, PRIYA, { account_id: ids.privateAccount! }),
        () => aiTransactions(world.db, PRIYA, { account_id: "no-such-account" })],
      ["transactions by envelope", () => aiTransactions(world.db, PRIYA, { category_id: ids.privateCategory! }),
        () => aiTransactions(world.db, PRIYA, { category_id: "no-such-envelope" })],
    ];
    for (const [what, theirs, nobodys] of cases) {
      let a: unknown; let b: unknown;
      assert.throws(theirs, (e: unknown) => { a = e; return e instanceof Missing; }, what);
      assert.throws(nobodys, (e: unknown) => { b = e; return e instanceof Missing; }, what);
      assert.equal((a as Missing).message, (b as Missing).message, `${what}: the two answers differ`);
      assert.equal((a as Missing).status, 404);
    }
    // And they open for Ravi.
    assert.ok(aiLoanSchedule(world.db, RAVI, { loan_id: ids.privateLoan! }));
    assert.equal(aiTransactions(world.db, RAVI, { account_id: ids.privateAccount! }).total_matching, 4);
  });
});

describe("AI · transactions are paged, newest first, and capped", () => {
  const world = buildAnalysisWorld({ withPrivate: false, householdTransactions: 25 });

  test("pages walk the whole set once, in order", () => {
    const seen: string[] = [];
    const dates: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = aiTransactions(world.db, PRIYA, { limit: 10, cursor });
      assert.equal(page.total_matching, 25);
      seen.push(...page.transactions.map((t) => t.transaction_id));
      dates.push(...page.transactions.map((t) => t.date));
      cursor = page.next_cursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    assert.equal(seen.length, 25);
    assert.equal(new Set(seen).size, 25, "a row was repeated across pages");
    assert.deepEqual([...dates].sort().reverse(), dates, "not newest first");
  });

  test("the default is a hundred, and no more than five hundred however many are asked for", () => {
    const big = buildAnalysisWorld({ withPrivate: false, householdTransactions: 520 });
    const dflt = aiTransactions(big.db, PRIYA);
    assert.equal(dflt.transactions.length, 100);
    const many = aiTransactions(big.db, PRIYA, { limit: 100_000 });
    assert.equal(many.limit, 500);
    assert.equal(many.transactions.length, 500);
    assert.equal(many.total_matching, 520);
    assert.ok(many.next_cursor);
  });

  test("filters narrow by payee, amount and date", () => {
    const today = todayIST();
    assert.equal(aiTransactions(world.db, PRIYA, { payee: "dmart" }).total_matching, 13);
    // 100 + i rupees for i in 0..24, so 120 and up is five of them.
    assert.equal(aiTransactions(world.db, PRIYA, { min_amount: 120 }).total_matching, 5);
    assert.equal(aiTransactions(world.db, PRIYA, { max_amount: 101.5 }).total_matching, 2);
    assert.equal(aiTransactions(world.db, PRIYA, { from: today, to: today }).total_matching, 1);
    const one = aiTransactions(world.db, PRIYA, { from: today, to: today }).transactions[0]!;
    assert.equal(one.amount, -100);
    assert.equal(one.category_name, "Groceries");
    assert.deepEqual(one.lines, [{ category_id: world.ids.groceries, category_name: "Groceries", amount: -100 }]);
  });

  test("nonsense is refused in words, not thrown as a fault", () => {
    for (const bad of [
      () => aiTransactions(world.db, PRIYA, { cursor: "not-a-cursor" }),
      () => aiTransactions(world.db, PRIYA, { limit: 0 }),
      () => aiTransactions(world.db, PRIYA, { from: "03/04/2026" }),
      () => aiTransactions(world.db, PRIYA, { from: "2026-05-01", to: "2026-04-01" }),
      () => aiBudgetMonth(world.db, PRIYA, { month: "2026-13" }),
      () => aiSpending(world.db, PRIYA, { from: "2026-01-01", to: "2026-02-01", group_by: "tag" as never }),
      () => aiCashflow(world.db, PRIYA, { days: -3 }),
      () => aiExplain(world.db, PRIYA, { what: "everything" as never }),
      () => aiSnapshot(world.db, PRIYA, { months: 37 }),
    ]) {
      assert.throws(bad, (e: unknown) => e instanceof Refusal && !(e instanceof Missing));
    }
  });
});

describe("AI · the tax estimate", () => {
  test("a year whose rates the app does not have is refused in a sentence, not thrown", () => {
    const { db } = buildAnalysisWorld({ withPrivate: false });
    const old = aiTaxEstimate(db, PRIYA, { fy: 2012 }) as { refused?: string };
    assert.equal(typeof old.refused, "string");
    assert.ok(old.refused!.length > 10);
  });

  test("the financial year can be named the way people write it", () => {
    const { db } = buildAnalysisWorld({ withPrivate: false });
    const a = aiTaxEstimate(db, PRIYA, { fy: 2025 });
    assert.equal(a.fy, 2025);
    assert.equal(aiTaxEstimate(db, PRIYA, { fy: "2025-26" }).fy, 2025);
    assert.equal(aiTaxEstimate(db, PRIYA, { fy: "FY 2025-26" }).fy, 2025);
    assert.throws(() => aiTaxEstimate(db, PRIYA, { fy: "last year" }), Refusal);
  });

  test("cashflow days are capped at a year and a day", () => {
    const { db } = buildAnalysisWorld({ withPrivate: false });
    assert.equal(aiCashflow(db, PRIYA, { days: 5000 }).days, 366);
    assert.equal(aiCashflow(db, PRIYA).days, 30);
    const due = aiCashflow(db, PRIYA, { days: 10 }).budgets[0]!.schedules_due;
    assert.deepEqual(due.map((s) => [s.name, s.amount]), [["Rent", -20000]]);
  });
});
