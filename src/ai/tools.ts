/**
 * AI-2 · The tools an AI connection may call, over the analysis layer.
 *
 * Each tool is one read in analysis.ts, given the database and the member the
 * connection acts for — nothing else. Descriptions are written for the model:
 * what the tool answers, in what units, and how to narrow it, because a model
 * that knows a tool pages will page instead of asking for everything.
 *
 * Names are stable: an AI client caches the list, and a household's saved
 * prompts name them.
 */

import type { DB } from "../db/db.ts";
import type { FeatureName } from "../features.ts";
import type { McpTool, JsonSchema } from "./mcp.ts";
import {
  aiOverview, aiAccounts, aiTransactions, aiBudgetMonth, aiSpending, aiLoans, aiLoanSchedule,
  aiPortfolio, aiRealisedGains, aiNetWorth, aiTaxEstimate, aiCashflow, aiInsurance, aiGoals,
  aiFire, aiExplain, aiSnapshot, type AnalysisOptions, type TransactionsArgs, type SpendingGroupBy,
} from "./analysis.ts";

const DATE: JsonSchema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "a date, YYYY-MM-DD" };
const MONTH: JsonSchema = { type: "string", pattern: "^\\d{4}-\\d{2}$", description: "a month, YYYY-MM; defaults to this month" };
const FY: JsonSchema = {
  type: "integer", minimum: 2000, maximum: 9998,
  description: "the financial year by its first calendar year: 2026 means FY 2026-27 (April 2026 to March 2027); defaults to the current one",
};
const NONE = { type: "object" as const, additionalProperties: false, properties: {} };

/**
 * Said once to the model on connect. Kept short; the units and the privacy
 * boundary are the two things a model gets wrong without being told.
 */
export const MCP_INSTRUCTIONS =
  "Pathayam is one Indian household's envelope (zero-based) budget. Read-only: nothing here can change it. " +
  "Money is in Indian rupees (INR) as decimal numbers; dates are YYYY-MM-DD in IST; financial years run April to March " +
  "and are named by their first year (2026 = FY 2026-27). You see what the connected member sees: the household budget " +
  "and their own personal budget, never another member's private accounts. Start with overview; page transactions with " +
  "limit and next_cursor rather than asking for everything. Figures are the household's own records, not advice.";

/** PLAN-1 · The module each tool reads, for the ones that belong to one. */
export const TOOL_MODULES: Readonly<Record<string, FeatureName>> = {
  loans: "loans", loan_schedule: "loans",
  portfolio: "assets", realised_gains: "assets", net_worth: "assets", financial_independence: "assets",
  tax_estimate: "tax", cashflow: "schedules", insurance: "insurance", goals: "goals",
};

