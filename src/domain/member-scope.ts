/**
 * 15 · Everything one member may not see, as sets of ids.
 *
 * Privacy in this app was taught one surface at a time: the account list, then
 * the envelope pickers, then the transaction routes, then the activity log. The
 * surfaces that were never taught kept the default, which was "everybody sees
 * everything" — so a sweep as the wrong member found the export carrying Ravi's
 * whole private budget off the machine, `/schedules/:id/delete` removing his
 * subscription, `/goals/:id/edit` renaming his goal and `/portfolio/:id/split`
 * doubling the units in his private demat. Every one of them was a surface that
 * had to know the rule and did not.
 *
 * This answers the question once, for every kind of private thing, from the one
 * rule underneath all of them: an account is private to its holder, and a budget
 * to its member. Everything else is private because of what it hangs off — a
 * transaction because of its account or its envelope, a schedule because of the
 * account it posts into, a goal because of its budget, a holding because of its
 * demat. A new kind of thing added later is private the same way, and belongs
 * here, so the export, the activity log and the id-addressed routes all learn it
 * at once.
 *
 * Sets rather than per-id queries: the activity log and the export ask about
 * hundreds of rows, and a household has a few thousand ids at most.
 */

import type { DB } from "../db/db.ts";
import { queryAll } from "../db/db.ts";

export interface MemberScope {
  viewerMemberId: string | null;
  budgets: Set<string>;
  accounts: Set<string>;
  groups: Set<string>;
  categories: Set<string>;
  /** Transaction ids, and the pair ids of transfers with a hidden leg. */
  transactions: Set<string>;
  cards: Set<string>;
  schedules: Set<string>;
  goals: Set<string>;
  holdings: Set<string>;
  lots: Set<string>;
  /** An instrument held somewhere, and only ever somewhere the viewer cannot see. */
  instruments: Set<string>;
  loans: Set<string>;
  familyLoans: Set<string>;
  /** True when `id` names anything above. */
  hides(id: string | null | undefined): boolean;
  /** True when any string anywhere inside `value` names anything above. */
  mentionsHidden(value: unknown): boolean;
}

/** Every personal budget but the viewer's own. Binds the viewer once. */
const HIDDEN_BUDGETS = `(SELECT id FROM budgets WHERE kind <> 'household' AND member_id IS NOT ?)`;
/** Every account held privately by somebody else. Binds the viewer once. */
const HIDDEN_ACCOUNTS =
  `(SELECT id FROM accounts WHERE NOT (visibility = 'household' OR holder_member_id IS ?))`;
/** Envelopes of those budgets, and card payment envelopes of those accounts. Binds it three times. */
const HIDDEN_CATEGORIES =
  `(SELECT c.id FROM categories c
     WHERE c.budget_id IN ${HIDDEN_BUDGETS}
        OR c.group_id IN (SELECT id FROM category_groups WHERE budget_id IN ${HIDDEN_BUDGETS})
        OR c.payment_account_id IN ${HIDDEN_ACCOUNTS})`;

/**
 * The transaction half of `memberScope`, as SQL a list can filter on.
 *
 * The sets suit a guard asking about one id; a register or a query of five
 * hundred rows wants the rule inside its WHERE, so its LIMIT counts what the
 * reader can see. The account list and Query applied the account half of the
 * rule and not the envelope half: a household-visible account in Ravi's own
 * budget listed its spending to Priya with his private envelope's name on
 * every row, and each row linked to a transaction page that answered 404.
 *
 * True when `t` (a `transactions` alias) is one the viewer may not see.
 */
export function hiddenTransactionSql(
  t: string, viewerMemberId: string | null,
): { sql: string; params: (string | null)[] } {
  return {
    sql: `(${t}.account_id IN ${HIDDEN_ACCOUNTS}
           OR ${t}.category_id IN ${HIDDEN_CATEGORIES}
           OR EXISTS (SELECT 1 FROM transaction_splits hs
                       WHERE hs.transaction_id = ${t}.id AND hs.category_id IN ${HIDDEN_CATEGORIES}))`,
    params: Array<string | null>(7).fill(viewerMemberId),
  };
}

/** True when account `a` (an `accounts` alias) is one the viewer may not see. */
export function hiddenAccountSql(
  a: string, viewerMemberId: string | null,
): { sql: string; params: (string | null)[] } {
  return { sql: `(${a}.id IN ${HIDDEN_ACCOUNTS})`, params: [viewerMemberId] };
}

