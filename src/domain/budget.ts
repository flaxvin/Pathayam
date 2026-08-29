/**
 * F3 · Category groups, categories, and the budgeting acts themselves:
 * assigning (R7), moving money (R5) and holding income (R11).
 */

import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, registerUndoHandler, type Actor } from "../core/events.ts";
import { nowIST, formatMonth, type MonthKey, type IsoDate } from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";

export interface CategoryGroup {
  id: string;
  name: string;
  kind: "normal" | "credit-payments" | "loan-payments" | "internal";
  sort: number;
  hidden_at: string | null;
}

export interface Category {
  id: string;
  group_id: string;
  name: string;
  sort: number;
  hidden_at: string | null;
  deleted_at: string | null;
  note: string | null;
  payment_account_id: string | null;
}

export function createGroup(db: DB, actor: Actor, name: string): CategoryGroup {
  return transact(db, () => {
    const id = newId();
    const sort =
      queryOne<{ n: number }>(db, `SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM category_groups`)?.n ?? 1;
    execute(
      db,
      `INSERT INTO category_groups (id,name,kind,sort,created_at) VALUES (?,?,'normal',?,?)`,
      id, name, sort, nowIST(),
    );
    const group = queryOne<CategoryGroup>(db, `SELECT * FROM category_groups WHERE id = ?`, id)!;
    appendEvent(db, actor, {
      entity: "category-group", entityId: id, action: "create", after: group,
      summary: `Added the group "${name}"`,
    });
    return group;
  });
}

export function createCategory(
  db: DB, actor: Actor, input: { groupId: string; name: string; note?: string },
): Category {
  return transact(db, () => {
    const id = newId();
    const sort =
      queryOne<{ n: number }>(
        db, `SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM categories WHERE group_id = ?`, input.groupId,
      )?.n ?? 1;
    execute(
      db,
      `INSERT INTO categories (id,group_id,name,sort,note,created_at) VALUES (?,?,?,?,?,?)`,
      id, input.groupId, input.name, sort, input.note ?? null, nowIST(),
    );
    const category = queryOne<Category>(db, `SELECT * FROM categories WHERE id = ?`, id)!;
    appendEvent(db, actor, {
      entity: "category", entityId: id, action: "create", after: category,
      summary: `Added the category "${input.name}"`,
    });
    return category;
  });
}

export function listCategories(db: DB, opts: { includeHidden?: boolean } = {}): Category[] {
  return queryAll<Category>(
    db,
    `SELECT c.* FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE c.deleted_at IS NULL ${opts.includeHidden ? "" : "AND c.hidden_at IS NULL"}
      ORDER BY g.sort, c.sort, c.name`,
  );
}

export function listGroups(db: DB): CategoryGroup[] {
  return queryAll<CategoryGroup>(db, `SELECT * FROM category_groups ORDER BY sort, name`);
}

export function getCategory(db: DB, id: string): Category | null {
  return queryOne<Category>(db, `SELECT * FROM categories WHERE id = ?`, id);
}

export function renameCategory(db: DB, actor: Actor, id: string, name: string): Category {
  return transact(db, () => {
    const before = getCategory(db, id);
    if (!before) throw new Error("That category does not exist.");
    execute(db, `UPDATE categories SET name = ? WHERE id = ?`, name, id);
    const after = getCategory(db, id)!;
    appendEvent(db, actor, {
      entity: "category", entityId: id, action: "rename", before, after,
      summary: `Renamed "${before.name}" to "${name}"`,
    });
    return after;
  });
}

/** F3.2: a hidden category keeps its balance and history but leaves the totals. */
export function setCategoryHidden(db: DB, actor: Actor, id: string, hidden: boolean): void {
  transact(db, () => {
    const before = getCategory(db, id);
    if (!before) throw new Error("That category does not exist.");
    if (before.payment_account_id && hidden) {
      throw new Error("A card's payment category cannot be hidden while the account is open.");
    }
    execute(db, `UPDATE categories SET hidden_at = ? WHERE id = ?`, hidden ? nowIST() : null, id);
    appendEvent(db, actor, {
      entity: "category", entityId: id, action: hidden ? "hide" : "unhide", before,
      after: getCategory(db, id),
      summary: `${hidden ? "Hid" : "Unhid"} "${before.name}"`,
    });
  });
}

/**
 * F3.3: deleting requires reassigning the balance and offers to remap history.
 * The balance must be dealt with by the caller first — this refuses rather than
 * silently stranding money.
 */
