/**
 * 15 §3 · Committing money to the household.
 *
 * A member makes money available to the shared budget by **assigning it**, not
 * by moving it. Each personal budget holds one envelope whose purpose is the
 * household's budget; what sits in it is what that member has committed, and the
 * cash never leaves the account it was already in.
 *
 * The household sees the sum of those envelopes as a claim — *due from Ravi* —
 * on the left of its identity, alongside its own account balances:
 *
 *     Σ accounts + Σ due from other budgets
 *       = Σ categories + Ready to Assign + held + future − unfunded credit
 *
 * The claim is derived from the envelope, never stored beside it. That is the
 * same decision as a card's payment envelope (R6) and for the same reason: two
 * records of one fact drift, and nothing downstream can tell which is right.
 */

import type { DB } from "../db/db.ts";
import { queryAll, queryOne, execute, transact } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { appendEvent } from "../core/events.ts";
import type { Paise } from "../core/money.ts";
import type { MonthKey } from "../core/dates.ts";
import { Refusal } from "../core/refusal.ts";
import { createGroup, createCategory, listCategories, type Category } from "./budget.ts";
import { HOUSEHOLD_BUDGET_ID, householdBudgetId, getBudget, listBudgets } from "./budgets.ts";

/** The group a commitment envelope lives in. Internal, so it carries no manual controls. */
export const COMMITMENT_GROUP = "The household";

/** The envelope in `budgetId` that commits money to `toBudgetId`, if it exists. */
export function commitmentEnvelope(
  db: DB, budgetId: string, toBudgetId = HOUSEHOLD_BUDGET_ID,
): Category | null {
  return queryOne<Category>(
    db,
    `SELECT * FROM categories
      WHERE budget_id = ? AND commits_to_budget_id = ? AND deleted_at IS NULL`,
    budgetId, toBudgetId,
  );
}

/**
 * Idempotent. A personal budget gets its household envelope the first time it
 * is looked at, so there is never a screen saying "create this first".
 */
export function ensureCommitmentEnvelope(
  db: DB, actor: Actor, budgetId: string, toBudgetId = HOUSEHOLD_BUDGET_ID,
): Category {
  const existing = commitmentEnvelope(db, budgetId, toBudgetId);
  if (existing) return existing;

  const from = getBudget(db, budgetId);
  if (!from) throw new Refusal("That budget does not exist.");
  if (from.kind !== "personal") {
    throw new Refusal(
      "Only a personal budget commits money to the household. The household " +
      "budget already holds the shared money directly.",
    );
  }
  if (toBudgetId === budgetId) {
    throw new Refusal("A budget cannot commit money to itself.");
  }
  if (!getBudget(db, toBudgetId)) throw new Refusal("That budget does not exist.");

  return transact(db, () => {
    const group =
      queryOne<{ id: string }>(
        db,
        `SELECT id FROM category_groups
          WHERE budget_id = ? AND kind = 'internal' AND name = ?`,
        budgetId, COMMITMENT_GROUP,
      ) ?? createGroup(db, actor, COMMITMENT_GROUP, "internal", budgetId);

    const to = getBudget(db, toBudgetId);
    const category = createCategory(db, actor, {
      groupId: group.id,
      name: to?.kind === "household" ? "→ Household" : `→ ${to?.name ?? "another budget"}`,
    });
    execute(
      db, `UPDATE categories SET commits_to_budget_id = ? WHERE id = ?`, toBudgetId, category.id,
    );
    const after = queryOne<Category>(db, `SELECT * FROM categories WHERE id = ?`, category.id)!;
    appendEvent(db, actor, {
      entity: "category", entityId: after.id, action: "commitment-envelope",
      after,
      summary: `Opened ${from.name}'s envelope for the household`,
    });
    return after;
  });
}

/**
 * Every budget that could hold a commitment to `toBudgetId`, with its envelope.
 *
 * Used both to compute the claim and to say who has committed what, so the two
 * can never be answered from different sets.
 */
export function commitmentSources(
  db: DB, toBudgetId = HOUSEHOLD_BUDGET_ID,
): { budgetId: string; budgetName: string; memberId: string | null; categoryId: string }[] {
  return queryAll<{
    budget_id: string; name: string; member_id: string | null; id: string;
  }>(
    db,
    `SELECT c.id, c.budget_id, b.name, b.member_id
       FROM categories c
       JOIN budgets b ON b.id = c.budget_id
      WHERE c.commits_to_budget_id = ? AND c.deleted_at IS NULL
      ORDER BY b.name`,
    toBudgetId,
  ).map((r) => ({
    budgetId: r.budget_id, budgetName: r.name, memberId: r.member_id, categoryId: r.id,
  }));
}

