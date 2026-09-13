/**
 * 15 §4A · The three ways a month where one of you put in more can end.
 *
 * | | What happens | What it means |
 * |---|---|---|
 * | **Put it down to me** | Covered from your own Ready to Assign | Your share this month was simply larger |
 * | **I'll pick it up** | The other member commits the amount | They have taken on the shortfall |
 * | **Call it even** | Nobody pays; the balance is closed by agreement | The only one that is actually letting something go |
 *
 * The first two need nothing here: putting it down to yourself is R4's ordinary
 * move out of Ready to Assign wearing a better label, and picking it up is an
 * ordinary assignment into a commitment envelope. Both go through `setAssigned`,
 * and this module only names them so the routes and the screens agree.
 *
 * The third is the one with machinery, and `15` §4A.4 is careful about why: the
 * money has to come from somewhere. Calling it even moves an obligation from
 * *they owe this* to *we spent this*, and the spending still has to be funded
 * like any other. So it is an **expense for the one giving it and income for the
 * one receiving it** — the rule `writeOffFamilyLoan` already encodes — and it
 * lands in a real envelope on the giving side, because an amount that vanished
 * would leave the card payment arriving against nothing.
 */

import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { appendEvent, registerUndoHandler } from "../core/events.ts";
import { nowIST, monthOf, todayIST, type MonthKey } from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import { getBudget, householdBudgetId } from "./budgets.ts";
import { createGroup, createCategory, listCategories, type Category } from "./budget.ts";
import { standingOf, outstanding } from "./standing.ts";
import { loadEngineInput } from "../engine/repository.ts";
import { computeBudget } from "../engine/engine.ts";

/** Where a called-even amount lands by default on the giving side (15 §4A.5). */
export const GIVEN_UP_CATEGORY = "Gifts and treats";

export interface EvenCall {
  id: string;
  month: MonthKey;
  envelope_id: string;
  giving_budget_id: string;
  giving_category_id: string;
  amount: Paise;
  note: string | null;
  created_at: string;
  created_by: string | null;
}

/**
 * The envelope a called-even amount is spent from, made on demand.
 *
 * An ordinary envelope in an ordinary group, because it is ordinary spending: the
 * household bought somebody a present. It can be renamed, retargeted and reported
 * on like anything else, and the household may choose a different one.
 */
export function ensureGivenUpCategory(db: DB, actor: Actor, budgetId: string): Category {
  const existing = listCategories(db, { includeHidden: true, budgetId })
    .find((c) => c.name === GIVEN_UP_CATEGORY);
  if (existing) return existing;

  const group =
    queryOne<{ id: string }>(
      db,
      `SELECT id FROM category_groups
        WHERE budget_id = ? AND kind = 'normal' AND name = 'Everyday'`,
      budgetId,
    ) ?? createGroup(db, actor, "Everyday", "normal", budgetId);

  return createCategory(db, actor, { groupId: group.id, name: GIVEN_UP_CATEGORY });
}

export interface CallItEvenInput {
  envelopeId: string;
  /** Partial amounts are ordinary: ₹2,000 of a ₹6,200 balance (15 §4A.5). */
  amount: Paise;
  /** Where it lands on the giving side. Defaults to Gifts and treats. */
  givingCategoryId?: string;
  month?: MonthKey;
  note?: string | null;
}

/**
 * Close part or all of a balance by agreement.
 *
 * It belongs to whoever is **ahead** — they are the one giving something up — and
 * for a balance with the household any member may act, with the log recording who
 * (`15` §4A.5).
 */