export function deleteCategory(
  db: DB, actor: Actor, id: string,
  opts: { remapTo?: string | null; currentBalance: Paise },
): void {
  transact(db, () => {
    const before = getCategory(db, id);
    if (!before) throw new Error("That category does not exist.");
    if (before.payment_account_id) {
      throw new Error("A card's payment category cannot be deleted while the account exists (R6).");
    }
    if (opts.currentBalance !== 0) {
      throw new Error(
        `"${before.name}" still holds ${formatPaise(opts.currentBalance)}. Move it somewhere else first.`,
      );
    }

    if (opts.remapTo) {
      execute(db, `UPDATE transactions SET category_id = ? WHERE category_id = ?`, opts.remapTo, id);
      execute(db, `UPDATE transaction_splits SET category_id = ? WHERE category_id = ?`, opts.remapTo, id);
    }
    execute(db, `DELETE FROM assignments WHERE category_id = ?`, id);
    execute(db, `DELETE FROM targets WHERE category_id = ?`, id);
    execute(db, `DELETE FROM autoassign_rules WHERE category_id = ?`, id);
    execute(db, `UPDATE categories SET deleted_at = ? WHERE id = ?`, nowIST(), id);

    appendEvent(db, actor, {
      entity: "category", entityId: id, action: "delete", before,
      summary: opts.remapTo
        ? `Deleted "${before.name}" and moved its history to another category`
        : `Deleted "${before.name}"`,
    });
  });
}

/**
 * F3.4 · Set (or replace) a category's target — what it should hold. Two shapes
 * cover almost everything a household sets by hand: a flat **monthly** amount,
 * and **by a date** (put aside X by then). The target drives the underfunded
 * figure, auto-assign and the target bar; before this it could only be set by
 * the first-run template and never edited.
 */
export function setTarget(
  db: DB, actor: Actor, categoryId: string,
  input: { type: "monthly" | "by-date"; amount: Paise; targetDate?: IsoDate | null },
): void {
  transact(db, () => {
    const category = getCategory(db, categoryId);
    if (!category) throw new Error("That category does not exist.");
    if (input.amount <= 0) throw new Error("A target needs an amount above zero.");
    if (input.type === "by-date" && !input.targetDate) {
      throw new Error("A by-date target needs a date.");
    }
    const before = queryOne(db, `SELECT * FROM targets WHERE category_id = ?`, categoryId);
    execute(
      db,
      `INSERT INTO targets (category_id,type,amount,target_date,created_at,updated_at)
       VALUES (?,?,?,?,?,?)
         ON CONFLICT(category_id) DO UPDATE SET type = excluded.type,
           amount = excluded.amount, target_date = excluded.target_date,
           updated_at = excluded.updated_at`,
      categoryId, input.type, input.amount, input.targetDate ?? null, nowIST(), nowIST(),
    );
    appendEvent(db, actor, {
      entity: "target", entityId: categoryId, action: before ? "update" : "create",
      before, after: queryOne(db, `SELECT * FROM targets WHERE category_id = ?`, categoryId),
      summary:
        `Set ${category.name}'s target to ${formatPaise(input.amount)}` +
        (input.type === "by-date" ? ` by ${input.targetDate}` : " a month"),
    });
  });
}

export function clearTarget(db: DB, actor: Actor, categoryId: string): void {
  transact(db, () => {
    const before = queryOne(db, `SELECT * FROM targets WHERE category_id = ?`, categoryId);
    if (!before) return;
    const category = getCategory(db, categoryId);
    execute(db, `DELETE FROM targets WHERE category_id = ?`, categoryId);
    appendEvent(db, actor, {
      entity: "target", entityId: categoryId, action: "delete", before,
      summary: `Removed ${category?.name ?? "a category"}'s target`,
    });
  });
}

/** The stored target for a category, if any (for the edit form). */
export function getTarget(db: DB, categoryId: string): {
  type: string; amount: Paise | null; target_date: IsoDate | null;
} | null {
  return queryOne(db, `SELECT type, amount, target_date FROM targets WHERE category_id = ?`, categoryId);
}

// ---------------------------------------------------------------------------
// Assigning — R7
// ---------------------------------------------------------------------------

export function getAssigned(db: DB, month: MonthKey, categoryId: string): Paise {
  return (
    queryOne<{ amount: number }>(
      db, `SELECT amount FROM assignments WHERE month = ? AND category_id = ?`, month, categoryId,
    )?.amount ?? 0
  );
}

