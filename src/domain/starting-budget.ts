/**
 * F3.10 · The starting budget.
 *
 * `02` §8 is blunt about why this exists: the empty state is where budgeting
 * apps lose people. The structure is Fixed / Flexible / Non-monthly / Savings
 * (§8), and the categories reflect Indian household spending rather than a
 * translated American template (L5). Festival and annual sinking funds are
 * first-class, with by-date targets (L6).
 *
 * Every amount here is a starting point the household immediately edits.
 */

import type { DB } from "../db/db.ts";
import { transact, execute, newId } from "../db/db.ts";
import { appendEvent, type Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf, addMonths } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createGroup, createCategory } from "./budget.ts";

export interface TemplateCategory {
  name: string;
  /** A fraction of monthly take-home, used to propose a starting target. */
  shareOfIncome?: number;
  target?:
    | { type: "monthly"; amount?: Paise }
    | { type: "by-date"; amount: Paise; monthsAway: number }
    | { type: "refill"; amount: Paise };
  note?: string;
}

export interface TemplateGroup {
  name: string;
  categories: TemplateCategory[];
}

export const STARTING_TEMPLATE: TemplateGroup[] = [
  {
    name: "Fixed",
    categories: [
      { name: "Rent", shareOfIncome: 0.25, target: { type: "monthly" } },
      { name: "Maintenance / society charges", shareOfIncome: 0.02, target: { type: "monthly" } },
      { name: "Domestic help", shareOfIncome: 0.03, target: { type: "monthly" } },
      { name: "Electricity", shareOfIncome: 0.02, target: { type: "monthly" } },
      { name: "Water", shareOfIncome: 0.005, target: { type: "monthly" } },
      { name: "Broadband", shareOfIncome: 0.01, target: { type: "monthly" } },
      { name: "Mobile recharge", shareOfIncome: 0.01, target: { type: "monthly" } },
      { name: "DTH / OTT subscriptions", shareOfIncome: 0.01, target: { type: "monthly" } },
      { name: "EMIs", shareOfIncome: 0.1, target: { type: "monthly" } },
      { name: "School fees", shareOfIncome: 0.05, target: { type: "monthly" } },
    ],
  },
  {
    name: "Flexible",
    categories: [
      { name: "Groceries", shareOfIncome: 0.1, target: { type: "monthly" } },
      { name: "Vegetables", shareOfIncome: 0.02, target: { type: "monthly" } },
      { name: "Milk", shareOfIncome: 0.015, target: { type: "monthly" } },
      { name: "Gas cylinder", shareOfIncome: 0.01, target: { type: "monthly" } },
      { name: "Eating out", shareOfIncome: 0.04, target: { type: "monthly" } },
      { name: "Fuel", shareOfIncome: 0.04, target: { type: "monthly" } },
      { name: "Cab / auto", shareOfIncome: 0.02, target: { type: "monthly" } },
      { name: "Household", shareOfIncome: 0.02, target: { type: "monthly" } },
      { name: "Personal", shareOfIncome: 0.03, target: { type: "monthly" } },
    ],
  },
  {
    name: "Non-monthly",
    categories: [
      // L6: festival and annual sinking funds, with by-date targets.
      { name: "Diwali", target: { type: "by-date", amount: rupees(25_000), monthsAway: 3 } },
      { name: "Onam", target: { type: "by-date", amount: rupees(15_000), monthsAway: 12 } },
      { name: "Weddings & gifts", target: { type: "by-date", amount: rupees(30_000), monthsAway: 6 } },
      { name: "Travel home", target: { type: "by-date", amount: rupees(20_000), monthsAway: 4 } },
      { name: "Term insurance premium", target: { type: "by-date", amount: rupees(25_000), monthsAway: 12 } },
      { name: "Health insurance premium", target: { type: "by-date", amount: rupees(30_000), monthsAway: 12 } },
      { name: "Motor insurance", target: { type: "by-date", amount: rupees(12_000), monthsAway: 8 } },
      { name: "Vehicle service", target: { type: "refill", amount: rupees(10_000) } },
      { name: "Medical", target: { type: "refill", amount: rupees(20_000) } },
      { name: "Parental support", shareOfIncome: 0.05, target: { type: "monthly" } },
    ],
  },
  {
    name: "Savings goals",
    categories: [
      {
        // Deliberately a monthly contribution rather than a "refill to
        // ₹3,00,000". A refill target asks for the whole balance in the first
        // month, which would put a six-figure number into the global
        // underfunded line on day one and make R8's headline figure useless.
        // Switch it to a by-date target once there is a date in mind.
        name: "Emergency fund",
        shareOfIncome: 0.05,
        target: { type: "monthly" },
        note: "Six months of essential spending is the usual goal. Give it a date once you have one.",
      },
      { name: "Investments", shareOfIncome: 0.15, target: { type: "monthly" } },
    ],
  },
];

