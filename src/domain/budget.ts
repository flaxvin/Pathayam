/**
 * F3 · Category groups, categories, and the budgeting acts themselves:
 * assigning (R7), moving money (R5) and holding income (R11).
 */

import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, registerUndoHandler, type Actor } from "../core/events.ts";
import { Missing, Refusal } from "../core/refusal.ts";
import { nowIST, formatMonth, type MonthKey, type IsoDate } from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import { householdBudgetId, budgetsFor } from "./budgets.ts";
import { dependantsOf } from "./dependants.ts";

export interface CategoryGroup {
  id: string;
  name: string;
  kind: "normal" | "credit-payments" | "loan-payments" | "internal";
  sort: number;
  hidden_at: string | null;
  /** 15 · Which budget this group and its envelopes belong to. */
  budget_id: string | null;
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
  /** 15 · Which budget this envelope belongs to. */
  budget_id: string | null;
  /**
   * 15 §3 · Set when this envelope's purpose is another budget: what it holds is
   * money committed there. The receiving budget reads the balance as a claim.
   */
  commits_to_budget_id: string | null;
}

export function createGroup(
  db: DB, actor: Actor, name: string,
  kind: "normal" | "internal" = "normal",
  /**
   * 15 · Which budget the group — and so every envelope in it — belongs to.
   * Defaults to the household's, so a household that never opens a personal
   * budget behaves exactly as it did.
   */
  budgetId?: string,
): CategoryGroup {
  return transact(db, () => {
    const id = newId();
    const sort =
      queryOne<{ n: number }>(db, `SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM category_groups`)?.n ?? 1;
    execute(
      db,
      `INSERT INTO category_groups (id,name,kind,sort,created_at,budget_id)
         VALUES (?,?,?,?,?,?)`,
      id, name, kind, sort, nowIST(), budgetId ?? householdBudgetId(db),
    );
    const group = queryOne<CategoryGroup>(db, `SELECT * FROM category_groups WHERE id = ?`, id)!;
    appendEvent(db, actor, {
      entity: "category-group", entityId: id, action: "create", after: group,
      summary: `Added the group "${name}"`,
    });
    return group;
  });
}

export function renameGroup(db: DB, actor: Actor, id: string, name: string): CategoryGroup {
  return transact(db, () => {
    const before = queryOne<CategoryGroup>(db, `SELECT * FROM category_groups WHERE id = ?`, id);
    if (!before) throw new Missing("That group does not exist.");
    execute(db, `UPDATE category_groups SET name = ? WHERE id = ?`, name, id);
    const after = queryOne<CategoryGroup>(db, `SELECT * FROM category_groups WHERE id = ?`, id)!;
    appendEvent(db, actor, {
      entity: "category-group", entityId: id, action: "rename", before, after,
      summary: `Renamed the group "${before.name}" to "${name}"`,
    });
    return after;
  });
}

/**
 * Delete a category group, which must be empty.
 *
 * Empty because the alternative is worse in both directions: deleting the
 * envelopes with it would destroy balances and history at one click, and
 * orphaning them would leave money in envelopes no screen renders. Emptying it
 * first is one drag per envelope and is a decision about each of them.
 *
 * App-managed groups — a card's payment envelopes, a loan's, a goal's — are not
 * the household's to delete: the app puts them back the moment the thing they
 * belong to still exists.
 */
