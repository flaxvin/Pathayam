/**
 * 15 / H2.2 · Which events a member may read.
 *
 * The activity log narrates everything the household does, in words: *"Added the
 * account Zzyzx Private Account"*, *"Paid ₹4,321 to Vantablack Merchant"*, *"Set
 * a monthly target of ₹9,000 on Qwertyuiop Envelope"*. Every other surface had
 * been taught whose money it was showing and this one had not, so the screen
 * whose whole purpose is to say what happened said what happened in somebody
 * else's private budget — account names, payees, envelopes, amounts, dates, and
 * an undo button beside each one.
 *
 * An event is readable when the thing it is about is. Where an event is about
 * nothing in particular — a household setting, a member, a rule — it is the
 * household's business and everybody sees it.
 */

import type { DB } from "../db/db.ts";
import { queryOne, queryAll } from "../db/db.ts";
import type { LoggedEvent } from "../core/events.ts";
import { canSeeLoan } from "./loans.ts";
import { canSeeFamilyLoan } from "./family-loans.ts";
import { budgetsFor } from "./budgets.ts";
import { visiblePayeeIds } from "./transactions.ts";

/** Cached per call site: the sweep asks about a hundred events at a time. */
export interface EventVisibility {
  (event: LoggedEvent): boolean;
}

export function eventVisibility(db: DB, viewerMemberId: string | null): EventVisibility {
  const visibleBudgets = new Set(budgetsFor(db, viewerMemberId).map((b) => b.id));
  const accounts = new Map<string, boolean>();
  const categories = new Map<string, boolean>();
  let payeeIds: Set<string> | null = null;
  const payeesVisible = (): Set<string> => (payeeIds ??= visiblePayeeIds(db, viewerMemberId));

  const accountVisible = (id: string): boolean => {
    const cached = accounts.get(id);
    if (cached !== undefined) return cached;
    const row = queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM accounts
        WHERE id = ? AND (visibility <> 'private' OR holder_member_id IS ?)`,
      id, viewerMemberId,
    );
    const seen = (row?.n ?? 0) > 0;
    accounts.set(id, seen);
    return seen;
  };

  const categoryVisible = (id: string): boolean => {
    const cached = categories.get(id);
    if (cached !== undefined) return cached;
    const row = queryOne<{ budget_id: string | null }>(
      db, `SELECT budget_id FROM categories WHERE id = ?`, id,
    );
    // A category with no budget predates budgets and belonged to the household.
    const seen = !row || row.budget_id === null || visibleBudgets.has(row.budget_id);
    categories.set(id, seen);
    return seen;
  };

  return (event: LoggedEvent): boolean => {
    const id = event.entityId;
    if (!id) return true;

    switch (event.entity) {
      case "account":
        return accountVisible(id);
      case "category":
      case "goal":
        return categoryVisible(id);
      case "loan":
        return canSeeLoan(db, id, viewerMemberId);
      case "family-loan":
        return canSeeFamilyLoan(db, id, viewerMemberId);
      case "transaction": {
        /*
         * A deleted transaction's row is still there — the log is precisely
         * where a deletion is meant to be visible — so this reads the row
         * whatever state it is in, and only asks whose account it was on.
         */
        const row = queryOne<{ account_id: string; category_id: string | null }>(
          db, `SELECT account_id, category_id FROM transactions WHERE id = ?`, id,
        );
        if (!row) return true;
        if (!accountVisible(row.account_id)) return false;
        return row.category_id === null || categoryVisible(row.category_id);
      }
      case "assignment":
        // Its id is `month:categoryId`, because an assignment is a cell.
        return categoryVisible(id.slice(id.indexOf(":") + 1));
      case "target":
        /*
         * Both are about one envelope, and both name it: "Assigned ₹9,000 to
         * Qwertyuiop Envelope", "Set Xylophone Finance's target to ₹4,754 a
         * month" — the second being a loan's payment envelope, which carries the
         * lender's name and is set automatically whenever the loan changes.
         */
        return categoryVisible(id);
      case "transfer": {
        /*
         * A transfer names both ends — "Moved ₹5,000 from Zzyzx Private Account
         * to Lending — Pennyfarthing Cousin" — so both ends have to be visible,
         * and the entity id is the pair rather than either leg.
         */
        const legs = queryAll<{ account_id: string }>(
          db, `SELECT account_id FROM transactions WHERE transfer_pair_id = ?`, id,
        );
        return legs.every((leg) => accountVisible(leg.account_id));
      }
      case "payee": {
        /*
         * A payee only ever seen on a private account is not a household fact:
         * "Added the payee Vantablack Merchant" says where somebody spent.
         */
        return payeesVisible().has(id);
      }
      case "holding":
      case "asset": {
        const row = queryOne<{ account_id: string }>(
          db, `SELECT account_id FROM holdings WHERE id = ?`, id,
        );
        return row ? accountVisible(row.account_id) : true;
      }
      default:
        // A household setting, a member, a rule, an import batch, a month close:
        // the household's own business, and everybody's to read.
        return true;
    }
  };
}