export function buildTools(db: DB, viewerMemberId: string, opts: AnalysisOptions): McpTool[] {
  const tool = (
    name: string, title: string, description: string,
    schema: JsonSchema & { type: "object" },
    run: (args: Record<string, unknown>) => unknown,
  ): McpTool => ({ name, title, description, inputSchema: schema, run });

  /*
   * PLAN-1 · A tool over a module this server has switched off is not listed:
   * an AI app that is offered `loans` will call it, and an answer of "switched
   * off" to every question about debt is a worse conversation than never
   * being offered it. The functions still answer `{ enabled: false }` if
   * called by name, for a client holding a cached list.
   */
  const offered = (t: McpTool) => {
    const module = TOOL_MODULES[t.name];
    return !module || opts.features?.[module] !== false;
  };

  return ([
    tool("overview", "Household overview",
      "Start here. Ready to Assign, overspent envelopes, credit-card payments no envelope is funding, account totals by kind, net worth, and the next 14 days of cashflow.",
      { type: "object", additionalProperties: false, properties: { month: MONTH } },
      (a) => aiOverview(db, viewerMemberId, a as { month?: string }, opts)),

    tool("accounts", "Accounts",
      "Every account the member can see, with kind (budget, tracking), type, balance, cleared and uncleared amounts, institution and who holds it.",
      { type: "object", additionalProperties: false, properties: { include_closed: { type: "boolean", description: "include closed accounts; default false" } } },
      (a) => aiAccounts(db, viewerMemberId, { includeClosed: a.include_closed === true }, opts)),

    tool("transactions", "Transactions",
      "Transactions newest first, filtered. Splits appear as lines. Transfers between accounts are left out unless include_transfers is true. Default 100 rows, at most 500 a call; pass next_cursor back as cursor for the next page. total_matching says how many there are.",
      {
        type: "object", additionalProperties: false,
        properties: {
          from: DATE, to: DATE,
          account_id: { type: "string", maxLength: 64, description: "an id from accounts" },
          category_id: { type: "string", maxLength: 64, description: "an envelope id from budget_month" },
          payee: { type: "string", maxLength: 120, description: "part of a payee's name, any case" },
          text: { type: "string", maxLength: 200, description: "searches payees, memos, envelopes, tags and the bank's narration" },
          min_amount: { type: "number", minimum: 0, description: "rupees; compared with the size of each line whatever its sign" },
          max_amount: { type: "number", minimum: 0, description: "rupees" },
          include_transfers: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
          cursor: { type: "string", maxLength: 200 },
        },
      },
      (a) => aiTransactions(db, viewerMemberId, a as TransactionsArgs, opts)),

    tool("budget_month", "Budget for a month",
      "Every envelope for a month, by group, with assigned, activity and available, and its target if it has one. The household budget and the member's personal budget are labelled separately.",
      { type: "object", additionalProperties: false, properties: { month: MONTH } },
      (a) => aiBudgetMonth(db, viewerMemberId, a as { month?: string }, opts)),

    tool("spending", "Spending totals",
      "Total spending between two dates, grouped by envelope (category), payee, month or account. Transfers are excluded, as on the Reports screen.",
      {
        type: "object", additionalProperties: false, required: ["from", "to"],
        properties: {
          from: DATE, to: DATE,
          group_by: { type: "string", enum: ["category", "payee", "month", "account"], description: "default category" },
        },
      },
      (a) => aiSpending(db, viewerMemberId, a as { from: string; to: string; group_by?: SpendingGroupBy }, opts)),

    tool("loans", "Loans",
      "Loans the member can see: outstanding principal, rate, EMI, remaining tenure and interest paid so far.",
      NONE, () => aiLoans(db, viewerMemberId, {}, opts)),

    tool("loan_schedule", "Loan schedule",
      "One loan's repayment schedule: each instalment's date, principal, interest and balance after.",
      {
        type: "object", additionalProperties: false, required: ["loan_id"],
        properties: {
          loan_id: { type: "string", maxLength: 64, description: "an id from loans" },
          limit: { type: "integer", minimum: 1, maximum: 600, description: "rows; default all" },
        },
      },
      (a) => aiLoanSchedule(db, viewerMemberId, a as { loan_id: string; limit?: number }, opts)),

    tool("portfolio", "Portfolio",
      "Investment holdings with value, cost, gain and XIRR where the app computes it, and the asset allocation.",
      NONE, () => aiPortfolio(db, viewerMemberId, {}, opts)),

    tool("realised_gains", "Realised capital gains",
      "Gains realised in a financial year, short and long term, by holding.",
      { type: "object", additionalProperties: false, properties: { fy: FY } },
      (a) => aiRealisedGains(db, viewerMemberId, a as { fy?: number }, opts)),

    tool("net_worth", "Net worth",
      "The net worth statement (assets and liabilities by kind) and its history of snapshots.",
      NONE, () => aiNetWorth(db, viewerMemberId, {}, opts)),

    tool("tax_estimate", "Income tax estimate",
      "The member's income tax estimate for a financial year under both regimes, as the Tax screen shows it: an estimate on the figures entered, not a return and not advice. A year the app has no rates for is refused.",
      { type: "object", additionalProperties: false, properties: { fy: FY } },
      (a) => aiTaxEstimate(db, viewerMemberId, a as { fy?: number }, opts)),

    tool("cashflow", "Upcoming cashflow",
      "What is due in the coming days: scheduled transactions, credit-card dues and deposit maturities.",
      { type: "object", additionalProperties: false, properties: { days: { type: "integer", minimum: 1, maximum: 366, description: "default 30" } } },
      (a) => aiCashflow(db, viewerMemberId, a as { days?: number }, opts)),

    tool("insurance", "Insurance policies",
      "The policy register: insurer, type, cover, premium, when it is next due and when it renews.",
      NONE, () => aiInsurance(db, viewerMemberId, {}, opts)),

    tool("goals", "Goals", "Savings goals and how far each has come.",
      NONE, () => aiGoals(db, viewerMemberId, {}, opts)),

    tool("financial_independence", "Financial independence",
      "The financial-independence estimate: the target from what the household actually spent, the assets that could fund it, and the years a locked provident fund leaves uncovered.",
      NONE, () => aiFire(db, viewerMemberId, {}, opts)),

    tool("explain", "Explain a number",
      "How a figure was reached, line by line: Ready to Assign, or one envelope's available amount in a month.",
      {
        type: "object", additionalProperties: false, required: ["what"],
        properties: {
          what: { type: "string", enum: ["ready_to_assign", "category"] },
          category_id: { type: "string", maxLength: 64, description: "required when what is category" },
          month: MONTH,
        },
      },
      (a) => aiExplain(db, viewerMemberId, a as { what: "ready_to_assign" | "category"; category_id?: string; month?: string }, opts)),

    tool("snapshot", "Summary of everything",
      "One summary of the household's figures for broad questions: overview, accounts, a budget and spending summary per month, top payees, loans, portfolio, net worth, cashflow and the tax estimate. No transaction list. Large; prefer the narrower tools for a specific question.",
      { type: "object", additionalProperties: false, properties: { months: { type: "integer", minimum: 1, maximum: 36, description: "default 12" } } },
      (a) => aiSnapshot(db, viewerMemberId, a as { months?: number }, opts)),
  ] as McpTool[]).filter(offered);
}
