/**
 * A small builder for engine scenarios.
 *
 * Exists so a test reads like the worked example it encodes — "assign ₹12,000
 * to Groceries, spend ₹13,400 from savings" — rather than like a pile of
 * pre-aggregated records. Used by the test suite and by demo-data seeding.
 */

import type { Paise } from "../core/money.ts";
import { rupees } from "../core/money.ts";
import type { MonthKey } from "../core/dates.ts";
import { addMonths } from "../core/dates.ts";
import { emptyMonth, type EngineInput, type MonthlyFacts, type CategoryMeta, type OverspendModel } from "./types.ts";

export class Scenario {
  private readonly categories: CategoryMeta[] = [];
  private readonly facts: Record<MonthKey, MonthlyFacts> = {};
  private readonly monthOrder: MonthKey[] = [];
  private model: OverspendModel = "reduce-rta";
  private readonly creditOpening: Record<string, Paise> = {};

  constructor(...months: MonthKey[]) {
    for (const m of months) this.month(m);
  }

  /** Register a month, creating any gap months in between so the walk is contiguous. */
  month(month: MonthKey): this {
    if (this.facts[month]) return this;
    const last = this.monthOrder.at(-1);
    if (last && last < month) {
      let cursor = addMonths(last, 1);
      while (cursor < month) {
        this.facts[cursor] = emptyMonth();
        this.monthOrder.push(cursor);
        cursor = addMonths(cursor, 1);
      }
    }
    this.facts[month] = emptyMonth();
    this.monthOrder.push(month);
    this.monthOrder.sort();
    return this;
  }

  overspendModel(model: OverspendModel): this {
    this.model = model;
    return this;
  }

  category(id: string, opts: { name?: string; group?: string; hidden?: boolean } = {}): this {
    this.categories.push({
      id,
      name: opts.name ?? id,
      groupId: opts.group ?? "g-default",
      hidden: opts.hidden ?? false,
      paymentAccountId: null,
    });
    return this;
  }

  /** R6: the payment category the app creates alongside a Credit account. */
  paymentCategory(id: string, accountId: string, opts: { name?: string } = {}): this {
    this.categories.push({
      id,
      name: opts.name ?? id,
      groupId: "g-credit-payments",
      hidden: false,
      paymentAccountId: accountId,
    });
    return this;
  }

  /** Starting debt on a card at account creation (R6). */
  cardOpeningBalance(accountId: string, rupeeAmount: number): this {
    this.creditOpening[accountId] = rupees(rupeeAmount);
    return this;
  }

  /** Income arriving in a Budget account — reaches Ready to Assign (F2.5). */
  income(month: MonthKey, rupeeAmount: number): this {
    const f = this.at(month);
    f.budgetAccountFlow += rupees(rupeeAmount);
    return this;
  }

  assign(month: MonthKey, categoryId: string, rupeeAmount: number): this {
    const f = this.at(month);
    f.assigned[categoryId] = (f.assigned[categoryId] ?? 0) + rupees(rupeeAmount);
    return this;
  }

  /** R5: a move is two assignment deltas, so RTA does not change. */
  move(month: MonthKey, fromId: string, toId: string, rupeeAmount: number): this {
    return this.assign(month, fromId, -rupeeAmount).assign(month, toId, rupeeAmount);
  }

  /** Spend from a Budget account, charged to a category. */
  spendCash(month: MonthKey, categoryId: string, rupeeAmount: number): this {
    const f = this.at(month);
    const amount = -rupees(rupeeAmount);
    f.activity[categoryId] = (f.activity[categoryId] ?? 0) + amount;
    f.budgetAccountFlow += amount;
    f.budgetCategorisedFlow += amount;
    return this;
  }

  /** Spend from a Budget account with no category — reduces RTA directly (F4.1). */
  spendUncategorised(month: MonthKey, rupeeAmount: number): this {
    this.at(month).budgetAccountFlow -= rupees(rupeeAmount);
    return this;
  }

  /** Spend on a card, charged to a category (R6). */
  spendCard(month: MonthKey, accountId: string, categoryId: string, rupeeAmount: number): this {
    const f = this.at(month);
    const amount = -rupees(rupeeAmount);
    f.activity[categoryId] = (f.activity[categoryId] ?? 0) + amount;
    f.creditActivity[categoryId] = (f.creditActivity[categoryId] ?? 0) + amount;
    f.creditAccountFlow[accountId] = (f.creditAccountFlow[accountId] ?? 0) + amount;
    const byAccount = (f.creditActivityByAccount[categoryId] ??= {});
    byAccount[accountId] = (byAccount[accountId] ?? 0) + amount;
    return this;
  }

  /** Pay a card from a Budget account (R6) — a transfer, touching no spending category. */
  payCard(month: MonthKey, accountId: string, rupeeAmount: number): this {
    const f = this.at(month);
    const amount = rupees(rupeeAmount);
    f.budgetAccountFlow -= amount;
    f.budgetTransferFlow -= amount;
    f.creditAccountFlow[accountId] = (f.creditAccountFlow[accountId] ?? 0) + amount;
    return this;
  }

  /** Move money between two Budget accounts — invisible to the budget. */
  transferBetweenBudgetAccounts(month: MonthKey): this {
    void month; // Both legs net to zero; here for documentation.
    return this;
  }

  /** R11: set income aside for the following month. */
  hold(month: MonthKey, rupeeAmount: number): this {
    this.at(month).held += rupees(rupeeAmount);
    return this;
  }

  build(): EngineInput {
    return {
      months: [...this.monthOrder],
      facts: this.facts,
      categories: this.categories,
      overspendModel: this.model,
      creditOpeningBalances: this.creditOpening,
    };
  }

  private at(month: MonthKey): MonthlyFacts {
    this.month(month);
    return this.facts[month]!;
  }
}