export interface StartingBudgetAnswers {
  /** Approximate monthly take-home, used to propose target amounts. */
  monthlyIncome?: Paise;
  hasEmis?: boolean;
  hasSchoolFees?: boolean;
  hasDomesticHelp?: boolean;
}

/**
 * Create the groups, categories and targets. Returns how many categories were
 * made, so the caller can say something specific rather than "done".
 */
export function applyStartingTemplate(
  db: DB,
  actor: Actor,
  answers: StartingBudgetAnswers = {},
): { groups: number; categories: number } {
  return transact(db, () => {
    const skip = new Set<string>();
    if (answers.hasEmis === false) skip.add("EMIs");
    if (answers.hasSchoolFees === false) skip.add("School fees");
    if (answers.hasDomesticHelp === false) skip.add("Domestic help");

    let groupCount = 0;
    let categoryCount = 0;
    const thisMonth = monthOf(todayIST());

    for (const template of STARTING_TEMPLATE) {
      const group = createGroup(db, actor, template.name);
      groupCount++;

      for (const item of template.categories) {
        if (skip.has(item.name)) continue;
        const category = createCategory(db, actor, {
          groupId: group.id,
          name: item.name,
          note: item.note,
        });
        categoryCount++;

        if (!item.target) continue;

        let amount: Paise | null = null;
        let targetDate: string | null = null;
        let type = item.target.type;

        if (item.target.type === "monthly") {
          if (!answers.monthlyIncome || !item.shareOfIncome) continue;
          // Rounded to the nearest ₹100 — a proposed figure that reads as a
          // suggestion invites editing; ₹8,437 reads as a calculation.
          amount = Math.round((answers.monthlyIncome * item.shareOfIncome) / 10_000) * 10_000;
        } else if (item.target.type === "by-date") {
          amount = item.target.amount;
          targetDate = `${addMonths(thisMonth, item.target.monthsAway)}-01`;
        } else {
          amount = item.target.amount;
        }

        if (amount === null || amount <= 0) continue;

        execute(
          db,
          `INSERT INTO targets (category_id,type,amount,target_date,created_at,updated_at)
           VALUES (?,?,?,?,?,?)`,
          category.id, type, amount, targetDate, nowIST(), nowIST(),
        );
      }
    }

    execute(db, `UPDATE household SET setup_completed_at = ? WHERE id = 1`, nowIST());

    appendEvent(db, actor, {
      entity: "household",
      entityId: "1",
      action: "apply-starting-template",
      after: { groups: groupCount, categories: categoryCount },
      summary: `Created a starting budget with ${categoryCount} categories`,
    });

    return { groups: groupCount, categories: categoryCount };
  });
}

/** The escape hatch 03 J1 requires at every step: "start blank instead". */
export function startBlank(db: DB, actor: Actor): void {
  transact(db, () => {
    const groupId = newId();
    execute(
      db,
      `INSERT INTO category_groups (id,name,kind,sort,created_at) VALUES (?,?,'normal',0,?)`,
      groupId, "Everyday", nowIST(),
    );
    execute(db, `UPDATE household SET setup_completed_at = ? WHERE id = 1`, nowIST());
    appendEvent(db, actor, {
      entity: "household", entityId: "1", action: "start-blank",
      summary: "Started with a blank budget",
    });
  });
}