export function callItEven(db: DB, actor: Actor, input: CallItEvenInput): EvenCall {
  return transact(db, () => {
    const envelope = queryOne<{
      id: string; name: string; budget_id: string | null; commits_to_budget_id: string | null;
    }>(
      db,
      `SELECT id, name, budget_id, commits_to_budget_id FROM categories WHERE id = ?`,
      input.envelopeId,
    );
    if (!envelope?.commits_to_budget_id || !envelope.budget_id) {
      throw new Refusal("That is not a balance between two budgets, so there is nothing to call even.");
    }
    if (input.amount <= 0) {
      throw new Refusal("Say how much of it to let go.");
    }

    const month = input.month ?? monthOf(todayIST());
    const standing = currentStanding(db, envelope.id, month);

    if (standing.balance === 0) {
      throw new Refusal("You are square already — there is nothing outstanding between you.");
    }
    if (input.amount > outstanding(standing.balance)) {
      throw new Refusal(
        `Only ${formatPaise(outstanding(standing.balance))} is outstanding between you.`,
      );
    }

    /*
     * Who gives it up is decided by the arithmetic, not by who clicked.
     *
     * An overfunded envelope means its own budget has put money aside that the
     * other has had the use of, so the other budget is the one letting it go. An
     * underfunded one is the reverse: the envelope's budget paid for more than it
     * set aside, so it is the one giving something up.
     */
    const givingBudget =
      standingOf(standing.balance) === "overfunded"
        ? envelope.commits_to_budget_id
        : envelope.budget_id;

    const giving = getBudget(db, givingBudget);
    if (!giving) throw new Refusal("That budget no longer exists.");

    const givingCategoryId =
      input.givingCategoryId ?? ensureGivenUpCategory(db, actor, givingBudget).id;
    const givingCategory = queryOne<{ budget_id: string | null; name: string }>(
      db, `SELECT budget_id, name FROM categories WHERE id = ?`, givingCategoryId,
    );
    if (!givingCategory || givingCategory.budget_id !== givingBudget) {
      throw new Refusal(
        `That envelope is not in ${giving.name}'s budget, and the amount has to be ` +
        `spent from the budget that is letting it go.`,
      );
    }

    const id = newId();
    execute(
      db,
      `INSERT INTO even_calls
         (id,month,envelope_id,giving_budget_id,giving_category_id,amount,note,created_at,created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      id, month, envelope.id, givingBudget, givingCategoryId, input.amount,
      input.note ?? null, nowIST(), actor.memberId ?? null,
    );

    const call = queryOne<EvenCall>(db, `SELECT * FROM even_calls WHERE id = ?`, id)!;
    appendEvent(db, actor, {
      entity: "even-call", entityId: id, action: "create", after: call,
      summary:
        `Called ${formatPaise(input.amount)} even, spent from ${givingCategory.name} ` +
        `in ${giving.kind === "household" ? "the household" : giving.name}'s budget`,
    });
    return call;
  });
}

/** Every amount called even against this envelope, up to and including `month`. */
export function calledEvenTotal(db: DB, envelopeId: string, month: MonthKey): Paise {
  return (
    queryOne<{ total: number }>(
      db,
      `SELECT COALESCE(SUM(amount), 0) AS total FROM even_calls
        WHERE envelope_id = ? AND month <= ?`,
      envelopeId, month,
    )?.total ?? 0
  ) as Paise;
}

export function listEvenCalls(db: DB, envelopeId?: string): EvenCall[] {
  return queryAll<EvenCall>(
    db,
    `SELECT * FROM even_calls ${envelopeId ? "WHERE envelope_id = ?" : ""}
      ORDER BY month DESC, created_at DESC`,
    ...(envelopeId ? [envelopeId] : []),
  );
}

/**
 * Where a balance stands right now, computed the same way the household screen
 * computes it — by running the envelope's own budget rather than re-deriving.
 *
 * The engine reads `even_calls` and this reads the engine, which is a cycle in the
 * import graph and harmless in practice: neither half touches the other while a
 * module is still loading.
 */
function currentStanding(db: DB, envelopeId: string, month: MonthKey): { balance: Paise } {
  const envelope = queryOne<{ budget_id: string }>(
    db, `SELECT budget_id FROM categories WHERE id = ?`, envelopeId,
  )!;
  const state = computeBudget(
    loadEngineInput(db, { through: month, budgetId: envelope.budget_id }),
  );
  return { balance: (state.get(month)?.categories.get(envelopeId)?.balance ?? 0) as Paise };
}

registerUndoHandler("even-call", (db, event) => {
  execute(db, `DELETE FROM even_calls WHERE id = ?`, event.entityId!);
  const before = event.after as EvenCall | undefined;
  return before
    ? `Put ${formatPaise(before.amount)} back outstanding between you`
    : `Undid calling it even`;
});