export function deleteGroup(db: DB, actor: Actor, id: string): void {
  transact(db, () => {
    const before = queryOne<CategoryGroup>(db, `SELECT * FROM category_groups WHERE id = ?`, id);
    if (!before) throw new Refusal("That group does not exist.");
    if (before.kind !== "normal") {
      throw new Refusal(
        `"${before.name}" is kept by the app — it holds the envelopes for cards, ` +
        `loans or goals — so it cannot be deleted by hand. It goes when the last ` +
        `of those does.`,
      );
    }

    const held = queryAll<{ name: string }>(
      db, `SELECT name FROM categories WHERE group_id = ? AND deleted_at IS NULL`, id,
    );
    if (held.length > 0) {
      throw new Refusal(
        `"${before.name}" still holds ${held.length === 1 ? "an envelope" : `${held.length} envelopes`} ` +
        `(${held.slice(0, 3).map((c) => c.name).join(", ")}${held.length > 3 ? "…" : ""}). ` +
        `Move or delete ${held.length === 1 ? "it" : "them"} first — deleting a group ` +
        `should never be a way to lose money you had put aside.`,
      );
    }

    /*
     * The envelopes that were deleted are still here.
     *
     * `deleteCategory` soft-deletes — the row stays so that transactions filed
     * against it keep meaning something — and the row still points at this
     * group. The check above only counts live envelopes, so a group whose last
     * envelope had been deleted looked empty, and the DELETE below hit a
     * foreign key and reached the household as "Something went wrong". That is
     * the most ordinary sequence there is: delete the envelope, then delete the
     * group it was the only thing in. It meant such a group could never be
     * deleted at all.
     *
     * A tombstone nothing refers to any more is just a tombstone, so it goes
     * with the group. One that still has transactions behind it is history, and
     * history is the thing this app does not throw away — so that is refused,
     * by name, with something the household can actually do about it.
     */
    const tombstones = queryAll<{ id: string; name: string }>(
      db, `SELECT id, name FROM categories WHERE group_id = ? AND deleted_at IS NOT NULL`, id,
    );
    const stillUsed = tombstones.filter((c) =>
      (queryOne<{ n: number }>(
        db,
        `SELECT (SELECT COUNT(*) FROM transactions WHERE category_id = ?)
              + (SELECT COUNT(*) FROM transaction_splits WHERE category_id = ?) AS n`,
        c.id, c.id,
      )?.n ?? 0) > 0,
    );
    if (stillUsed.length > 0) {
      throw new Refusal(
        `"${before.name}" holds ${stillUsed.length === 1 ? "a deleted envelope" : "deleted envelopes"} ` +
        `(${stillUsed.slice(0, 3).map((c) => c.name).join(", ")}${stillUsed.length > 3 ? "…" : ""}) ` +
        `that spending is still filed against. Re-file that spending somewhere else ` +
        `first — the group is the last thing saying where it used to go.`,
      );
    }
    for (const c of tombstones) {
      execute(db, `DELETE FROM categories WHERE id = ?`, c.id);
    }

    execute(db, `DELETE FROM category_groups WHERE id = ?`, id);
    appendEvent(db, actor, {
      entity: "category-group", entityId: id, action: "delete", before,
      summary: `Deleted the empty group "${before.name}"`,
    });
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
      `INSERT INTO categories (id,group_id,name,sort,note,created_at,budget_id)
         VALUES (?,?,?,?,?,?,?)`,
      id, input.groupId, input.name, sort, input.note ?? null, nowIST(),
      // 15 · A new envelope joins the budget its group is in, which is the
      // household's unless somebody moved the group.
      queryOne<{ budget_id: string | null }>(
        db, `SELECT budget_id FROM category_groups WHERE id = ?`, input.groupId,
      )?.budget_id ?? householdBudgetId(db),
    );
    const category = queryOne<Category>(db, `SELECT * FROM categories WHERE id = ?`, id)!;
    appendEvent(db, actor, {
      entity: "category", entityId: id, action: "create", after: category,
      summary: `Added the category "${input.name}"`,
    });
    return category;
  });
}

export function listCategories(
  db: DB,
  opts: {
    includeHidden?: boolean;
    budgetId?: string;
    /**
     * 15 · Who is asking. "Nobody sees anybody else's accounts, balances or
     * other envelopes" is what the household screen promises in those words,
     * and an envelope list that offers another member's private categories
     * breaks it — the review queue was offering Ravi's "Books and courses" to
     * everybody, and the payees screen was naming it as where a payee's money
     * usually goes.
     *
     * Visible means the household's budget and the viewer's own. Omitted means
     * every budget, which is what the engine, the month close and an export
     * want.
     */
    viewerMemberId?: string | null;
  } = {},
): Category[] {
  const visible = opts.viewerMemberId === undefined
    ? null
    : budgetsFor(db, opts.viewerMemberId ?? null).map((b) => b.id);

  return queryAll<Category>(
    db,
    `SELECT c.* FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE c.deleted_at IS NULL ${opts.includeHidden ? "" : "AND c.hidden_at IS NULL"}
        ${opts.budgetId ? "AND c.budget_id = ?" : ""}
        ${visible ? `AND (c.budget_id IS NULL OR c.budget_id IN (${visible.map(() => "?").join(",")}))` : ""}
      ORDER BY g.sort, c.sort, c.name`,
    ...(opts.budgetId ? [opts.budgetId] : []),
    ...(visible ?? []),
  );
}

