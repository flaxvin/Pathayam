/**
 * F11 · Goals (piggy banks).
 *
 * F11.2 is the design decision: goals live on their **own screen**, outside
 * the monthly budget grid. A long-horizon savings intention and a monthly
 * envelope answer different questions, and mixing them makes the budget screen
 * about aspiration rather than about this month.
 *
 * Progress is measured by the balance of the linked categories — a goal never
 * holds money of its own, so there is nothing to reconcile and no way for the
 * two figures to disagree.
 */

import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, registerUndoHandler, type Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf, monthsBetween, type IsoDate } from "../core/dates.ts";
import { formatPaise, allocate, type Paise } from "../core/money.ts";

export interface Goal {
  id: string;
  name: string;
  target_amount: Paise;
  target_date: IsoDate | null;
  note: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface GoalProgress {
  goal: Goal;
  categories: { id: string; name: string; balance: Paise }[];
  /** Combined balance of every linked category. */
  saved: Paise;
  remaining: Paise;
  percent: number;
  /** F11.2: what it takes each month to arrive on time. */
  requiredMonthly: Paise | null;
  monthsRemaining: number | null;
  /** True once the linked categories hold the target. */
  reached: boolean;
  /** Stated plainly, because a bare percentage does not tell you what to do. */
  reading: string;
}

export function createGoal(
  db: DB, actor: Actor,
  input: { name: string; targetAmount: Paise; targetDate?: IsoDate | null; note?: string | null; categoryIds: string[] },
): Goal {
  if (input.targetAmount <= 0) throw new Error("A goal needs a target above zero.");
  if (input.categoryIds.length === 0) {
    // F11.1: progress is measured against categories, so a goal without one
    // could never move.
    throw new Error("Link the goal to at least one category, so its progress can be measured.");
  }

  return transact(db, () => {
    const id = newId();
    execute(
      db,
      `INSERT INTO goals (id,name,target_amount,target_date,note,created_at,created_by)
       VALUES (?,?,?,?,?,?,?)`,
      id, input.name, input.targetAmount, input.targetDate ?? null,
      input.note ?? null, nowIST(), actor.memberId,
    );

    for (const categoryId of input.categoryIds) {
      execute(
        db, `INSERT OR IGNORE INTO goal_categories (goal_id, category_id) VALUES (?,?)`,
        id, categoryId,
      );
    }

    const goal = getGoal(db, id)!;
    appendEvent(db, actor, {
      entity: "goal", entityId: id, action: "create", after: goal,
      summary: `Added the goal "${input.name}" — ${formatPaise(input.targetAmount)}`,
    });
    return goal;
  });
}

export function getGoal(db: DB, id: string): Goal | null {
  return queryOne<Goal>(db, `SELECT * FROM goals WHERE id = ?`, id);
}

/** The category ids a goal is measured against (B58: exactly one per goal). */
export function goalCategoryIds(db: DB, goalId: string): string[] {
  return queryAll<{ category_id: string }>(
    db, `SELECT category_id FROM goal_categories WHERE goal_id = ?`, goalId,
  ).map((r) => r.category_id);
}

export function listGoals(db: DB, opts: { includeCompleted?: boolean } = {}): Goal[] {
  return queryAll<Goal>(
    db,
    `SELECT * FROM goals ${opts.includeCompleted ? "" : "WHERE completed_at IS NULL"}
      ORDER BY target_date IS NULL, target_date, created_at`,
  );
}

/**
 * Progress for every goal, given the current category balances.
 *
 * Balances are passed in rather than fetched, so this stays a pure reading of
 * the same figures the budget screen shows — the two can never disagree.
 */
export function goalProgress(
  db: DB, categoryBalances: Map<string, { name: string; balance: Paise }>, today = todayIST(),
): GoalProgress[] {
  return listGoals(db).map((goal) => {
    const linked = queryAll<{ category_id: string }>(
      db, `SELECT category_id FROM goal_categories WHERE goal_id = ?`, goal.id,
    );

    const categories = linked
      .map((l) => {
        const entry = categoryBalances.get(l.category_id);
        return entry ? { id: l.category_id, name: entry.name, balance: entry.balance } : null;
      })
      .filter((c): c is { id: string; name: string; balance: Paise } => c !== null);

    const saved = categories.reduce((sum, c) => sum + Math.max(0, c.balance), 0);
    const remaining = Math.max(0, goal.target_amount - saved);
    const percent = goal.target_amount > 0 ? Math.min(100, (saved / goal.target_amount) * 100) : 0;
    const reached = saved >= goal.target_amount;

    let monthsRemaining: number | null = null;
    let requiredMonthly: Paise | null = null;
    if (goal.target_date) {
      monthsRemaining = Math.max(0, monthsBetween(monthOf(today), monthOf(goal.target_date)) + 1);
      if (monthsRemaining > 0 && remaining > 0) {
        // allocate() so the monthly figures sum back to exactly the target.
        requiredMonthly = allocate(remaining, monthsRemaining)[0] ?? 0;
      }
    }

    return {
      goal, categories, saved, remaining, percent, requiredMonthly, monthsRemaining, reached,
      reading: describe(goal, saved, remaining, requiredMonthly, monthsRemaining, reached),
    };
  });
}

function describe(
  goal: Goal, saved: Paise, remaining: Paise,
  requiredMonthly: Paise | null, monthsRemaining: number | null, reached: boolean,
): string {
  if (reached) {
    return `Done — ${formatPaise(saved)} set aside. Spend it, roll it into something else, or send it back to Ready to Assign.`;
  }
  if (requiredMonthly !== null && monthsRemaining !== null) {
    return (
      `${formatPaise(remaining)} to go. Putting ${formatPaise(requiredMonthly)} aside each month ` +
      `for the next ${monthsRemaining} gets you there on time.`
    );
  }
  if (goal.target_date && monthsRemaining === 0) {
    return `${formatPaise(remaining)} short, and the date has arrived.`;
  }
  return `${formatPaise(remaining)} to go. No date set, so there is no monthly figure to aim at yet.`;
}

/**
 * F11.4 · Completing a goal offers three things, because the money is real and
 * has to go somewhere: spend it, roll it into a new goal, or return it to
 * Ready to Assign.
 */
export function completeGoal(
  db: DB, actor: Actor, goalId: string,
  resolution: "spend" | "roll" | "release",
): void {
  transact(db, () => {
    const goal = getGoal(db, goalId);
    if (!goal) throw new Error("That goal does not exist.");

    execute(db, `UPDATE goals SET completed_at = ? WHERE id = ?`, nowIST(), goalId);
    appendEvent(db, actor, {
      entity: "goal", entityId: goalId, action: "complete",
      before: goal, after: { ...goal, completed_at: nowIST() },
      summary:
        `Completed "${goal.name}" — ` +
        (resolution === "spend" ? "keeping the money where it is to spend"
        : resolution === "roll" ? "rolling the balance into a new goal"
        : "returning the balance to Ready to Assign"),
    });
  });
}

/** F11 · Edit a goal's name, target and (optional) date. Links are unchanged. */
export function updateGoal(
  db: DB, actor: Actor, goalId: string,
  input: { name: string; targetAmount: Paise; targetDate?: IsoDate | null; note?: string | null },
): Goal {
  if (input.targetAmount <= 0) throw new Error("A goal needs a target above zero.");
  return transact(db, () => {
    const before = getGoal(db, goalId);
    if (!before) throw new Error("That goal does not exist.");
    execute(
      db,
      `UPDATE goals SET name = ?, target_amount = ?, target_date = ?, note = ? WHERE id = ?`,
      input.name, input.targetAmount, input.targetDate ?? null, input.note ?? before.note, goalId,
    );
    const after = getGoal(db, goalId)!;
    appendEvent(db, actor, {
      entity: "goal", entityId: goalId, action: "update", before, after,
      summary: `Edited the goal "${input.name}" — ${formatPaise(input.targetAmount)}`,
    });
    return after;
  });
}

export function deleteGoal(db: DB, actor: Actor, goalId: string): void {
  transact(db, () => {
    const goal = getGoal(db, goalId);
    if (!goal) throw new Error("That goal does not exist.");
    execute(db, `DELETE FROM goal_categories WHERE goal_id = ?`, goalId);
    execute(db, `DELETE FROM goals WHERE id = ?`, goalId);
    appendEvent(db, actor, {
      entity: "goal", entityId: goalId, action: "delete", before: goal,
      summary: `Removed the goal "${goal.name}". The money stays in its categories.`,
    });
  });
}

registerUndoHandler("goal", (db, event) => {
  const before = event.before as Goal | undefined;
  if (!before) {
    execute(db, `DELETE FROM goal_categories WHERE goal_id = ?`, event.entityId!);
    execute(db, `DELETE FROM goals WHERE id = ?`, event.entityId!);
    return `Removed the goal that was added`;
  }
  // Restore every field, so undoing an edit (name/target/date) or a completion
  // both land back exactly where they were — not just completed_at.
  execute(
    db,
    `INSERT INTO goals (id,name,target_amount,target_date,note,completed_at,created_at)
     VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name,
         target_amount = excluded.target_amount, target_date = excluded.target_date,
         note = excluded.note, completed_at = excluded.completed_at`,
    before.id, before.name, before.target_amount, before.target_date,
    before.note, before.completed_at, before.created_at,
  );
  return `Restored the goal "${before.name}"`;
});