/** Whether any commitment envelope exists at all — the cheap check before the dear one. */
export function anyCommitments(db: DB, toBudgetId = HOUSEHOLD_BUDGET_ID): boolean {
  return (
    queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM categories
        WHERE commits_to_budget_id = ? AND deleted_at IS NULL`,
      toBudgetId,
    )?.n ?? 0
  ) > 0;
}

/**
 * A commitment envelope is not an ordinary one, and two edits have to be refused
 * rather than allowed to half-work.
 */
export function guardCommitmentEnvelope(db: DB, categoryId: string, what: string): void {
  const row = queryOne<{ commits_to_budget_id: string | null }>(
    db, `SELECT commits_to_budget_id FROM categories WHERE id = ?`, categoryId,
  );
  if (row?.commits_to_budget_id) {
    throw new Refusal(
      `That envelope is what the household is counting on, so it cannot be ${what}. ` +
      `Move money out of it instead — the household sees the change either way.`,
    );
  }
}

/** The commitment envelopes a budget holds, for the grid to mark them. */
export function commitmentCategoryIds(db: DB, budgetId?: string): Set<string> {
  return new Set(
    listCategories(db, { includeHidden: true, budgetId })
      .filter((c) => c.commits_to_budget_id)
      .map((c) => c.id),
  );
}

/**
 * `dueFromOtherBudgets` per month: the balance of every envelope committing to
 * this budget, as of the end of each month.
 *
 * Deliberately takes the balances rather than reading assignments: an envelope's
 * balance is what the engine says it is, overspend and rollover included, and
 * re-deriving it here would be a second implementation of R3 and R4 that could
 * disagree with the first.
 */
export function claimByMonth(
  balancesByBudget: { categoryId: string; balances: Map<MonthKey, Paise> }[],
  months: MonthKey[],
): Record<MonthKey, Paise> {
  const out: Record<MonthKey, Paise> = {};
  for (const month of months) {
    let total = 0;
    for (const source of balancesByBudget) total += source.balances.get(month) ?? 0;
    out[month] = total as Paise;
  }
  return out;
}

/** Whether this budget can receive commitments at all. Only the household can, today. */
export function receivesCommitments(db: DB, budgetId: string): boolean {
  return budgetId === householdBudgetId(db) && listBudgets(db).some((b) => b.kind === "personal");
}

/**
 * 15 §3A.4 · The claim between two budgets, from either direction.
 *
 * One envelope serves a pair. Which way round it was created does not matter:
 * what it holds is *what its budget owes the other*, so reading it backwards is
 * the same figure with the sign flipped. Keeping one row rather than two is what
 * makes the claim impossible to double-count.
 */
export interface ClaimLink {
  categoryId: string;
  /** The budget the envelope lives in, and whose category total includes it. */
  budgetId: string;
  /** +1 when the envelope reads "budgetId owes the other", −1 read backwards. */
  sign: 1 | -1;
}

/**
 * Every pair of budgets with an envelope between them, keyed both ways round.
 *
 * Built once per load rather than queried per transaction: a month of card
 * charges is hundreds of rows and all of them ask the same question.
 */
export function claimLinks(db: DB): Map<string, ClaimLink> {
  const links = new Map<string, ClaimLink>();
  for (const row of queryAll<{ id: string; budget_id: string; commits_to_budget_id: string }>(
    db,
    `SELECT id, budget_id, commits_to_budget_id FROM categories
      WHERE commits_to_budget_id IS NOT NULL AND deleted_at IS NULL AND budget_id IS NOT NULL`,
  )) {
    const { id, budget_id: from, commits_to_budget_id: to } = row;
    links.set(`${from}→${to}`, { categoryId: id, budgetId: from, sign: 1 });
    links.set(`${to}→${from}`, { categoryId: id, budgetId: from, sign: -1 });
  }
  return links;
}

/**
 * The envelope that absorbs a transaction whose account is in `accountBudget`
 * and whose category is in `categoryBudget`, or null if the two budgets have no
 * arrangement between them.
 *
 * The rule, in one sentence: **A's money paying for B's envelope means B owes A
 * by that much.** Applied to the envelope, that is an activity of exactly the
 * transaction's amount when the envelope reads "A owes B", and its negation when
 * it reads the other way — which is the same movement described from the other
 * side of the table.
 */
export function claimFor(
  links: Map<string, ClaimLink>, accountBudget: string, categoryBudget: string,
): ClaimLink | null {
  if (accountBudget === categoryBudget) return null;
  return links.get(`${accountBudget}→${categoryBudget}`) ?? null;
}

// ---------------------------------------------------------------------------
// R6.l · Which pairs of budgets may owe each other anything
// ---------------------------------------------------------------------------

/**
 * A claim may arise only between budgets linked by something the household
 * deliberately shared.
 *
 * The household budget is shared by definition, so a claim to or from it is
 * always allowed. Between two **personal** budgets there has to be an actual
 * arrangement, and in practice there is exactly one: an add-on card, which is a
 * second card on somebody else's account (R6.a). Filing a charge across two
 * personal budgets with nothing between them would invent a debt through no
 * arrangement either person made, so it is refused.
 */
export function sharedInstrumentBetween(
  db: DB, accountId: string, accountBudget: string, categoryBudget: string,
): boolean {
  const household = householdBudgetId(db);
  if (accountBudget === household || categoryBudget === household) return true;

  /*
   * The add-on case. The account is the primary holder's; a card on it held by
   * the other budget's member is the arrangement that links them — and the
   * liability stays the primary's, which is why the payment envelope does not
   * move (15 §3A.5).
   */
  const other = getBudget(db, categoryBudget);
  if (!other?.member_id) return false;

  return (
    queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM cards
        WHERE account_id = ? AND holder_member_id = ? AND is_primary = 0`,
      accountId, other.member_id,
    )?.n ?? 0
  ) > 0;
}