/** The budgets a member may see at all: the household's, and their own. */
export function visibleBudgetIds(db: DB, viewerMemberId: string | null): Set<string> {
  return new Set(budgetsFor(db, viewerMemberId).map((b) => b.id));
}

export function listGroups(db: DB, budgetId?: string): CategoryGroup[] {
  return queryAll<CategoryGroup>(
    db,
    `SELECT * FROM category_groups
       ${budgetId ? "WHERE budget_id = ?" : ""}
      ORDER BY sort, name`,
    ...(budgetId ? [budgetId] : []),
  );
}

export function getCategory(db: DB, id: string): Category | null {
  return queryOne<Category>(db, `SELECT * FROM categories WHERE id = ?`, id);
}

/** Move a category into another group (used to un-manage a goal's envelope). */
export function moveCategoryToGroup(db: DB, actor: Actor, id: string, groupId: string): void {
  transact(db, () => {
    const before = getCategory(db, id);
    if (!before) throw new Missing("That category does not exist.");
    execute(db, `UPDATE categories SET group_id = ? WHERE id = ?`, groupId, id);
    appendEvent(db, actor, {
      entity: "category", entityId: id, action: "move",
      before, after: getCategory(db, id),
      summary: `Moved "${before.name}" to another group`,
    });
  });
}

/**
 * F3.6 · Move a category one place up or down within its group. Renumbers the
 * group to a clean sequence and swaps the two positions, so the order is always
 * well-defined and a repeated nudge keeps working. Undoes as one step.
 */
export function reorderCategory(
  db: DB, actor: Actor, id: string, direction: "up" | "down",
): void {
  transact(db, () => {
    const cat = getCategory(db, id);
    if (!cat) throw new Missing("That category does not exist.");
    const sibs = queryAll<{ id: string }>(
      db, `SELECT id FROM categories WHERE group_id = ? AND deleted_at IS NULL ORDER BY sort, name`,
      cat.group_id,
    ).map((r) => r.id);
    const i = sibs.indexOf(id);
    const j = direction === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= sibs.length) return; // at the edge — nothing to do
    const a = sibs[i]!, b = sibs[j]!;
    sibs.forEach((cid, k) => execute(db, `UPDATE categories SET sort = ? WHERE id = ?`, k, cid));
    execute(db, `UPDATE categories SET sort = ? WHERE id = ?`, j, a);
    execute(db, `UPDATE categories SET sort = ? WHERE id = ?`, i, b);
    appendEvent(db, actor, {
      entity: "category-order", entityId: id, action: "reorder",
      before: { a, aSort: i, b, bSort: j },
      summary: `Moved "${cat.name}" ${direction}`,
    });
  });
}

/** F3.6 · Move a category group one place up or down. */
export function reorderGroup(
  db: DB, actor: Actor, id: string, direction: "up" | "down",
): void {
  transact(db, () => {
    /*
     * 15 · Renumber within the group's own budget. Renumbering across all of
     * them would let one budget's groups take sort values that interleave with
     * another's, and a nudge in one grid would shuffle the other.
     */
    const budget = queryOne<{ budget_id: string | null }>(
      db, `SELECT budget_id FROM category_groups WHERE id = ?`, id,
    )?.budget_id ?? householdBudgetId(db);
    const groups = queryAll<{ id: string; name: string }>(
      db,
      `SELECT id, name FROM category_groups WHERE budget_id = ? ORDER BY sort, name`,
      budget,
    );
    const i = groups.findIndex((g) => g.id === id);
    const j = direction === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= groups.length) return;
    groups.forEach((g, k) => execute(db, `UPDATE category_groups SET sort = ? WHERE id = ?`, k, g.id));
    execute(db, `UPDATE category_groups SET sort = ? WHERE id = ?`, j, groups[i]!.id);
    execute(db, `UPDATE category_groups SET sort = ? WHERE id = ?`, i, groups[j]!.id);
    appendEvent(db, actor, {
      entity: "group-order", entityId: id, action: "reorder",
      before: { a: groups[i]!.id, aSort: i, b: groups[j]!.id, bSort: j },
      summary: `Moved the group "${groups[i]!.name}" ${direction}`,
    });
  });
}