const ids = (db: DB, sql: string, ...params: (string | null)[]): Set<string> =>
  new Set(queryAll<{ id: string }>(db, sql, ...params).map((r) => r.id));

/**
 * What `viewerMemberId` may not see. Null is nobody in particular, which sees
 * the household's own things and nothing that belongs to a member.
 */
export function memberScope(db: DB, viewerMemberId: string | null): MemberScope {
  const v = viewerMemberId;
  // The two roots. Everything below hangs off one or the other.
  const budgets = ids(db, `SELECT id FROM ${HIDDEN_BUDGETS}`, v);
  const accounts = ids(db, `SELECT id FROM ${HIDDEN_ACCOUNTS}`, v);

  const groups = ids(db, `SELECT id FROM category_groups WHERE budget_id IN ${HIDDEN_BUDGETS}`, v);
  const categories = ids(db, `SELECT id FROM ${HIDDEN_CATEGORIES}`, v, v, v);
  const hiddenCategory = [...categories];
  const inCategories = hiddenCategory.length
    ? `IN (${hiddenCategory.map(() => "?").join(",")})` : "IN (NULL)";

  const transactions = ids(db,
    `SELECT t.id FROM transactions t
      WHERE t.account_id IN ${HIDDEN_ACCOUNTS}
         OR t.category_id ${inCategories}
         OR EXISTS (SELECT 1 FROM transaction_splits s
                     WHERE s.transaction_id = t.id AND s.category_id ${inCategories})`,
    v, ...hiddenCategory, ...hiddenCategory);
  // A transfer is addressed by its pair id, and names both ends.
  for (const r of queryAll<{ id: string }>(db,
    `SELECT DISTINCT transfer_pair_id AS id FROM transactions
      WHERE transfer_pair_id IS NOT NULL AND account_id IN ${HIDDEN_ACCOUNTS}`, v)) {
    transactions.add(r.id);
  }

  const cards = ids(db, `SELECT id FROM cards WHERE account_id IN ${HIDDEN_ACCOUNTS}`, v);
  const schedules = ids(db,
    `SELECT s.id FROM schedules s
      WHERE s.account_id IN ${HIDDEN_ACCOUNTS}
         OR s.category_id ${inCategories}
         OR EXISTS (SELECT 1 FROM schedule_splits x
                     WHERE x.schedule_id = s.id AND x.category_id ${inCategories})`,
    v, ...hiddenCategory, ...hiddenCategory);
  const goals = ids(db,
    `SELECT g.id FROM goals g
      WHERE g.budget_id IN ${HIDDEN_BUDGETS}
         OR EXISTS (SELECT 1 FROM goal_categories gc
                     WHERE gc.goal_id = g.id AND gc.category_id ${inCategories})`,
    v, ...hiddenCategory);
  const holdings = ids(db, `SELECT id FROM holdings WHERE account_id IN ${HIDDEN_ACCOUNTS}`, v);
  const lots = ids(db,
    `SELECT l.id FROM lots l JOIN holdings h ON h.id = l.holding_id
      WHERE h.account_id IN ${HIDDEN_ACCOUNTS}`, v);
  const instruments = ids(db,
    `SELECT i.id FROM instruments i
      WHERE EXISTS (SELECT 1 FROM holdings h WHERE h.instrument_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM holdings h WHERE h.instrument_id = i.id
                         AND h.account_id NOT IN ${HIDDEN_ACCOUNTS})`, v);
  const loans = ids(db, `SELECT id FROM loans WHERE account_id IN ${HIDDEN_ACCOUNTS}`, v);
  const familyLoans = ids(db,
    `SELECT id FROM family_loans WHERE account_id IN ${HIDDEN_ACCOUNTS}`, v);

  const all = [budgets, accounts, groups, categories, transactions, cards, schedules,
    goals, holdings, lots, instruments, loans, familyLoans];
  const hides = (id: string | null | undefined): boolean =>
    typeof id === "string" && all.some((set) => set.has(id));
  const mentionsHidden = (value: unknown): boolean => {
    if (typeof value === "string") return hides(value);
    if (ArrayBuffer.isView(value)) return false; // an attachment's bytes
    if (Array.isArray(value)) return value.some(mentionsHidden);
    if (value && typeof value === "object") return Object.values(value).some(mentionsHidden);
    return false;
  };

  return {
    viewerMemberId, budgets, accounts, groups, categories, transactions, cards,
    schedules, goals, holdings, lots, instruments, loans, familyLoans, hides, mentionsHidden,
  };
}