/**
 * D5 / D9 · The same preparation for a transfer that touches another budget's
 * card.
 *
 * Paying somebody else's card buys a claim rather than spending money (see
 * crossCardPaymentSql in the engine), and the claim is carried by the envelope
 * between the two budgets. Filing already made sure that envelope existed;
 * transfers never did. So ₹200 from Ravi's bank to the household card, with no
 * envelope yet, left the household ₹200 up and Ravi ₹200 down in every month
 * after — and between two personal budgets, where nothing ever opened one, it
 * was always broken. A card-to-card balance transfer across budgets was the
 * same story from the other side.
 *
 * A leg on a tracking account is not this: the tracking side is outside every
 * budget, so the card leg is simply unfiled card flow and nobody owes anybody.
 */
export function prepareTransferClaim(
  db: DB, actor: Actor,
  from: { id: string; kind: string; budget_id: string | null; name: string },
  to: { id: string; kind: string; budget_id: string | null; name: string },
): void {
  if (from.kind !== "credit" && to.kind !== "credit") return;
  if (from.kind === "tracking" || to.kind === "tracking") return;
  if (!from.budget_id || !to.budget_id || from.budget_id === to.budget_id) return;

  /*
   * Which arrangement lets the two budgets owe each other: the household is
   * shared by definition, and between two personal budgets only an add-on card
   * links them — held by the other side's member on whichever card is involved.
   */
  const linked = [from, to].some((card) =>
    card.kind === "credit" &&
    sharedInstrumentBetween(
      db, card.id, card.budget_id!, card === from ? to.budget_id! : from.budget_id!,
    ),
  );
  if (!linked) {
    const payer = getBudget(db, from.budget_id)?.name ?? "that budget";
    const payee = getBudget(db, to.budget_id)?.name ?? "the other";
    throw new Refusal(
      `This would move ${payer}'s money onto ${payee}'s card (or the other way), and ` +
      `nothing links the two budgets — no shared account, and no add-on card. Pay it ` +
      `from an account in the same budget as the card, or through the household.`,
    );
  }

  if (claimFor(claimLinks(db), from.budget_id, to.budget_id)) return;

  // The personal side holds the envelope. Between two personal budgets it is
  // the one whose card is being paid, so the debt reads as theirs.
  const household = householdBudgetId(db);
  const holder = from.budget_id === household ? to.budget_id
    : to.budget_id === household ? from.budget_id
    : to.kind === "credit" ? to.budget_id : from.budget_id;
  const owed = holder === from.budget_id ? to.budget_id : from.budget_id;
  ensureCommitmentEnvelope(db, actor, holder, owed);
}

/**
 * Called before a filing is written: make sure the two budgets may owe each
 * other, and that the envelope which carries it exists.
 *
 * Creating it here rather than leaving it to the read is deliberate. The claim is
 * derived from the envelope, so a cross-budget transaction with no envelope to
 * absorb it would be money the identity cannot account for — and the read cannot
 * conjure one, because a read must not write.
 */
export function prepareClaim(
  db: DB, actor: Actor, accountId: string, accountBudget: string | null,
  categoryBudget: string | null,
): void {
  if (!accountBudget || !categoryBudget || accountBudget === categoryBudget) return;

  if (!sharedInstrumentBetween(db, accountId, accountBudget, categoryBudget)) {
    const from = getBudget(db, accountBudget)?.name ?? "that budget";
    const to = getBudget(db, categoryBudget)?.name ?? "the other";
    throw new Refusal(
      `This would put ${from}'s money against one of ${to}'s envelopes, and ` +
      `nothing links the two — no shared account, and no add-on card. File it ` +
      `to a household envelope, or to one of ${from}'s own.`,
    );
  }

  if (claimFor(claimLinks(db), accountBudget, categoryBudget)) return;

  // Whichever of the two is personal holds the envelope; where both are, it is
  // the one whose envelope is being spent, so the debt reads as theirs.
  const household = householdBudgetId(db);
  const holder = categoryBudget === household ? accountBudget : categoryBudget;
  const owed = holder === accountBudget ? categoryBudget : accountBudget;
  ensureCommitmentEnvelope(db, actor, holder, owed);
}