export function renameCategory(db: DB, actor: Actor, id: string, name: string): Category {
  return transact(db, () => {
    const before = getCategory(db, id);
    if (!before) throw new Missing("That category does not exist.");
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
    if (!before) throw new Missing("That category does not exist.");
    if (before.payment_account_id && hidden) {
      throw new Refusal("A card's payment category cannot be hidden while the account is open.");
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
 * D2 · Where a deleted envelope's history may go.
 *
 * The remap target was not checked at all. ₹1,000 of spending remapped onto a
 * card's payment envelope disappeared from the budget — that envelope's
 * activity is derived from the card (R6), so spending filed to it is read by
 * nothing — and the identity was out by −₹1,000 from 2025-02. A commitment
 * envelope is the same (its balance is the claim between two budgets), and a
 * deleted envelope, another budget's, or the envelope itself are no better.
 */
function refuseHistoryTarget(db: DB, from: Category, targetId: string): void {
  const target = getCategory(db, targetId);
  if (!target || target.deleted_at || targetId === from.id) {
    throw new Refusal("Pick another envelope, still in use, to move the history to.");
  }
  if (target.payment_account_id) {
    throw new Refusal(
      `"${target.name}" is a card's payment envelope — it fills itself from spending on ` +
      `that card, so history moved into it would be counted nowhere. Pick another envelope.`,
    );
  }
  if (target.commits_to_budget_id) {
    throw new Refusal(
      `"${target.name}" holds what one budget has set aside for another, so spending ` +
      `is not filed to it. Pick another envelope.`,
    );
  }
  const budgetOf = (groupId: string) =>
    queryOne<{ budget_id: string | null }>(
      db, `SELECT budget_id FROM category_groups WHERE id = ?`, groupId,
    )?.budget_id ?? null;
  if (budgetOf(from.group_id) !== budgetOf(target.group_id)) {
    throw new Refusal(
      "That envelope belongs to a different budget. Move the history to one in the same budget.",
    );
  }
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
    if (!before) throw new Missing("That category does not exist.");
    if (before.payment_account_id) {
      throw new Refusal("A card's payment category cannot be deleted while the account exists (R6).");
    }
    if (opts.currentBalance !== 0) {
      throw new Refusal(
        `"${before.name}" still holds ${formatPaise(opts.currentBalance)}. Move it somewhere else first.`,
      );
    }

    /*
     * D1 · "Holds nothing" is not "has no history".
     *
     * Deleting purges the envelope's assignments, and the engine stops reading a
     * deleted envelope — but spending filed to it stays filed to it. ₹1,000
     * assigned and ₹1,000 spent left a balance of ₹0, so the delete went through;
     * Ready to Assign then got the ₹1,000 back (the assignment was gone) while
     * the bank still showed it spent, and the identity was out by −₹1,000 in
     * every month from then on. With history the spending has to go somewhere:
     * a remap names where, and Merge does the same with the money and target
     * too. Trashed rows count — restoring one would file it to nothing.
     */
    if (!opts.remapTo) {
      const history = queryOne<{ n: number }>(
        db,
        `SELECT (SELECT COUNT(*) FROM transactions WHERE category_id = ?)
              + (SELECT COUNT(*) FROM transaction_splits WHERE category_id = ?) AS n`,
        id, id,
      )?.n ?? 0;
      if (history > 0) {
        throw new Refusal(
          `"${before.name}" has spending filed to it, so deleting it would hand back ` +
          `every rupee ever assigned to it while the spending stayed. Merge it into ` +
          `another envelope instead — its history goes with it.`,
        );
      }
    }

    if (opts.remapTo) {
      refuseHistoryTarget(db, before, opts.remapTo);
      execute(db, `UPDATE transactions SET category_id = ? WHERE category_id = ?`, opts.remapTo, id);
      execute(db, `UPDATE transaction_splits SET category_id = ? WHERE category_id = ?`, opts.remapTo, id);
    }
    execute(db, `DELETE FROM assignments WHERE category_id = ?`, id);
    execute(db, `DELETE FROM targets WHERE category_id = ?`, id);
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
    if (!category) throw new Missing("That category does not exist.");
    if (input.amount <= 0) throw new Refusal("A target needs an amount above zero.");
    if (input.type === "by-date" && !input.targetDate) {
      throw new Refusal("A by-date target needs a date.");
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

/**
 * Merge one category into another: everything the loser holds, did and was
 * promised becomes the winner's, and the loser goes away.
 *
 * This is not `deleteCategory` with a remap. Delete insists the balance is
 * already zero and only moves transactions; a merge is what you reach for when
 * two envelopes turned out to be the same envelope, and the balance is exactly
 * the thing that has to survive.
 *
 * ## Why the assignments are summed rather than updated
 *
 * `assignments` is keyed `(month, category_id)`. If both categories were
 * assigned to in the same month — which is the normal case for two categories
 * anyone would want to merge — a plain `UPDATE ... SET category_id` either
 * violates that key or, with the wrong conflict clause, silently keeps one row
 * and drops the other. Dropping it would take money out of the ledger without
 * taking it out of any account, and the identity
 *
 *   accounts = categories + ready-to-assign + held
 *
 * would break by exactly the amount discarded. So the two rows are added.
 *
 * ## What it refuses
 *
 * A card's payment category, on either side. Its activity is derived from the
 * card account rather than stored (R6), so a merged one would either lose that
 * link or give the winner a second one.
 *
 * A merge across budgets. Categories belong to groups, groups belong to a
 * budget, and two budgets are two people's money — moving a balance between
 * them is not a rename, it is a transfer, and it would move a private
 * envelope's contents into the shared budget where everybody can see it.
 */
export function mergeCategories(db: DB, actor: Actor, loserId: string, winnerId: string): void {
  if (loserId === winnerId) throw new Refusal("Pick two different categories.");

  transact(db, () => {
    const loser = getCategory(db, loserId);
    const winner = getCategory(db, winnerId);
    if (!loser || loser.deleted_at) throw new Refusal("That category does not exist.");
    if (!winner || winner.deleted_at) throw new Refusal("That category does not exist.");

    if (loser.payment_account_id || winner.payment_account_id) {
      throw new Refusal(
        "A card's payment category cannot be merged. Its balance is what funds that card, and the app derives it from the account (R6).",
      );
    }
    // D2 / D8 · Merging into a commitment envelope files the loser's spending
    // to it, which the claim between the budgets cannot absorb.
    if (winner.commits_to_budget_id) {
      throw new Refusal(
        `"${winner.name}" holds what one budget has set aside for another, so nothing ` +
        `can be merged into it. Pick another envelope.`,
      );
    }

    const budgetOf = (groupId: string) =>
      queryOne<{ budget_id: string | null }>(
        db, `SELECT budget_id FROM category_groups WHERE id = ?`, groupId,
      )?.budget_id ?? null;
    if (budgetOf(loser.group_id) !== budgetOf(winner.group_id)) {
      throw new Refusal(
        "Those two categories belong to different budgets. Merging them would move one person's money into another's.",
      );
    }

    /*
     * Assignments: added, month by month. ON CONFLICT is what keeps the
     * identity — see above.
     */
    execute(
      db,
      `INSERT INTO assignments (month, category_id, amount, updated_at)
       SELECT month, ?, amount, ? FROM assignments WHERE category_id = ?
         ON CONFLICT(month, category_id)
         DO UPDATE SET amount = assignments.amount + excluded.amount,
                       updated_at = excluded.updated_at`,
      winnerId, nowIST(), loserId,
    );
    execute(db, `DELETE FROM assignments WHERE category_id = ?`, loserId);

    // History, and anything that merely points at a category.
    execute(db, `UPDATE transactions SET category_id = ? WHERE category_id = ?`, winnerId, loserId);
    execute(db, `UPDATE transaction_splits SET category_id = ? WHERE category_id = ?`, winnerId, loserId);
    execute(db, `UPDATE staged_transactions SET category_id = ? WHERE category_id = ?`, winnerId, loserId);
    execute(db, `UPDATE schedules SET category_id = ? WHERE category_id = ?`, winnerId, loserId);
    execute(db, `UPDATE loans SET payment_category_id = ? WHERE payment_category_id = ?`, winnerId, loserId);
    execute(db, `UPDATE even_calls SET envelope_id = ? WHERE envelope_id = ?`, winnerId, loserId);
    execute(db, `UPDATE even_calls SET giving_category_id = ? WHERE giving_category_id = ?`, winnerId, loserId);

    // A goal can name both; (goal_id, category_id) is a key, so insert what is
    // missing and drop the rest rather than colliding.
    execute(
      db,
      `INSERT OR IGNORE INTO goal_categories (goal_id, category_id)
       SELECT goal_id, ? FROM goal_categories WHERE category_id = ?`,
      winnerId, loserId,
    );
    execute(db, `DELETE FROM goal_categories WHERE category_id = ?`, loserId);

    /*
     * Targets: the winner's stands. Two targets cannot both apply, and the
     * category being kept is the one whose intent was meant to survive — so
     * the loser's is taken only when the winner has none.
     */
    const winnerTarget = queryOne(db, `SELECT category_id FROM targets WHERE category_id = ?`, winnerId);
    if (!winnerTarget) {
      execute(db, `UPDATE targets SET category_id = ? WHERE category_id = ?`, winnerId, loserId);
    }
    execute(db, `DELETE FROM targets WHERE category_id = ?`, loserId);

    /*
     * The rollup cache is keyed by category and is now wrong for both of them.
     * It is derived from the ledger, so throwing the whole thing away costs one
     * rebuild — which is what the migration that introduced it does too.
     */
    execute(db, `DELETE FROM month_rollups`);
    execute(db, `DELETE FROM month_rollup_state`);

    execute(db, `UPDATE categories SET deleted_at = ? WHERE id = ?`, nowIST(), loserId);

    appendEvent(db, actor, {
      entity: "category", entityId: loserId, action: "merge", before: loser, after: winner,
      summary: `Merged "${loser.name}" into "${winner.name}"`,
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
    if (!category) throw new Missing("That category does not exist.");

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
  if (amount <= 0) throw new Refusal("Enter an amount greater than zero to move.");
  if (fromCategoryId === toCategoryId) throw new Refusal("Pick two different categories.");

  transact(db, () => {
    const from = getCategory(db, fromCategoryId);
    const to = getCategory(db, toCategoryId);
    if (!from || !to) throw new Missing("That category does not exist.");

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

/*
 * D4 · Held money belongs to one budget.
 *
 * Since budgets were scoped the engine reads `held_for_next_month` for one
 * budget at a time (`budget_id = ?`), but this wrote every row with budget_id
 * NULL: "Held ₹500 for next month" was reported, the row was written, and the
 * budget page's Ready to Assign did not move — only the combined view saw it.
 * And the table was keyed by month alone, so two budgets could never each hold
 * money in the same month.
 *
 * The rows now carry the budget. A row left NULL by the old code reads as the
 * household's, which is what the column's own backfill decided. Until the table
 * is rebuilt keyed by (month, budget) — a migration the release adds — a second
 * budget holding money in a month another already holds in is refused rather
 * than failing on the old primary key.
 */
function heldKeyedByBudget(db: DB): boolean {
  return (queryOne<{ n: number }>(
    db, `SELECT COUNT(*) AS n FROM pragma_table_info('held_for_next_month') WHERE pk > 0`,
  )?.n ?? 1) > 1;
}

function writeHeld(db: DB, month: MonthKey, budgetId: string, amount: Paise): void {
  const household = householdBudgetId(db);
  execute(
    db, `DELETE FROM held_for_next_month WHERE month = ? AND COALESCE(budget_id, ?) = ?`,
    month, household, budgetId,
  );
  if (amount === 0) return;
  if (!heldKeyedByBudget(db) &&
      queryOne(db, `SELECT 1 FROM held_for_next_month WHERE month = ?`, month)) {
    throw new Refusal(
      `Another budget is already holding money back in ${formatMonth(month)}, and ` +
      `this database can only record one per month until it is upgraded.`,
    );
  }
  execute(
    db,
    `INSERT INTO held_for_next_month (month, budget_id, amount, updated_at) VALUES (?,?,?,?)`,
    month, budgetId, amount, nowIST(),
  );
}

export function getHeld(db: DB, month: MonthKey, budgetId = householdBudgetId(db)): Paise {
  return (
    queryOne<{ amount: number }>(
      db,
      `SELECT amount FROM held_for_next_month WHERE month = ? AND COALESCE(budget_id, ?) = ?`,
      month, householdBudgetId(db), budgetId,
    )?.amount ?? 0
  );
}

export function setHeld(
  db: DB, actor: Actor, month: MonthKey, amount: Paise, budgetId = householdBudgetId(db),
): void {
  if (amount < 0) throw new Refusal("You cannot hold a negative amount.");
  transact(db, () => {
    const before = getHeld(db, month, budgetId);
    if (before === amount) return;

    writeHeld(db, month, budgetId, amount);

    appendEvent(db, actor, {
      entity: "held", entityId: month, action: "set",
      before: { amount: before, budgetId }, after: { amount, budgetId },
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
  const recorded = event.before as { amount: Paise; budgetId?: string } | undefined;
  const before = recorded?.amount ?? 0;
  // Events from before D4 name no budget; theirs was the household's.
  writeHeld(db, event.entityId as MonthKey, recorded?.budgetId ?? householdBudgetId(db), before);
  return `Set the held amount back to ${formatPaise(before)}`;
});

/**
 * D12 · What still leans on a commitment envelope, beyond rows that name it.
 *
 * The envelope carries the claim between two budgets, but the filings that
 * raise the claim name the *other* budget's category, not the envelope — so no
 * foreign key stops it being deleted. Priya's ₹500.03 filed to a household
 * envelope opened hers automatically; undoing that "opened" event deleted it,
 * claimLinks found no link any more, and the household was +₹500.03 and Priya
 * −₹500.03 in every month after. Anything that crosses the two budgets — a
 * filing, a split line, a card payment — needs the envelope to exist.
 */
function commitmentCrossings(db: DB, id: string): string[] {
  const envelope = queryOne<{ budget_id: string | null; commits_to_budget_id: string | null }>(
    db, `SELECT budget_id, commits_to_budget_id FROM categories WHERE id = ?`, id,
  );
  if (!envelope?.budget_id || !envelope.commits_to_budget_id) return [];
  const pair = [envelope.budget_id, envelope.commits_to_budget_id, envelope.commits_to_budget_id, envelope.budget_id];
  const crosses = `((a.budget_id = ? AND c.budget_id = ?) OR (a.budget_id = ? AND c.budget_id = ?))`;
  const found: string[] = [];
  const count = (sql: string) => queryOne<{ n: number }>(db, sql, ...pair)?.n ?? 0;
  if (count(
    `SELECT COUNT(*) AS n FROM transactions t
       JOIN accounts a ON a.id = t.account_id JOIN categories c ON c.id = t.category_id
      WHERE ${crosses}`,
  ) + count(
    `SELECT COUNT(*) AS n FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
       JOIN accounts a ON a.id = t.account_id JOIN categories c ON c.id = s.category_id
      WHERE ${crosses}`,
  ) > 0) found.push("spending filed across the two budgets");
  // `c` is the card here: a payment onto the other budget's card.
  if (count(
    `SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id
       JOIN transactions o ON o.transfer_pair_id = t.transfer_pair_id AND o.id <> t.id
       JOIN accounts c ON c.id = o.account_id AND c.kind = 'credit'
      WHERE ${crosses}`,
  ) > 0) found.push("card payments between the two budgets");
  return found;
}

/**
 * D10 · Everything but its own target and empty assignment rows that still
 * points at a category. A ₹0 assignment is what the grid writes when a figure
 * is cleared; it carries no money and goes with the envelope.
 */
function categoryDependants(db: DB, id: string): string[] {
  const found = dependantsOf(db, "categories", id, {
    own: ["targets.category_id", "assignments.category_id"],
    words: {
      transactions: "transactions", transaction_splits: "split lines",
      schedules: "schedules", schedule_splits: "schedule lines",
      staged_transactions: "imported rows waiting for review",
      even_calls: "a balance called even", loans: "a loan",
    },
  });
  const assigned = queryOne<{ n: number }>(
    db, `SELECT COUNT(*) AS n FROM assignments WHERE category_id = ? AND amount <> 0`, id,
  )?.n ?? 0;
  if (assigned > 0) found.unshift("money assigned to it");
  return found;
}

function removeCategoryRow(db: DB, id: string): void {
  execute(db, `DELETE FROM assignments WHERE category_id = ?`, id);
  execute(db, `DELETE FROM targets WHERE category_id = ?`, id);
  execute(db, `DELETE FROM categories WHERE id = ?`, id);
}

registerUndoHandler("category", (db, event) => {
  const before = event.before as Category | undefined;
  if (!before) {
    const crossings = commitmentCrossings(db, event.entityId!);
    if (crossings.length > 0) {
      throw new Refusal(
        `This envelope carries what the two budgets owe each other, and there is ` +
        `${crossings.join(" and ")} that needs it. Removing it would lose track of ` +
        `that — undo those first, or leave it in place.`,
      );
    }
    const dependants = categoryDependants(db, event.entityId!);
    if (dependants.length > 0) {
      throw new Refusal(
        `This envelope already has ${dependants.join(", ")}, so removing it would ` +
        `leave those pointing at nothing. Delete or merge it instead — its history stays.`,
      );
    }
    removeCategoryRow(db, event.entityId!);
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

// B61 · Groups logged create and rename events from the start but had no undo
// handler, so every one of them was refused — an event that looks undoable in
// the log and is not is worse than no event at all.
registerUndoHandler("category-group", (db, event) => {
  const before = event.before as CategoryGroup | undefined;
  if (!before) {
    /*
     * D10 · The group has to be empty. A live envelope in it is refused by
     * name; a deleted one with nothing behind it is a tombstone and goes with
     * the group (deleteGroup's rule), and one with history is refused.
     */
    const inside = queryAll<{ id: string; name: string; deleted_at: string | null }>(
      db, `SELECT id, name, deleted_at FROM categories WHERE group_id = ?`, event.entityId!,
    );
    const live = inside.filter((c) => !c.deleted_at);
    const used = inside.filter((c) => c.deleted_at && categoryDependants(db, c.id).length > 0);
    if (live.length > 0 || used.length > 0) {
      const names = [...live, ...used].slice(0, 3).map((c) => c.name).join(", ");
      throw new Refusal(
        `This group already holds envelopes (${names}${live.length + used.length > 3 ? "…" : ""}), ` +
        `so removing it would leave them in no group. Move or delete them first, ` +
        `then delete the group.`,
      );
    }
    for (const c of inside) removeCategoryRow(db, c.id);
    execute(db, `DELETE FROM category_groups WHERE id = ?`, event.entityId!);
    return `Removed the group that was added`;
  }
  // A deleted group has to come back, not be updated in place.
  if (event.action === "delete") {
    execute(
      db,
      `INSERT INTO category_groups (id,name,kind,sort,created_at,budget_id)
       VALUES (?,?,?,?,?,?)`,
      event.entityId!, before.name, before.kind, before.sort,
      nowIST(), before.budget_id ?? null,
    );
    return `Put the group "${before.name}" back`;
  }
  execute(
    db,
    `UPDATE category_groups SET name = ?, kind = ?, sort = ? WHERE id = ?`,
    before.name, before.kind, before.sort, event.entityId!,
  );
  return `Restored the group "${before.name}"`;
});

// F3.6 · A reorder swaps two `sort` values (after a clean renumber). Undo puts
// exactly those two back where they were; the renumber of the untouched rows is
// order-preserving, so nothing else moves.
interface SwapBefore { a: string; aSort: number; b: string; bSort: number }
registerUndoHandler("category-order", (db, event) => {
  const b = event.before as SwapBefore;
  execute(db, `UPDATE categories SET sort = ? WHERE id = ?`, b.aSort, b.a);
  execute(db, `UPDATE categories SET sort = ? WHERE id = ?`, b.bSort, b.b);
  return `Restored the order`;
});
registerUndoHandler("group-order", (db, event) => {
  const b = event.before as SwapBefore;
  execute(db, `UPDATE category_groups SET sort = ? WHERE id = ?`, b.aSort, b.a);
  execute(db, `UPDATE category_groups SET sort = ? WHERE id = ?`, b.bSort, b.b);
  return `Restored the order`;
});

/**
 * A starting shape for a new personal budget.
 *
 * `03` J1 is emphatic that the empty state is where budgeting apps lose people,
 * and a personal budget opened with no groups at all was exactly that: a bare
 * grid, and an "add a category" picker with nothing to add it to. Two groups and
 * four envelopes is enough to be usable on the first afternoon and few enough
 * that nobody feels lectured about how to spend their own money.
 *
 * Idempotent, and skipped entirely if the budget already has anything in it.
 */
export function startPersonalBudget(db: DB, actor: Actor, budgetId: string): void {
  const existing = queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM category_groups WHERE budget_id = ? AND kind = 'normal'`,
    budgetId,
  )?.n ?? 0;
  if (existing > 0) return;

  transact(db, () => {
    const mine = createGroup(db, actor, "Mine", "normal", budgetId);
    for (const name of ["Personal", "Eating out", "Subscriptions"]) {
      createCategory(db, actor, { groupId: mine.id, name });
    }
    const saving = createGroup(db, actor, "Putting away", "normal", budgetId);
    createCategory(db, actor, { groupId: saving.id, name: "Savings" });
  });
}