function writeAssignment(db: DB, month: MonthKey, categoryId: string, amount: Paise): void {
  if (amount === 0) {
    execute(db, `DELETE FROM assignments WHERE month = ? AND category_id = ?`, month, categoryId);
    return;
  }
  execute(
    db,
    `INSERT INTO assignments (month, category_id, amount, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(month, category_id) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`,
    month, categoryId, amount, nowIST(),
  );
}

/**
 * Set the amount assigned to a category for a month (R7).
 *
 * Q5: **any** past month is editable. Where that collides with a reconciliation
 * checkpoint, the caller must have taken the confirmation and marked it broken
 * (`09` §5) — see `reconciliation.ts`. Nothing is refused here.
 */
export function setAssigned(
  db: DB, actor: Actor, month: MonthKey, categoryId: string, amount: Paise,
): Paise {
  return transact(db, () => {
    const before = getAssigned(db, month, categoryId);
    if (before === amount) return amount;

    const category = getCategory(db, categoryId);
    if (!category) throw new Error("That category does not exist.");

    writeAssignment(db, month, categoryId, amount);
    appendEvent(db, actor, {
      entity: "assignment",
      entityId: `${month}:${categoryId}`,
      action: "assign",
      before: { amount: before },
      after: { amount },
      summary:
        before === 0
          ? `Assigned ${formatPaise(amount)} to ${category.name} for ${formatMonth(month)}`
          : `Changed ${category.name} for ${formatMonth(month)} from ${formatPaise(before)} to ${formatPaise(amount)}`,
    });
    return amount;
  });
}

/** Add to what is already assigned, rather than replacing it. */
export function addAssigned(
  db: DB, actor: Actor, month: MonthKey, categoryId: string, delta: Paise,
): Paise {
  return setAssigned(db, actor, month, categoryId, getAssigned(db, month, categoryId) + delta);
}

/**
 * F3.9 · Fill this month's still-empty categories with what they were assigned
 * last month — "budget like last month", then adjust.
 *
 * Only categories currently at zero are touched, so it never overwrites work
 * already done this month; each fill is an ordinary assignment (so it is
 * undoable and explains itself), and the count of categories filled is
 * returned. Recorded as one logical action by the caller's forward-recompute
 * batch (R7.g).
 */
export function copyAssignmentsFromMonth(
  db: DB, actor: Actor, month: MonthKey, fromMonth: MonthKey,
): { filled: number; total: Paise } {
  let filled = 0;
  let total = 0 as Paise;
  for (const category of listCategories(db)) {
    if (getAssigned(db, month, category.id) !== 0) continue; // don't clobber
    const prior = getAssigned(db, fromMonth, category.id);
    if (prior <= 0) continue;
    setAssigned(db, actor, month, category.id, prior);
    filled++;
    total = (total + prior) as Paise;
  }
  return { filled, total };
}

/**
 * R5 · Move money between categories.
 *
 * Two assignment deltas in one month, so RTA does not change (J4). Recorded as
 * a single "move" event rather than two assignment edits, which is what lets
 * J22 answer with "₹1,850 moved out to Eating Out on 14-08 by Priya".
 */
export function moveMoney(
  db: DB, actor: Actor,
  input: { month: MonthKey; fromCategoryId: string; toCategoryId: string; amount: Paise },
): void {
  const { month, fromCategoryId, toCategoryId, amount } = input;
  if (amount <= 0) throw new Error("Enter an amount greater than zero to move.");
  if (fromCategoryId === toCategoryId) throw new Error("Pick two different categories.");

  transact(db, () => {
    const from = getCategory(db, fromCategoryId);
    const to = getCategory(db, toCategoryId);
    if (!from || !to) throw new Error("That category does not exist.");

    const fromBefore = getAssigned(db, month, fromCategoryId);
    const toBefore = getAssigned(db, month, toCategoryId);

    writeAssignment(db, month, fromCategoryId, fromBefore - amount);
    writeAssignment(db, month, toCategoryId, toBefore + amount);

    appendEvent(db, actor, {
      entity: "assignment",
      entityId: `${month}:${toCategoryId}`,
      action: "move",
      before: { from: fromBefore, to: toBefore },
      after: { from: fromBefore - amount, to: toBefore + amount },
      summary: `Moved ${formatPaise(amount)} from ${from.name} to ${to.name}`,
    });
    // Logged against both categories so either one's history tells the story.
    appendEvent(db, actor, {
      entity: "assignment",
      entityId: `${month}:${fromCategoryId}`,
      action: "move-out",
      before: { amount: fromBefore },
      after: { amount: fromBefore - amount },
      summary: `Moved ${formatPaise(amount)} out to ${to.name}`,
    });
  });
}

// ---------------------------------------------------------------------------
// R11 · Hold income for next month
// ---------------------------------------------------------------------------

export function getHeld(db: DB, month: MonthKey): Paise {
  return (
    queryOne<{ amount: number }>(db, `SELECT amount FROM held_for_next_month WHERE month = ?`, month)
      ?.amount ?? 0
  );
}

export function setHeld(db: DB, actor: Actor, month: MonthKey, amount: Paise): void {
  if (amount < 0) throw new Error("You cannot hold a negative amount.");
  transact(db, () => {
    const before = getHeld(db, month);
    if (before === amount) return;

    if (amount === 0) {
      execute(db, `DELETE FROM held_for_next_month WHERE month = ?`, month);
    } else {
      execute(
        db,
        `INSERT INTO held_for_next_month (month, amount, updated_at) VALUES (?,?,?)
           ON CONFLICT(month) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`,
        month, amount, nowIST(),
      );
    }

    appendEvent(db, actor, {
      entity: "held", entityId: month, action: "set",
      before: { amount: before }, after: { amount },
      summary:
        amount === 0
          ? `Released the money held for next month`
          : `Held ${formatPaise(amount)} for next month`,
    });
  });
}

// ---------------------------------------------------------------------------
// Undo handlers
// ---------------------------------------------------------------------------

registerUndoHandler("assignment", (db, event) => {
  const [month, categoryId] = (event.entityId ?? "").split(":") as [MonthKey, string];

  if (event.action === "move") {
    const before = event.before as { from: Paise; to: Paise };
    const after = event.after as { from: Paise; to: Paise };
    // Recover the other side from the delta, since the id names only one.
    const moved = after.to - before.to;
    writeAssignment(db, month, categoryId, before.to);
    const other = queryOne<{ category_id: string }>(
      db,
      `SELECT category_id FROM assignments WHERE month = ? AND category_id != ? AND amount = ?`,
      month, categoryId, after.from,
    );
    if (other) writeAssignment(db, month, other.category_id, before.from);
    return `Reversed the move of ${formatPaise(moved)}`;
  }

  const before = (event.before as { amount: Paise } | undefined)?.amount ?? 0;
  writeAssignment(db, month, categoryId, before);
  return `Set the assignment back to ${formatPaise(before)}`;
});

registerUndoHandler("held", (db, event) => {
  const before = (event.before as { amount: Paise } | undefined)?.amount ?? 0;
  const month = event.entityId as MonthKey;
  if (before === 0) execute(db, `DELETE FROM held_for_next_month WHERE month = ?`, month);
  else
    execute(
      db,
      `INSERT INTO held_for_next_month (month, amount, updated_at) VALUES (?,?,?)
         ON CONFLICT(month) DO UPDATE SET amount = excluded.amount`,
      month, before, nowIST(),
    );
  return `Set the held amount back to ${formatPaise(before)}`;
});

registerUndoHandler("category", (db, event) => {
  const before = event.before as Category | undefined;
  if (!before) {
    execute(db, `DELETE FROM categories WHERE id = ?`, event.entityId!);
    return `Removed the category that was added`;
  }
  execute(
    db,
    `UPDATE categories SET name=?, group_id=?, sort=?, hidden_at=?, deleted_at=?, note=? WHERE id=?`,
    before.name, before.group_id, before.sort, before.hidden_at, before.deleted_at, before.note,
    event.entityId!,
  );
  return `Restored "${before.name}"`;
});

interface TargetRow { category_id: string; type: string; amount: number | null; target_date: string | null; created_at: string; updated_at: string }
registerUndoHandler("target", (db, event) => {
  const before = event.before as TargetRow | undefined;
  if (!before) {
    execute(db, `DELETE FROM targets WHERE category_id = ?`, event.entityId!);
    return `Removed the target that was set`;
  }
  execute(
    db,
    `INSERT INTO targets (category_id,type,amount,target_date,created_at,updated_at)
     VALUES (?,?,?,?,?,?)
       ON CONFLICT(category_id) DO UPDATE SET type=excluded.type, amount=excluded.amount,
         target_date=excluded.target_date, updated_at=excluded.updated_at`,
    before.category_id, before.type, before.amount, before.target_date, before.created_at, before.updated_at,
  );
  return `Restored the previous target`;
});
